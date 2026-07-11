# PLAN — Maverick Full-Time Voice Line Upgrade

**Spec:** `docs/superpowers/specs/2026-07-11-maverick-voice-fulltime-design.md`
**Branch:** `feature/voice-fulltime` (created in Task 1)
**Executor:** Qwen local model. Follow tasks strictly in order. Copy code blocks verbatim.
**Sessions:** Session 1 = Tasks 1–3 · Session 2 = Tasks 4–5 · Session 3 = Tasks 6–7

---

## Codebase Primer (read fully before Task 1)

- **Runtime:** Node ESM + TypeScript executed directly with `tsx` (no build step). All relative imports use the `.js` suffix even for `.ts` files (e.g. `import { hcpGet } from '../../../hcp/client.js'`). Keep that convention.
- **Tests:** no framework. The repo convention is `<module>.check.ts` files using `node:assert/strict`, run with `npx tsx path/to/file.check.ts`.
- **Voice stack:** `src/agent/voice-server.ts` is a plain `node:http` + `ws` server implementing Twilio ConversationRelay. Twilio does STT/TTS; the server exchanges text over a WebSocket. The LLM persona (in `src/agent/resolver.ts`, const `VOICE_INSTRUCTIONS`) emits inline blocks like `[TRANSFER]{json}[/TRANSFER]` which the server parses and acts on. Tools available to the voice persona are allow-listed in `VOICE_INCLUDED` in `resolver.ts`.
- **Pipelines:** the server spawns `src/automations/bookings/from-voice.ts` as a subprocess with JSON on stdin. It creates an HCP customer + estimate shell + note, and assigns Carter + Jaime (which fires their HCP push notification).
- **HCP access:** `src/hcp/client.ts` exports `hcpGet` / `hcpPost` etc. using a saved cookie session (`npm run login`). GETs need no CSRF.
- **A LIVE voice server runs under PM2 on port 8765. NEVER start, stop, or restart PM2 or anything on port 8765.** All test runs in this plan use port **8790**.
- **`.env` exists** at repo root with `CARTER_PHONE`, `JAIME_PHONE`, etc. Never print or commit its contents.
- `ponytail:` comments mark intentional simplifications — keep them where the plan includes them.

Files this plan creates or replaces:

| File | Action |
|------|--------|
| `src/agent/office-hours.ts` | NEW |
| `src/agent/office-hours.check.ts` | NEW |
| `src/agent/tools/reads/voice-lookup.ts` | NEW |
| `src/agent/tools/reads/voice-lookup.check.ts` | NEW |
| `scripts/probe-voice-lookup.ts` | NEW |
| `src/agent/index.ts` | EDIT (2 small edits) |
| `src/agent/resolver.ts` | EDIT (allow-list + replace `VOICE_INSTRUCTIONS`) |
| `src/automations/bookings/from-voice.ts` | FULL FILE REPLACEMENT |
| `src/agent/voice-server.ts` | FULL FILE REPLACEMENT |

---

# SESSION 1 — Foundations (Tasks 1–3)

## Task 1 — Branch + office-hours helper

**Step 1.1** — From the repo root (`C:/Workspace/Active/grizzly-hcp`), create the branch:

```bash
git checkout -b feature/voice-fulltime
```

Expected output: `Switched to a new branch 'feature/voice-fulltime'`

**Step 1.2** — Create `src/agent/office-hours.ts` with exactly this content:

```ts
/**
 * Office hours for the Maverick voice line — America/Chicago.
 * Mon–Fri 08:00–18:00, Sat 08:00–14:00, Sun closed (matches the website schema).
 * ponytail: hours are constants here — edit this file to change them.
 */
export function officeStatus(now: Date = new Date()): 'OPEN' | 'CLOSED' {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday');
  const hour = Number(get('hour')) % 24; // some engines report midnight as "24"
  const minutes = hour * 60 + Number(get('minute'));
  if (day === 'Sun') return 'CLOSED';
  if (day === 'Sat') return minutes >= 8 * 60 && minutes < 14 * 60 ? 'OPEN' : 'CLOSED';
  return minutes >= 8 * 60 && minutes < 18 * 60 ? 'OPEN' : 'CLOSED';
}
```

**Step 1.3** — Create `src/agent/office-hours.check.ts` with exactly this content:

```ts
/**
 * Self-check for office hours. No test framework — run with:
 *   npx tsx src/agent/office-hours.check.ts
 * Fixture dates are UTC instants chosen to land on known Central-time moments.
 * July = CDT (UTC-5), January = CST (UTC-6).
 */
import assert from 'node:assert/strict';
import { officeStatus } from './office-hours.js';

// Monday 2026-07-13 (CDT)
assert.equal(officeStatus(new Date('2026-07-13T13:00:00Z')), 'OPEN', 'Mon 08:00 open boundary');
assert.equal(officeStatus(new Date('2026-07-13T12:59:00Z')), 'CLOSED', 'Mon 07:59 closed');
assert.equal(officeStatus(new Date('2026-07-13T22:59:00Z')), 'OPEN', 'Mon 17:59 open');
assert.equal(officeStatus(new Date('2026-07-13T23:00:00Z')), 'CLOSED', 'Mon 18:00 closed boundary');

// Saturday 2026-07-18 (CDT): 08:00–14:00
assert.equal(officeStatus(new Date('2026-07-18T14:00:00Z')), 'OPEN', 'Sat 09:00 open');
assert.equal(officeStatus(new Date('2026-07-18T18:59:00Z')), 'OPEN', 'Sat 13:59 open');
assert.equal(officeStatus(new Date('2026-07-18T19:00:00Z')), 'CLOSED', 'Sat 14:00 closed boundary');

// Sunday 2026-07-19 (CDT): always closed
assert.equal(officeStatus(new Date('2026-07-19T16:00:00Z')), 'CLOSED', 'Sun midday closed');

// Winter (CST, UTC-6): Monday 2026-01-12
assert.equal(officeStatus(new Date('2026-01-12T14:00:00Z')), 'OPEN', 'Mon 08:00 CST open');
assert.equal(officeStatus(new Date('2026-01-12T13:59:00Z')), 'CLOSED', 'Mon 07:59 CST closed');

console.log('office-hours.check OK');
```

