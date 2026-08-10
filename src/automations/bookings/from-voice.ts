/**
 * Voice pipeline — spawned by voice-server.ts with JSON on stdin:
 *   { kind: "booking" | "message" | "reschedule", payload: {...}, callerPhone, callSid }
 *
 * booking    → geocode address → find/create customer → write address on customer
 *              → create estimate against that address → booking-request note
 *              → assign Carter + Jaime (notify_pro push) → append data/pending-bookings.jsonl
 *              (the approval-poller then watches that estimate's notes for a SCHEDULE reply)
 * message    → same customer/estimate/note/assign chain, but marked delivered immediately.
 * reschedule → same chain as booking; the note carries the HCP job id + new preferred windows.
 *              status "reschedule_pending" so the approval-poller (which only acts on
 *              status "pending") ignores it — the office moves the job in HCP manually.
 *
 * Writes go through gateway.ts (direct client or MCP daemon per HCP_VIA_MCP), matching
 * the from-chat.ts estimate pipeline. updateEstimateNotes routes MCP-first with a
 * direct-client fallback until the daemon ships the tool (see gateway.ts).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { searchCustomer, createCustomer, assignTechnician, createEstimate, addCustomerAddress, updateEstimateNotes } from '../../hcp/gateway.js';
import { resolveNumericCustomerId, findCustomerAddress } from '../../hcp/estimates.js';
import { resolveAddress } from '../../hcp/geocode.js';
import type { ResolvedAddress } from '../../hcp/geocode.js';

interface BookingPayload {
  customerName?: string;
  callbackPhone?: string;
  address?: string;
  email?: string;
  issue?: string;
  preferredWindows?: string[];
  // message kind:
  callerName?: string;
  message?: string;
  // reschedule kind:
  jobId?: string;
  currentTime?: string;
}

interface PipelineInput {
  kind: 'booking' | 'message' | 'reschedule';
  payload: BookingPayload;
  callerPhone?: string;
  callSid?: string;
}

const PENDING_FILE = path.resolve(process.cwd(), 'data/pending-bookings.jsonl');

function appendPending(record: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  fs.appendFileSync(PENDING_FILE, JSON.stringify(record) + '\n');
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const input = JSON.parse(await readStdin()) as PipelineInput;
const p = input.payload ?? {};
const name = (p.customerName ?? p.callerName ?? 'Unknown Caller').trim();
const phone = (p.callbackPhone ?? input.callerPhone ?? '').trim();
const digits = phone.replace(/\D/g, '') || 'unknown';
const callerEmail = (p.email ?? '').trim();
const email = callerEmail || `no-email+${digits}@grizzlyelectrical.net`;

const proUuids = [process.env.CARTER_PRO_UUID, process.env.JAIME_PRO_UUID].filter(
  (u): u is string => Boolean(u)
);

function buildNote(
  kind: PipelineInput['kind'],
  now: string,
  opts?: {
    resolvedAddress?: ResolvedAddress | null;
    rawAddress?: string;
    existingCustomer?: boolean;
    callerEmail?: string;
  }
): string {
  // message kind — unchanged, no address or email lines
  if (kind === 'message') {
    return [
      '📞 MAVERICK PHONE MESSAGE',
      `Received: ${now} (Central)`,
      `Caller: ${name}`,
      `Callback: ${phone || 'unknown'}`,
      '',
      `Message: ${p.message ?? ''}`,
    ].join('\n');
  }

  const lines: string[] = [];
  if (opts?.existingCustomer) lines.push('⚠️ Matched EXISTING CUSTOMER — reconcile contact details by hand.');
  if (opts?.resolvedAddress === null && opts?.rawAddress) {
    lines.push(`ADDRESS COULD NOT BE VERIFIED: "${opts.rawAddress}"`);
  }

  const addressLine = opts?.resolvedAddress
    ? `${opts.resolvedAddress.street}, ${opts.resolvedAddress.city}, ${opts.resolvedAddress.state} ${opts.resolvedAddress.zip}`
    : (opts?.rawAddress ?? 'not given');
  const emailLine = opts?.callerEmail ? `Email: ${opts.callerEmail}` : 'Email: NOT PROVIDED';

  if (kind === 'booking') {
    lines.push(
      '📞 MAVERICK BOOKING REQUEST — from phone call',
      `Received: ${now} (Central)`,
      `Caller: ${name}`,
      `Callback: ${phone || 'unknown'}`,
      `Address: ${addressLine}`,
      emailLine,
      `Issue: ${p.issue ?? 'not given'}`,
      `Preferred times: ${(p.preferredWindows ?? []).join('  |  ') || 'not given'}`,
      '',
      'TO APPROVE: add a note to this estimate starting with SCHEDULE, e.g.',
      'SCHEDULE 07/14 2:00 pm - 4:00 pm',
      'Maverick will book it and HCP will notify the customer.',
    );
  } else {
    lines.push(
      '📞 MAVERICK RESCHEDULE REQUEST — from phone call',
      `Received: ${now} (Central)`,
      `Caller: ${name}`,
      `Callback: ${phone || 'unknown'}`,
      `Address: ${addressLine}`,
      emailLine,
      `HCP job: ${p.jobId || 'unknown'}`,
      `Currently scheduled: ${p.currentTime || 'unknown'}`,
      `New preferred times: ${(p.preferredWindows ?? []).join('  |  ') || 'not given'}`,
      '',
      'TO HANDLE: move the job in HCP to one of the preferred times — HCP will',
      'notify the customer. This estimate shell exists only to carry this note.',
    );
  }

  return lines.join('\n');
}

const STATUS_BY_KIND: Record<PipelineInput['kind'], string> = {
  booking: 'pending',
  message: 'message_delivered',
  reschedule: 'reschedule_pending',
};

try {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });

  // ── message kind — unchanged behaviour (no address collection) ──
  if (input.kind === 'message') {
    let customer = await searchCustomer(name);
    if (!customer) {
      customer = await createCustomer({ name, email, phone });
      console.log(`[from-voice] Created customer ${customer.id}`);
    } else {
      console.log(`[from-voice] Matched existing customer ${customer.id}`);
    }

    const estimate = await createEstimate(customer.id, customer.addressId ?? '');
    console.log(`[from-voice] Created estimate ${estimate.uuid} (#${estimate.estimateId})`);

    await updateEstimateNotes(estimate.uuid, buildNote(input.kind, now));

    if (proUuids.length > 0) {
      await assignTechnician(estimate.uuid, proUuids);
      console.log(`[from-voice] Assigned ${proUuids.length} pros (push notification sent)`);
    } else {
      console.error('[from-voice] WARNING: no CARTER_PRO_UUID/JAIME_PRO_UUID set — nobody was notified');
    }

    appendPending({
      estimateUuid: estimate.uuid,
      estimateId: estimate.estimateId,
      kind: input.kind,
      customerName: name,
      callbackPhone: phone,
      address: p.address ?? '',
      issue: p.issue ?? p.message ?? '',
      jobId: p.jobId ?? '',
      currentTime: p.currentTime ?? '',
      preferredWindows: p.preferredWindows ?? [],
      status: STATUS_BY_KIND[input.kind] ?? 'pending',
      createdAt: new Date().toISOString(),
      callSid: input.callSid ?? '',
    });

    console.log(JSON.stringify({ success: true, estimateUuid: estimate.uuid, estimateId: estimate.estimateId }));
    process.exit(0);
  }

  // ── booking / reschedule — new flow ──

  // 1. Geocode the spoken address (network call, may return null)
  let resolvedAddress: ResolvedAddress | null = null;
  if (p.address) {
    resolvedAddress = await resolveAddress(p.address);
  }

  // 2. Find or create the customer
  let customer = await searchCustomer(name);
  let existingCustomer = false;
  if (!customer) {
    customer = await createCustomer({ name, email, phone });
    console.log(`[from-voice] Created customer ${customer.id}`);
  } else {
    existingCustomer = true;
    console.log(`[from-voice] Matched existing customer ${customer.id}`);
  }

  // 3. Resolve the address on the customer: reuse the matching one if they already have it
  //    (repeat callers must not accumulate duplicate address records), otherwise add it.
  //    Falls back to the old addressId on geocode failure.
  let addressId: string;
  if (resolvedAddress) {
    const existingId = await findCustomerAddress(customer.id, {
      street: resolvedAddress.street,
      zip: resolvedAddress.zip,
    });
    if (existingId) {
      addressId = existingId;
      console.log(`[from-voice] Reused existing service address ${addressId}`);
    } else {
      const numericId = await resolveNumericCustomerId(customer.id);
      addressId = await addCustomerAddress(numericId, {
        street: resolvedAddress.street,
        city: resolvedAddress.city,
        state: resolvedAddress.state,
        zip: resolvedAddress.zip,
        latitude: resolvedAddress.latitude,
        longitude: resolvedAddress.longitude,
      });
      console.log(`[from-voice] Added new service address ${addressId}`);
    }
  } else {
    addressId = customer.addressId ?? '';
    console.log(`[from-voice] Geocode failed — using fallback addressId "${addressId}"`);
  }

  // 4. Create the estimate against the address id (resolved or fallback)
  const estimate = await createEstimate(customer.id, addressId);
  console.log(`[from-voice] Created estimate ${estimate.uuid} (#${estimate.estimateId})`);

  // 5. Post the note with address/email/callback on their own lines
  await updateEstimateNotes(estimate.uuid, buildNote(input.kind, now, {
    resolvedAddress,
    rawAddress: p.address,
    existingCustomer,
    callerEmail: callerEmail || undefined,
  }));

  // 6. Assign Carter + Jaime → notify_pro:true fires their HCP push notification
  if (proUuids.length > 0) {
    await assignTechnician(estimate.uuid, proUuids);
    console.log(`[from-voice] Assigned ${proUuids.length} pros (push notification sent)`);
  } else {
    console.error('[from-voice] WARNING: no CARTER_PRO_UUID/JAIME_PRO_UUID set — nobody was notified');
  }

  // 7. Track for the approval poller (booking) or the record (reschedule).
  //    Status depends on whether the address resolved; needs_address_review is
  //    ignored by the approval poller (it only acts on "pending").
  const status = resolvedAddress
    ? (input.kind === 'reschedule' ? 'reschedule_pending' : 'pending')
    : 'needs_address_review';

  const pendingAddress = resolvedAddress
    ? `${resolvedAddress.street}, ${resolvedAddress.city}, ${resolvedAddress.state} ${resolvedAddress.zip}`
    : (p.address ?? '');

  appendPending({
    estimateUuid: estimate.uuid,
    estimateId: estimate.estimateId,
    kind: input.kind,
    customerName: name,
    callbackPhone: phone,
    address: pendingAddress,
    issue: p.issue ?? p.message ?? '',
    jobId: p.jobId ?? '',
    currentTime: p.currentTime ?? '',
    preferredWindows: p.preferredWindows ?? [],
    status,
    createdAt: new Date().toISOString(),
    callSid: input.callSid ?? '',
  });

  console.log(JSON.stringify({ success: true, estimateUuid: estimate.uuid, estimateId: estimate.estimateId }));
  process.exit(0);
} catch (e) {
  // Never lose a caller: persist the failure so it can be handled manually.
  appendPending({
    kind: input.kind,
    customerName: name,
    callbackPhone: phone,
    address: p.address ?? '',
    issue: p.issue ?? p.message ?? '',
    jobId: p.jobId ?? '',
    currentTime: p.currentTime ?? '',
    preferredWindows: p.preferredWindows ?? [],
    status: 'failed_needs_manual',
    error: e instanceof Error ? e.message : String(e),
    createdAt: new Date().toISOString(),
    callSid: input.callSid ?? '',
  });
  console.error(`[from-voice] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
