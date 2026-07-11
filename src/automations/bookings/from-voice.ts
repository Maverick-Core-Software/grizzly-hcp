/**
 * Voice pipeline — spawned by voice-server.ts with JSON on stdin:
 *   { kind: "booking" | "message" | "reschedule", payload: {...}, callerPhone, callSid }
 *
 * booking    → HCP: find/create customer → create estimate shell → booking-request note
 *              → assign Carter + Jaime (notify_pro push) → append data/pending-bookings.jsonl
 *              (the approval-poller then watches that estimate's notes for a SCHEDULE reply)
 * message    → same customer/estimate/note/assign chain, but marked delivered immediately.
 * reschedule → same chain; the note carries the HCP job id + new preferred windows.
 *              status "reschedule_pending" so the approval-poller (which only acts on
 *              status "pending") ignores it — the office moves the job in HCP manually.
 *
 * Writes go through gateway.ts (direct client or MCP daemon per HCP_VIA_MCP), matching
 * the from-chat.ts estimate pipeline. updateEstimateNotes is direct-client only.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { searchCustomer, createCustomer, assignTechnician, createEstimate } from '../../hcp/gateway.js';
import { updateEstimateNotes } from '../../hcp/estimates.js';

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
const email = (p.email ?? '').trim() || `voicemail+${digits}@grizzlyelectrical.net`;

const proUuids = [process.env.CARTER_PRO_UUID, process.env.JAIME_PRO_UUID].filter(
  (u): u is string => Boolean(u)
);

function buildNote(kind: PipelineInput['kind'], now: string): string {
  if (kind === 'booking') {
    return [
      '📞 MAVERICK BOOKING REQUEST — from phone call',
      `Received: ${now} (Central)`,
      `Caller: ${name}`,
      `Callback: ${phone || 'unknown'}`,
      `Address: ${p.address ?? 'not given'}`,
      `Issue: ${p.issue ?? 'not given'}`,
      `Preferred times: ${(p.preferredWindows ?? []).join('  |  ') || 'not given'}`,
      '',
      'TO APPROVE: add a note to this estimate starting with SCHEDULE, e.g.',
      'SCHEDULE 07/14 2:00 pm - 4:00 pm',
      'Maverick will book it and HCP will notify the customer.',
    ].join('\n');
  }
  if (kind === 'reschedule') {
    return [
      '📞 MAVERICK RESCHEDULE REQUEST — from phone call',
      `Received: ${now} (Central)`,
      `Caller: ${name}`,
      `Callback: ${phone || 'unknown'}`,
      `HCP job: ${p.jobId || 'unknown'}`,
      `Currently scheduled: ${p.currentTime || 'unknown'}`,
      `New preferred times: ${(p.preferredWindows ?? []).join('  |  ') || 'not given'}`,
      '',
      'TO HANDLE: move the job in HCP to one of the preferred times — HCP will',
      'notify the customer. This estimate shell exists only to carry this note.',
    ].join('\n');
  }
  return [
    '📞 MAVERICK PHONE MESSAGE',
    `Received: ${now} (Central)`,
    `Caller: ${name}`,
    `Callback: ${phone || 'unknown'}`,
    '',
    `Message: ${p.message ?? ''}`,
  ].join('\n');
}

const STATUS_BY_KIND: Record<PipelineInput['kind'], string> = {
  booking: 'pending',
  message: 'message_delivered',
  reschedule: 'reschedule_pending',
};

try {
  // 1. Find or create the customer.
  let customer = await searchCustomer(name);
  if (!customer) {
    customer = await createCustomer({ name, email, phone });
    console.log(`[from-voice] Created customer ${customer.id}`);
  } else {
    console.log(`[from-voice] Matched existing customer ${customer.id}`);
  }

  // 2. Create the estimate/request shell (this is HCP's job record).
  const estimate = await createEstimate(customer.id, customer.addressId ?? '');
  console.log(`[from-voice] Created estimate ${estimate.uuid} (#${estimate.estimateId})`);

  // 3. Post the note Carter + Jaime read in the HCP app.
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
  await updateEstimateNotes(estimate.uuid, buildNote(input.kind, now));

  // 4. Assign Carter + Jaime → notify_pro:true fires their HCP push notification.
  if (proUuids.length > 0) {
    await assignTechnician(estimate.uuid, proUuids);
    console.log(`[from-voice] Assigned ${proUuids.length} pros (push notification sent)`);
  } else {
    console.error('[from-voice] WARNING: no CARTER_PRO_UUID/JAIME_PRO_UUID set — nobody was notified');
  }

  // 5. Track for the approval poller (booking) / the record (message, reschedule).
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