**Step 1.4** — Verify:

```bash
npx tsx src/agent/office-hours.check.ts
```

Expected output: `office-hours.check OK`

**Step 1.5** — Commit:

```bash
git add src/agent/office-hours.ts src/agent/office-hours.check.ts
git commit -m "feat(voice): office-hours helper (America/Chicago)"
```

---

## Task 2 — Caller-scoped lookup tool

**Step 2.1** — Create `src/agent/tools/reads/voice-lookup.ts` with exactly this content:

```ts
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
```

**Step 2.2** — Create `src/agent/tools/reads/voice-lookup.check.ts` with exactly this content:

```ts
/**
 * Self-check for the offline helpers of the caller-scoped voice lookup.
 * (Network paths are exercised by scripts/probe-voice-lookup.ts against live HCP.)
 * Run with: npx tsx src/agent/tools/reads/voice-lookup.check.ts
 */
import assert from 'node:assert/strict';
import { phoneDigits, normalize, nameMatches, addressMatches, pluck } from './voice-lookup.js';

// phoneDigits
assert.equal(phoneDigits('+1 (469) 863-9804'), '4698639804');
assert.equal(phoneDigits('469.863.9804'), '4698639804');
assert.equal(phoneDigits('14698639804'), '4698639804');
assert.equal(phoneDigits(''), '');
assert.equal(phoneDigits(undefined), '');

// normalize
assert.equal(normalize('  123 Main St., Apt #4 '), '123 main st apt 4');

// nameMatches — last name anchors identity
assert.equal(nameMatches('Mike Smith', 'Michael Smith'), true);
assert.equal(nameMatches('smith', 'Michael Smith'), true);
assert.equal(nameMatches('Mike Jones', 'Michael Smith'), false);
assert.equal(nameMatches('', 'Michael Smith'), false);

// addressMatches — house number + a street word must both hit
assert.equal(addressMatches('123 Main Street, Rowlett', '123 Main St'), true);
assert.equal(addressMatches('123 Maple St', '123 Main St'), false);
assert.equal(addressMatches('456 Main St', '123 Main St'), false);
assert.equal(addressMatches('Main St', '123 Main St'), false);

// pluck — top level, then one level deep, else ''
assert.equal(pluck({ uuid: 'job_1', id: 'x' }, ['uuid', 'id']), 'job_1');
assert.equal(pluck({ schedule: { scheduled_start: '2026-07-14T14:00:00Z' } }, ['scheduled_start']), '2026-07-14T14:00:00Z');
assert.equal(pluck({ n: 42 }, ['n']), '42');
assert.equal(pluck(null, ['uuid']), '');
assert.equal(pluck({ a: 1 }, ['b']), '');

console.log('voice-lookup.check OK');
```

**Step 2.3** — Verify:

```bash
npx tsx src/agent/tools/reads/voice-lookup.check.ts
```

Expected output: `voice-lookup.check OK`

**Step 2.4** — Commit:

```bash
git add src/agent/tools/reads/voice-lookup.ts src/agent/tools/reads/voice-lookup.check.ts
git commit -m "feat(voice): caller-scoped appointment/estimate lookup tool"
```

---

## Task 3 — Register the tool + probe script

**Step 3.1** — Edit `src/agent/index.ts`. Find this import block:

```ts
import { ragReadTools } from './tools/reads/rag.js';
import { hcpReadTools } from './tools/reads/hcp.js';
```

Add one line after the `hcpReadTools` import so it reads:

```ts
import { ragReadTools } from './tools/reads/rag.js';
import { hcpReadTools } from './tools/reads/hcp.js';
import { voiceLookupTools } from './tools/reads/voice-lookup.js';
```

**Step 3.2** — In the same file, find:

```ts
const allTools = {
  ...ragReadTools,
  ...hcpReadTools,
  ...messagingReadTools,
  ...homeDepotTools,
  ...memoryWriteTools,
};
```

Replace with:

```ts
const allTools = {
  ...ragReadTools,
  ...hcpReadTools,
  ...messagingReadTools,
  ...homeDepotTools,
  ...memoryWriteTools,
  ...voiceLookupTools,
};
```

**Step 3.3** — Edit `src/agent/resolver.ts`. Find:

```ts
const VOICE_INCLUDED = new Set([
  'search_pricebook',
  'lookup_pricing',
  'search_knowledge',
]);
```

Replace with:

```ts
const VOICE_INCLUDED = new Set([
  'search_pricebook',
  'lookup_pricing',
  'search_knowledge',
  'lookup_my_appointments',
]);
```

