/**
 * Caller-scoped appointment/estimate lookup for the voice channel.
 *
 * Privacy is enforced HERE, in code — the tool only returns records for the
 * customer whose identity was verified (caller-ID phone + name match, or
 * name + service address match). The voice persona never gets a tool that
 * can list other customers' data.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { hcpGet } from '../../../hcp/client.js';

/** Last 10 digits of a US phone number ("+1 (469) 863-9804" → "4698639804"). */
export function phoneDigits(s: string | undefined | null): string {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

export function normalize(s: string | undefined | null): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True when the stated name plausibly matches the record. Last name is the anchor. */
export function nameMatches(stated: string, recordName: string): boolean {
  const statedTokens = normalize(stated).split(' ').filter(Boolean);
  const recordTokens = new Set(normalize(recordName).split(' ').filter(Boolean));
  if (!statedTokens.length || !recordTokens.size) return false;
  return recordTokens.has(statedTokens[statedTokens.length - 1]);
}

/** True when the stated address matches the record: house number + a street word. */
export function addressMatches(stated: string, recordStreet: string): boolean {
  const s = normalize(stated).split(' ').filter(Boolean);
  const r = new Set(normalize(recordStreet).split(' ').filter(Boolean));
  if (s.length < 2 || !r.size) return false;
  const houseNumber = s.find((t) => /^\d+$/.test(t));
  const streetWord = s.find((t) => /^[a-z]/.test(t) && t.length > 2);
  return Boolean(houseNumber && r.has(houseNumber) && streetWord && r.has(streetWord));
}

/** Dig a display value out of an unknown-shaped HCP record (top level, then one level deep). */
export function pluck(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = v as Record<string, unknown>;
      for (const key of keys) {
        const nv = nested[key];
        if (typeof nv === 'string' && nv) return nv;
      }
    }
  }
  return '';
}

interface HcpCustomerHit {
  id: string;
  display_name: string;
  addresses?: { data?: Array<{ id: string; street: string }> };
}

// Same /alpha/customers search the estimate pipeline uses (see src/hcp/estimates.ts).
// The q param matches names AND phone numbers server-side.
async function searchCustomers(q: string): Promise<HcpCustomerHit[]> {
  const params = new URLSearchParams({
    q,
    page: '1',
    page_size: '10',
    contractor: 'false',
    has_email: 'false',
    sort_by: 'display_name',
    sort_direction: 'asc',
    for_franchise: 'false',
  });
  params.append('expand[]', 'addresses');
  const res = await hcpGet<{ data?: HcpCustomerHit[] }>(`/alpha/customers?${params}`);
  return res.data ?? [];
}

export interface VoiceLookupInput {
  callerPhone?: string;
  name: string;
  address?: string;
}

/** Core logic, exported so scripts/probe-voice-lookup.ts can call it directly. */
export async function lookupMyAppointments(input: VoiceLookupInput) {
  const { callerPhone, name, address } = input;
  try {
    let customer: HcpCustomerHit | null = null;
    let verifiedBy = '';

    const digits = phoneDigits(callerPhone);
    if (digits.length === 10) {
      const hits = await searchCustomers(digits);
      customer = hits.find((h) => nameMatches(name, h.display_name)) ?? null;
      if (customer) verifiedBy = 'phone+name';
    }

    if (!customer) {
      if (!address) {
        return {
          verified: false,
          reason: 'Caller ID did not match a customer record. Ask for their full name AND service address, then call again with both.',
        };
      }
      const hits = await searchCustomers(name);
      customer =
        hits.find(
          (h) =>
            nameMatches(name, h.display_name) &&
            (h.addresses?.data ?? []).some((a) => addressMatches(address, a.street))
        ) ?? null;
      verifiedBy = 'name+address';
    }

    if (!customer) {
      return { verified: false, reason: 'No customer record matched. Offer to take a message instead.' };
    }

    // Upcoming jobs: pull the schedule, keep ONLY this customer's jobs.
    // ponytail: schema-agnostic containment filter on the customer id — replace with
    // a field-level filter once the scheduled-jobs payload shape is pinned down.
    const sched = await hcpGet<{ jobs?: unknown[] }>('/pro/jobs/scheduled?days_ahead=30&limit=100');
    const custId = customer.id;
    const appointments = (sched.jobs ?? [])
      .filter((j) => JSON.stringify(j).includes(custId))
      .slice(0, 5)
      .map((j) => ({
        jobId: pluck(j, ['uuid', 'id']),
        scheduledFor: pluck(j, ['scheduled_start', 'start_time', 'scheduled_start_time', 'start']),
        description: pluck(j, ['description', 'name', 'work_status']),
        address: pluck(j, ['street', 'address', 'display_address']),
      }));

    const est = await hcpGet<{ estimates?: unknown[] }>(
      `/pro/estimates?customer_id=${encodeURIComponent(custId)}&limit=10`
    );
    const estimates = (est.estimates ?? []).slice(0, 5).map((e) => ({
      estimateId: pluck(e, ['uuid', 'id', 'estimate_number']),
      status: pluck(e, ['work_status', 'status', 'state']),
      description: pluck(e, ['description', 'name']),
    }));

    return { verified: true, verifiedBy, customerName: customer.display_name, appointments, estimates };
  } catch (e) {
    return { verified: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const lookupMyAppointmentsTool = createTool({
  id: 'lookup_my_appointments',
  description:
    "Look up the CALLER'S OWN upcoming appointments and open estimates, live from Housecall Pro. Identity check is built in: pass the caller-ID phone plus the name the caller gave. If that does not verify, ask for their full name and service address and call again with both. Never returns other customers' records.",
  inputSchema: z.object({
    callerPhone: z.string().optional().describe('Caller phone number from caller ID'),
    name: z.string().describe('Full name the caller gave'),
    address: z.string().optional().describe('Service address the caller gave (needed when caller ID does not verify)'),
  }),
  execute: async ({ callerPhone, name, address }) => lookupMyAppointments({ callerPhone, name, address }),
});

export const voiceLookupTools = {
  lookup_my_appointments: lookupMyAppointmentsTool,
};