**Step 3.4** — Create `scripts/probe-voice-lookup.ts` with exactly this content:

```ts
/**
 * Manual probe for the caller-scoped voice lookup against LIVE HCP (read-only).
 * Usage:
 *   npx tsx scripts/probe-voice-lookup.ts "<phone>" "<name>" ["<address>"]
 * Requires a valid HCP session (npm run login).
 */
import 'dotenv/config';
import { lookupMyAppointments } from '../src/agent/tools/reads/voice-lookup.js';

const [phone, name, address] = process.argv.slice(2);
if (!name) {
  console.error('Usage: npx tsx scripts/probe-voice-lookup.ts "<phone>" "<name>" ["<address>"]');
  process.exit(1);
}
const result = await lookupMyAppointments({ callerPhone: phone, name, address });
console.log(JSON.stringify(result, null, 2));
```

**Step 3.5** — Verify the tool registry wiring (no network):

```bash
npx tsx -e "import('./src/agent/tools/reads/voice-lookup.js').then(m => console.log(Object.keys(m.voiceLookupTools).join(',')))"
```

Expected output: `lookup_my_appointments`

```bash
grep -n "lookup_my_appointments" src/agent/resolver.ts src/agent/index.ts | head -5
```

Expected output: one hit in `resolver.ts` (inside `VOICE_INCLUDED`) — `index.ts` matches via `voiceLookupTools`, so seeing only the resolver line is correct. Also confirm:

```bash
grep -n "voiceLookupTools" src/agent/index.ts
```

Expected output: two lines — the import and the `...voiceLookupTools,` spread.

**Step 3.6** — Commit:

```bash
git add src/agent/index.ts src/agent/resolver.ts scripts/probe-voice-lookup.ts
git commit -m "feat(voice): register lookup_my_appointments on voice channel + probe script"
```

**END OF SESSION 1. STOP. Report and wait for orchestrator verification.**

---

# SESSION 2 — Persona + pipeline (Tasks 4–5)

## Task 4 — Replace `VOICE_INSTRUCTIONS` in `src/agent/resolver.ts`

**Step 4.1** — In `src/agent/resolver.ts`, replace the ENTIRE `const VOICE_INSTRUCTIONS = ...;` template literal (it starts at `const VOICE_INSTRUCTIONS = \`You are Maverick, the phone assistant` and ends with the line `- If a caller asks you to do something outside these flows, take a message instead.\`;`) with exactly this:

```ts
const VOICE_INSTRUCTIONS = `You are Maverick, the phone assistant for Grizzly Electrical Solutions — a licensed electrical contractor serving Dallas/Fort Worth and surrounding areas.

You are on a LIVE PHONE CALL with a customer. Everything you write is spoken aloud by text-to-speech.

## SPEECH RULES (always)
- Short sentences. Conversational. No markdown, no bullet points, no emoji, no headers.
- One question at a time. Wait for the answer.
- Say numbers naturally: "four sixty-nine" not "469-".
- Keep most turns under 40 words. Never read lists longer than 3 items aloud.
- If you didn't catch something, ask them to repeat it — never guess a name, number, or address.

## OFFICE HOURS
Every caller turn ends with a note like "(Office is currently OPEN)" or "(Office is currently CLOSED)". Trust it. Hours are Monday through Friday eight a m to six p m, Saturday eight a m to two p m, Central time. If asked, say them naturally.

## WHAT YOU DO
1. Answer questions about services, service area, hours, and general electrical topics.
   Use search_knowledge for company/service questions. Answer from your own electrical knowledge for general questions.
2. Give PRICE RANGES only (below).
3. Take booking requests (below).
4. Take messages for Carter and Jaime (below).
5. Connect callers to a person — transfer requests (below).
6. Verify or reschedule existing appointments and check on estimates (below).
7. Handle emergencies (below) — this overrides everything else.

## PRICING QUESTIONS
Use search_pricebook / lookup_pricing first, then give a RANGE: "That typically runs between X and Y. Real pricing depends on a lot of factors — the condition of your panel, wire runs, permits — so we confirm the exact price on-site." NEVER quote a firm price. NEVER mention internal costs, crew pay, or markups. If they want to move forward, run the BOOKING FLOW.

## BOOKING FLOW
When a caller wants to schedule service or an estimate visit, collect ONE AT A TIME:
1. Full name.
2. Best callback number — ask "is the number you're calling from the best one?" (you may already have caller ID).
3. Service address, including city.
4. What they need done — one or two sentences.
5. Their best days and time windows — get TWO OR THREE options, e.g. "Tuesday afternoon or Wednesday morning."
Then say EXACTLY this promise: "You're all set. We'll confirm one of those times with you within the next business day."
Then emit this block on its own (single-line JSON, no extra text after it):
[BOOKING_REQUEST]{"customerName":"<name>","callbackPhone":"<phone>","address":"<full address with city>","email":"<email or empty string>","issue":"<what they need>","preferredWindows":["<option 1>","<option 2>"]}[/BOOKING_REQUEST]
NEVER promise a specific appointment time. NEVER say a time is available or booked. The office confirms.

## MESSAGE FLOW
If the caller just wants Carter or Jaime to call them back, or has a question you cannot answer, collect: name, callback number, and the message. Confirm it back briefly, then emit:
[MESSAGE]{"callerName":"<name>","callbackPhone":"<phone>","message":"<the message>"}[/MESSAGE]
Then say: "Got it. I'll pass that along right away."

## TRANSFER REQUEST FLOW (non-emergency)
When a caller asks to speak to a person:
- If the office is CLOSED: say the office is closed right now and offer to take a message instead (MESSAGE FLOW). Do not emit a transfer block.
- If the office is OPEN: ask for their name and a one-line reason for the call. Then say "One moment while I try to connect you." and emit:
[TRANSFER]{"kind":"general","target":"<jaime or carter>","callerName":"<name>","reason":"<one line>"}[/TRANSFER]
Target: if they asked for Jaime or Carter by name, use that person. Otherwise route by the same geography rule as emergencies, defaulting to carter.
If nobody picks up, the system takes a message automatically — you don't handle that.

## APPOINTMENT AND ESTIMATE LOOKUP FLOW
When a caller wants to verify, check, or reschedule an appointment, or asks about their estimate:
1. Verify identity FIRST. Ask "Can I get your full name?" then call lookup_my_appointments with the caller ID phone and their name. If it returns verified false, ask for their full name AND service address and call it again with both.
2. Share NOTHING about any appointment or estimate until the tool returns verified true. If it cannot verify, apologize and offer to take a message.
3. Read back only what they need, naturally: "I show you scheduled for Tuesday the fourteenth, between two and four."
4. RESCHEDULING: once verified and you've read their current time, collect TWO OR THREE new day/time windows. Then say EXACTLY: "Okay. We'll confirm the new time with you within the next business day." and emit:
[RESCHEDULE]{"jobId":"<jobId from the lookup>","customerName":"<name>","callbackPhone":"<phone>","currentTime":"<current scheduled time>","preferredWindows":["<option 1>","<option 2>"]}[/RESCHEDULE]
NEVER say the appointment has been moved or changed — the office confirms.

## EMERGENCY FLOW
Emergency signs: fire, smoke, sparks, burning smell, buzzing panel, shock, downed line, total power loss with hazard.
- If there is ANY active fire or smoke: FIRST tell them to hang up and call nine one one immediately. Do not transfer.
- Otherwise: say you're connecting them to an electrician right now, then ask "What city are you in?" if you don't know yet.
Route by geography — closer to Rowlett (northeast: Rowlett, Garland, Rockwall, Plano, Richardson, Mesquite, Wylie, north or east Dallas) goes to Jaime. Closer to Waxahachie (south: Waxahachie, Ennis, Midlothian, Red Oak, DeSoto, Cedar Hill, Duncanville, south Dallas) goes to Carter. If unclear or in between, pick Carter.
Say "Okay, connecting you now — please hold." then emit:
[TRANSFER]{"kind":"emergency","target":"<jaime or carter>","callerCity":"<city>","reason":"<one line>"}[/TRANSFER]
Emergencies transfer at ANY hour, open or closed.

## WHAT YOU NEVER DO
- Never quote firm prices, internal costs, or timelines.
- Never say an appointment is confirmed, booked, moved, or changed — only "we'll confirm within the next business day."
- Never share Carter's or Jaime's personal phone numbers — transfers happen silently.
- Never take payment information of any kind. If offered, say the office handles payment.
- Never discuss other customers, jobs, or internal business details. The ONLY customer records you may mention are the ones lookup_my_appointments returns for the verified caller.
- If a caller asks you to do something outside these flows, take a message instead.`;
```

**Step 4.2** — Verify:

```bash
npx tsx -e "import('./src/agent/resolver.js').then(m => { const s = m.resolveInstructions('voice',''); for (const k of ['TRANSFER REQUEST FLOW','APPOINTMENT AND ESTIMATE LOOKUP FLOW','[RESCHEDULE]','kind\":\"general','kind\":\"emergency','Office is currently']) { if (!s.includes(k)) { console.error('MISSING: ' + k); process.exit(1); } } console.log('persona OK'); })"
```

Expected output: `persona OK`

**Step 4.3** — Commit:

```bash
git add src/agent/resolver.ts
git commit -m "feat(voice): persona — screened transfers, appointment lookup, reschedule flows"
```

---

## Task 5 — `from-voice.ts` reschedule kind (FULL FILE REPLACEMENT)

**Step 5.1** — Replace the ENTIRE contents of `src/automations/bookings/from-voice.ts` with:

```ts
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
```

**Step 5.2** — Verify (grep only — do NOT run this file; it writes to live HCP):

```bash
grep -c "reschedule" src/automations/bookings/from-voice.ts
```

Expected output: a number ≥ 8.

```bash
grep -n "reschedule_pending\|RESCHEDULE REQUEST\|STATUS_BY_KIND" src/automations/bookings/from-voice.ts
```

Expected output: at least 4 matching lines (the status map definition, its reschedule entry, the note header, and the status lookup).

**Step 5.3** — Commit:

```bash
git add src/automations/bookings/from-voice.ts
git commit -m "feat(voice): reschedule kind in from-voice pipeline"
```

**END OF SESSION 2. STOP. Report and wait for orchestrator verification.**

---

# SESSION 3 — Voice server (Tasks 6–7)

## Task 6 — `voice-server.ts` (FULL FILE REPLACEMENT)

**Step 6.1** — Replace the ENTIRE contents of `src/agent/voice-server.ts` with:

```ts
/**
 * Maverick Voice Server — Twilio ConversationRelay adapter.
 *
 * HTTP:
 *   GET  /health       — liveness
 *   POST /twiml        — Twilio number's Voice webhook. Returns <Connect><ConversationRelay>.
 *   POST /handoff      — Connect action callback after the relay session ends. If the agent
 *                        requested a transfer (handoffData), dials Jaime or Carter.
 *                        General (non-emergency) transfers dial with a whisper screen.
 *   POST /whisper      — <Number url> callback on the callee leg: announces who's calling
 *                        and gathers "press 1 to accept" so voicemail never swallows a call.
 *   POST /whisper-ok   — Gather action: Digits "1" bridges the call, anything else hangs up
 *                        the callee leg (Twilio then reports no-answer to /dial-result).
 *   POST /dial-result  — Dial action callback. No answer → dial the other person → give up politely.
 * WS:
 *   /ws                — ConversationRelay session. Twilio does STT/TTS; we exchange text.
 *
 * Agent blocks handled here (emitted by the voice persona, see resolver.ts):
 *   [TRANSFER]{...}        → end session with handoffData → /handoff dials out.
 *                            kind "general" is gated on office hours (closed → message)
 *                            and screened via /whisper. kind "emergency" dials directly, 24/7.
 *   [RESCHEDULE]{...}      → spawn src/automations/bookings/from-voice.ts (kind "reschedule")
 *   [BOOKING_REQUEST]{...} → spawn the same pipeline (kind "booking")
 *   [MESSAGE]{...}         → spawn the same pipeline (kind "message")
 *
 * Start: npx tsx src/agent/voice-server.ts   (PM2: voice-server)
 */
import 'dotenv/config';
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createMaverickAgent } from './index.js';
import { logAudit } from './audit-log.js';
import { officeStatus } from './office-hours.js';
import { randomUUID } from 'crypto';

const PORT = Number(process.env.VOICE_PORT ?? 8765);
const PUBLIC_URL = (process.env.VOICE_PUBLIC_URL ?? 'https://voice.grizzlyelectrical.net').replace(/\/$/, '');
const CARTER_PHONE = process.env.CARTER_PHONE ?? '';
const JAIME_PHONE = process.env.JAIME_PHONE ?? '';
// ponytail: TTS is env-swappable, not per-call configurable — flip .env, restart, done.
// Empty VOICE_TTS_VOICE omits the attribute so Twilio uses the provider's default voice.
const TTS_PROVIDER = process.env.VOICE_TTS_PROVIDER ?? '';
const TTS_VOICE = process.env.VOICE_TTS_VOICE ?? 'Polly.Joanna-Neural';
const MAX_HISTORY = 30;

const GREETING = "Thanks for calling Grizzly Electrical! This is Maverick, the automated assistant. How can I help you today?";

type TransferKind = 'general' | 'emergency';

interface TransferInfo {
  callerName?: string;
  reason?: string;
}

interface CallSession {
  callSid: string;
  from: string; // caller ID, E.164 when Twilio provides it
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

const sessions = new Map<string, CallSession>();

// ─── helpers ────────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendXml(res: http.ServerResponse, xml: string) {
  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end(xml);
}

function transferTargetPhone(target: string): string {
  return target === 'jaime' ? JAIME_PHONE : CARTER_PHONE;
}

function otherTarget(target: string): string {
  return target === 'jaime' ? 'carter' : 'jaime';
}

function appendJsonl(file: string, record: Record<string, unknown>) {
  const p = path.resolve(process.cwd(), file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(record) + '\n');
}

function encodeInfo(info: TransferInfo): string {
  return encodeURIComponent(JSON.stringify({ callerName: info.callerName ?? '', reason: info.reason ?? '' }));
}

function decodeInfo(raw: string | null): TransferInfo {
  try { return JSON.parse(decodeURIComponent(raw ?? '') || '{}'); } catch { return {}; }
}

/**
 * TwiML that dials one transfer target. General transfers wrap the number in
 * <Number url=/whisper> so the callee hears who's calling and must press 1 —
 * declining or voicemail makes Twilio report no-answer, which /dial-result
 * turns into the fallback chain. Emergencies dial directly (speed matters).
 */
function dialTwiml(target: string, kind: TransferKind, info: TransferInfo, tried: string, sayFirst?: string): string {
  const number = transferTargetPhone(target);
  const infoParam = encodeInfo(info);
  const action = `${PUBLIC_URL}/dial-result?tried=${tried}&kind=${kind}&info=${infoParam}`;
  const inner =
    kind === 'general'
      ? `<Number url="${xmlEscape(`${PUBLIC_URL}/whisper?info=${infoParam}`)}">${xmlEscape(number)}</Number>`
      : xmlEscape(number);
  const say = sayFirst ? `\n  <Say>${xmlEscape(sayFirst)}</Say>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>${say}
  <Dial timeout="25" action="${xmlEscape(action)}">${inner}</Dial>
</Response>`;
}

/** Mirror of customer-chat-server spawnPipeline: feed JSON over stdin to a tsx subprocess. */
function spawnPipeline(payload: Record<string, unknown>): void {
  const child = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'src/automations/bookings/from-voice.ts'],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  child.stdout.on('data', (d) => console.log(`[voice-pipeline] ${String(d).trim()}`));
  child.stderr.on('data', (d) => console.error(`[voice-pipeline:err] ${String(d).trim()}`));
  child.on('exit', (code) => console.log(`[voice-pipeline] exited ${code}`));
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Maverick Voice Server running\n');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/twiml') {
    // Twilio Voice webhook → hand the call to ConversationRelay.
    const wsUrl = PUBLIC_URL.replace(/^http/, 'ws') + '/ws';
    const ttsAttrs =
      (TTS_PROVIDER ? ` ttsProvider="${xmlEscape(TTS_PROVIDER)}"` : '') +
      (TTS_VOICE ? ` voice="${xmlEscape(TTS_VOICE)}"` : '');
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${xmlEscape(PUBLIC_URL + '/handoff')}">
    <ConversationRelay url="${xmlEscape(wsUrl)}" welcomeGreeting="${xmlEscape(GREETING)}"${ttsAttrs} dtmfDetection="true" />
  </Connect>
</Response>`);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/handoff') {
    // Fires when the ConversationRelay session ends. If we ended it with handoffData,
    // Twilio passes it back as the HandoffData parameter.
    const body = new URLSearchParams(await readBody(req));
    let handoff: { target?: string; kind?: string; callerName?: string; reason?: string } = {};
    try { handoff = JSON.parse(body.get('HandoffData') ?? '{}'); } catch {}
    const target = handoff.target === 'jaime' || handoff.target === 'carter' ? handoff.target : null;

    if (!target) {
      // Normal end of call (caller hung up or conversation finished) — just complete.
      sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }
    const kind: TransferKind = handoff.kind === 'general' ? 'general' : 'emergency';
    const info: TransferInfo = { callerName: handoff.callerName, reason: handoff.reason };
    console.log(`[voice] ${kind} transfer → ${target} (${transferTargetPhone(target)})`);
    sendXml(res, dialTwiml(target, kind, info, target));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/whisper') {
    // Runs on the CALLEE leg (Carter/Jaime) the moment they answer a screened transfer.
    const info = decodeInfo(url.searchParams.get('info'));
    const who = (info.callerName || 'a customer').slice(0, 60);
    const why = (info.reason || 'no reason given').slice(0, 120);
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${xmlEscape(PUBLIC_URL + '/whisper-ok')}" timeout="6">
    <Say>Grizzly call from ${xmlEscape(who)}, about: ${xmlEscape(why)}. Press one to accept.</Say>
  </Gather>
  <Hangup/>
</Response>`);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/whisper-ok') {
    const body = new URLSearchParams(await readBody(req));
    if ((body.get('Digits') ?? '') === '1') {
      // Empty response = whisper TwiML complete → Twilio bridges the two legs.
      sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response/>`);
    } else {
      // Decline → hang up the callee leg → Dial reports no-answer → fallback chain.
      sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/dial-result') {
    const body = new URLSearchParams(await readBody(req));
    const status = body.get('DialCallStatus') ?? '';
    const tried = url.searchParams.get('tried') ?? '';
    const kind: TransferKind = url.searchParams.get('kind') === 'general' ? 'general' : 'emergency';
    const info = decodeInfo(url.searchParams.get('info'));

    if (status === 'completed') {
      sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }
    if (tried === 'carter' || tried === 'jaime') {
      // First target didn't answer — try the other one.
      const next = otherTarget(tried);
      console.log(`[voice] Transfer fallback (${kind}): ${tried} no answer → ${next} (${transferTargetPhone(next)})`);
      sendXml(res, dialTwiml(next, kind, info, 'both', 'Still connecting you, one moment please.'));
      return;
    }
    // Both failed.
    appendJsonl('data/voice-messages.jsonl', {
      kind: `${kind}_unreached`,
      caller: body.get('From') ?? '',
      callerName: info.callerName ?? '',
      reason: info.reason ?? '',
      at: new Date().toISOString(),
    });
    const giveUp =
      kind === 'emergency'
        ? "We weren't able to connect you right now. If this is a life threatening emergency, please hang up and call nine one one. Otherwise, we have your number and will call you back as soon as possible."
        : "Nobody was able to pick up just now. We have your number and someone will call you back as soon as possible. Thanks for calling Grizzly Electrical.";
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${xmlEscape(giveUp)}</Say>
  <Hangup/>
</Response>`);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

// ─── WebSocket (ConversationRelay) ──────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  let session: CallSession | null = null;

  ws.on('message', async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      // Twilio ConversationRelay opens with "setup"; older docs used "start" — accept both.
      case 'setup':
      case 'start': {
        const callSid = String(msg.callSid ?? randomUUID());
        const from = String(msg.from ?? '');
        session = { callSid, from, history: [] };
        sessions.set(callSid, session);
        console.log(`[voice] Call started: ${callSid} from ${from || 'unknown'}`);
        // welcomeGreeting in the TwiML speaks first — no greeting sent here.
        break;
      }

      case 'prompt': {
        if (!session) break;
        const transcript = String(msg.voicePrompt ?? '').trim();
        if (!transcript) break;
        console.log(`[voice] Caller: ${transcript}`);

        session.history.push({ role: 'user', content: transcript });
        if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
        const agent = createMaverickAgent('voice');
        const turnId = randomUUID();

        try {
          const context = session.history
            .slice(0, -1)
            .map((m) => `${m.role === 'user' ? 'Caller' : 'Maverick'}: ${m.content}`)
            .join('\n');
          const callerIdNote = session.from ? `\n(Caller ID: ${session.from})` : '';
          const officeNote = `\n(Office is currently ${officeStatus()})`;
          const fullPrompt = (context ? `${context}\n` : '') + `Caller: ${transcript}${callerIdNote}${officeNote}`;

          const result = await agent.generate(fullPrompt);
          const responseText = typeof result.text === 'string' ? result.text : '';
          session.history.push({ role: 'assistant', content: responseText });

          // ── block extraction (priority: TRANSFER > RESCHEDULE > BOOKING_REQUEST > MESSAGE) ──
          const transferMatch = responseText.match(/\[TRANSFER\]([\s\S]*?)\[\/TRANSFER\]/);
          const rescheduleMatch = responseText.match(/\[RESCHEDULE\]([\s\S]*?)\[\/RESCHEDULE\]/);
          const bookingMatch = responseText.match(/\[BOOKING_REQUEST\]([\s\S]*?)\[\/BOOKING_REQUEST\]/);
          const messageMatch = responseText.match(/\[MESSAGE\]([\s\S]*?)\[\/MESSAGE\]/);

          const spokenText = responseText
            .replace(/\[TRANSFER\][\s\S]*?\[\/TRANSFER\]/g, '')
            .replace(/\[RESCHEDULE\][\s\S]*?\[\/RESCHEDULE\]/g, '')
            .replace(/\[BOOKING_REQUEST\][\s\S]*?\[\/BOOKING_REQUEST\]/g, '')
            .replace(/\[MESSAGE\][\s\S]*?\[\/MESSAGE\]/g, '')
            .replace(/\[ESTIMATE_READY\][\s\S]*?\[\/ESTIMATE_READY\]/g, '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .trim();

          let intent = 'voice_turn';

          if (transferMatch) {
            let t: { target?: string; kind?: string; callerName?: string; reason?: string; callerCity?: string } = {};
            try { t = JSON.parse(transferMatch[1]); } catch {}
            const target = t.target === 'jaime' ? 'jaime' : 'carter';
            const kind: TransferKind = t.kind === 'general' ? 'general' : 'emergency';

            if (kind === 'general' && officeStatus() === 'CLOSED') {
              // Backstop: the persona shouldn't request a general transfer after hours.
              // If it does anyway, convert it to a message instead of dialing anyone.
              intent = 'voice_message';
              spawnPipeline({
                kind: 'message',
                payload: {
                  callerName: t.callerName ?? 'Unknown Caller',
                  callbackPhone: session.from,
                  message: `Asked to be transferred after hours. Reason: ${t.reason ?? 'not given'}`,
                },
                callerPhone: session.from,
                callSid: session.callSid,
              });
              sendText(ws, "The office is closed right now, so I've passed your message along instead. Someone will call you back the next business day.");
            } else {
              intent = kind === 'general' ? 'voice_general_transfer' : 'voice_transfer';
              sendText(ws, spokenText || 'Okay, connecting you now. Please hold.');
              appendJsonl('data/voice-messages.jsonl', {
                kind: `${kind}_transfer`, target, caller: session.from,
                detail: transferMatch[1], at: new Date().toISOString(),
              });
              // End the relay session; Twilio then POSTs /handoff with this data.
              const handoffData = JSON.stringify({
                target, kind,
                callerName: t.callerName ?? '',
                reason: t.reason ?? t.callerCity ?? '',
              });
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'end', handoffData }));
                }
              }, 100);
            }
          } else if (rescheduleMatch) {
            intent = 'voice_reschedule';
            let payload: Record<string, unknown> = {};
            try { payload = JSON.parse(rescheduleMatch[1]); } catch (e) {
              console.error('[voice] Bad block JSON:', e);
            }
            spawnPipeline({
              kind: 'reschedule',
              payload,
              callerPhone: session.from,
              callSid: session.callSid,
            });
            sendText(ws, spokenText || "Okay. We'll confirm the new time with you within the next business day.");
          } else if (bookingMatch || messageMatch) {
            intent = bookingMatch ? 'voice_booking' : 'voice_message';
            let payload: Record<string, unknown> = {};
            try { payload = JSON.parse((bookingMatch ?? messageMatch)![1]); } catch (e) {
              console.error('[voice] Bad block JSON:', e);
            }
            spawnPipeline({
              kind: bookingMatch ? 'booking' : 'message',
              payload,
              callerPhone: session.from,
              callSid: session.callSid,
            });
            sendText(ws, spokenText || "You're all set. We'll be in touch within the next business day.");
          } else {
            sendText(ws, spokenText || 'Let me check on that for you.');
          }

          console.log(`[voice] Maverick (${intent}): ${spokenText.slice(0, 120)}`);
          logAudit({
            turnId,
            userRequest: transcript.slice(0, 120),
            intent,
            modelUsed: 'reasoning',
            toolsInvoked: [],
            workflowsTriggered: [],
            hcpIdsChanged: [],
            approvedBy: 'caller',
            result: 'success',
            sensitiveRefs: [],
          });
        } catch (e) {
          console.error('[voice] Agent error:', e);
          sendText(ws, "I'm having a little trouble on my end. Let me take your name and number and we'll call you right back.");
        }
        break;
      }

      case 'interrupt':
        break; // Twilio handles barge-in at the platform level

      case 'error':
        console.error('[voice] Relay error event:', JSON.stringify(msg).slice(0, 300));
        break;

      case 'stop': {
        const sid = session?.callSid;
        if (sid) {
          sessions.delete(sid);
          console.log(`[voice] Call ended: ${sid}`);
        }
        session = null;
        break;
      }
    }
  });

  ws.on('error', (err: Error) => console.error('[voice] WS error:', err.message));
});

function sendText(ws: WebSocket, text: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'text', token: text, last: true }));
}

server.listen(PORT, () => {
  console.log(`[voice] Maverick Voice Server listening on :${PORT} (public: ${PUBLIC_URL})`);
  if (!CARTER_PHONE || !JAIME_PHONE) {
    console.warn('[voice] WARNING: CARTER_PHONE / JAIME_PHONE not set — emergency transfer will fail');
  }
});
```

**Step 6.2** — Commit:

```bash
git add src/agent/voice-server.ts
git commit -m "feat(voice): business hours, screened transfers, reschedule blocks in voice server"
```

---

## Task 7 — Endpoint smoke test (port 8790 — NEVER 8765)

**Step 7.1** — Start a TEST instance in the background (Git Bash):

```bash
cd /c/Workspace/Active/grizzly-hcp
VOICE_PORT=8790 VOICE_PUBLIC_URL=http://localhost:8790 npx tsx src/agent/voice-server.ts > /tmp/voice-test.log 2>&1 &
sleep 6
cat /tmp/voice-test.log
```

Expected output contains: `[voice] Maverick Voice Server listening on :8790 (public: http://localhost:8790)`

**Step 7.2** — Health + TwiML:

```bash
curl -s http://localhost:8790/health
```

Expected output: `Maverick Voice Server running`

```bash
curl -s -X POST http://localhost:8790/twiml
```

Expected output: XML containing `<ConversationRelay url="ws://localhost:8790/ws"` and `welcomeGreeting=`.

**Step 7.3** — Whisper endpoints:

```bash
curl -s -X POST "http://localhost:8790/whisper?info=%7B%22callerName%22%3A%22Mike%22%2C%22reason%22%3A%22panel%20quote%22%7D"
```

Expected output: XML containing `<Gather numDigits="1"` and `Grizzly call from Mike, about: panel quote. Press one to accept.` followed by `<Hangup/>`.

```bash
curl -s -X POST http://localhost:8790/whisper-ok -d "Digits=1"
```

Expected output: `<?xml version="1.0" encoding="UTF-8"?><Response/>`

```bash
curl -s -X POST http://localhost:8790/whisper-ok -d "Digits=2"
```

Expected output: `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`

**Step 7.4** — Handoff (general = screened dial; emergency = direct dial):

```bash
curl -s -X POST http://localhost:8790/handoff --data-urlencode 'HandoffData={"target":"carter","kind":"general","callerName":"Mike","reason":"panel quote"}'
```

Expected output: XML containing `<Dial timeout="25"` and `<Number url="http://localhost:8790/whisper?info=` (the callee is wrapped in a whisper Number).

```bash
curl -s -X POST http://localhost:8790/handoff --data-urlencode 'HandoffData={"target":"carter","kind":"emergency","reason":"sparking panel"}'
```

Expected output: XML containing `<Dial timeout="25"` and NO `<Number url=` (direct dial).

**Step 7.5** — Dial-result fallback chain:

```bash
curl -s -X POST "http://localhost:8790/dial-result?tried=carter&kind=general&info=%7B%7D" -d "DialCallStatus=no-answer"
```

Expected output: XML containing `<Say>Still connecting you, one moment please.</Say>` and a `<Dial` whose target is wrapped in `<Number url=` (whisper kept on fallback), with `tried=both` in the action URL.

```bash
curl -s -X POST "http://localhost:8790/dial-result?tried=both&kind=general&info=%7B%7D" -d "DialCallStatus=no-answer"
```

Expected output: XML `<Say>` containing `Nobody was able to pick up just now` and NOT containing `nine one one`.

```bash
curl -s -X POST "http://localhost:8790/dial-result?tried=both&kind=emergency&info=%7B%7D" -d "DialCallStatus=no-answer"
```

Expected output: XML `<Say>` containing `nine one one`.

**Step 7.6** — Stop ONLY the test instance you started (it is the `npx tsx` job from Step 7.1 — do not touch PM2 or port 8765):

```bash
kill %1
sleep 1
curl -s --max-time 3 http://localhost:8790/health || echo "test server stopped"
```

Expected output: `test server stopped`

**Step 7.7** — Confirm clean tree (all changes already committed):

```bash
git status --porcelain
```

Expected output: empty (nothing to commit).

**END OF SESSION 3. STOP. Report and wait for orchestrator verification.**

---

# Post-plan (orchestrator + Carter — NOT Qwen)

1. Merge `feature/voice-fulltime` → `main`.
2. **Carter** restarts the PM2 `voice-server` process (per house rules, only Carter touches PM2).
3. Probe the live lookup with a real customer: `npx tsx scripts/probe-voice-lookup.ts "<customer phone>" "<customer name>"` — confirm `verified: true` and that `appointments[].scheduledFor` / `jobId` fields are populated. If fields come back empty, inspect one raw job from `/pro/jobs/scheduled` and extend the `pluck` key lists in `voice-lookup.ts`.
4. Live test calls: general transfer accept (press 1) / decline / no-answer fallback; after-hours message path; appointment verify + reschedule; emergency path regression.
5. Carter sets up carrier call-forwarding (469) 863-9804 → Twilio number, and a test call confirms the ORIGINAL caller ID passes through forwarding (the verification flow depends on it).
6. Archive this PLAN.md per build-handoff Phase C.
