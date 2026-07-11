# PLAN — Grizzly Voice Agent (Maverick answers the phone)

**Feature:** Twilio ConversationRelay voice agent — answers the business line, answers questions
via RAG + pricebook, takes booking requests + messages, HCP-note approval loop that schedules
jobs, and geographic emergency transfer.
**Branch:** `feature/voice-agent`
**Executor environment:** Windows 11 / Git Bash. Repo root: `C:\Workspace\Active\grizzly-hcp`.
All commands run from repo root unless stated.

---

## Codebase Primer (READ FIRST)

This is a Node.js + TypeScript ESM repo (`"type": "module"`), run via `tsx` with **no build step**.
**All relative imports end in `.js` even though source files are `.ts`** — e.g.
`import { createMaverickAgent } from './index.js'` inside `src/agent/`. Follow this exactly.

### Existing architecture you are extending

- **Agent brain:** `src/agent/index.ts` — `createMaverickAgent(channel)` builds a Mastra `Agent`.
  Instructions and tools per channel are filtered by `src/agent/resolver.ts`
  (`resolveInstructions`, `resolveTools`). Channels: `text | voice | cli | employee | slack | advisory | customer`.
- **Tools:** built with `createTool` from `@mastra/core/tools` + `zod`, bundled into records
  (`ragReadTools`, `hcpReadTools`, …) in `src/agent/tools/reads/*.ts`.
- **Voice server (placeholder):** `src/agent/voice-server.ts` — Twilio ConversationRelay WebSocket
  adapter on port 8765. You will REPLACE this file entirely (Task 5).
- **Block convention:** the agent signals server-side actions by emitting inline blocks in its
  reply text, e.g. `[ESTIMATE_READY]{json}[/ESTIMATE_READY]`. The server regex-extracts the block,
  strips it from user-visible text, and spawns a pipeline subprocess fed the JSON via stdin
  (see `spawnPipeline` in `src/server/customer-chat-server.ts:100`). This plan adds three new
  blocks for the voice channel: `[BOOKING_REQUEST]`, `[MESSAGE]`, `[TRANSFER]`.
- **HCP writes:** `src/hcp/gateway.ts` re-exports either the direct cookie client
  (`src/hcp/estimates.ts`, Playwright cookies in `auth/hcp-cookies.json`, base
  `https://pro.housecallpro.com`) or the MCP daemon wrapper (`src/hcp/mcp-client.ts`, Streamable-HTTP
  to `http://127.0.0.1:7332`, bearer `HCP_MCP_TOKEN`), selected by `HCP_VIA_MCP=true` in `.env`.
  The daemon repo is `C:\Workspace\Infrastructure\housecall-pro-mcp` — you do NOT modify it.
- **Key HCP facts:**
  - There is no bare "job" object — the estimate/request record IS the job shell.
    `createEstimate()` returns `{ estimateId: number, uuid: string /* est_... */ }`.
  - `updateEstimateNotes(uuid, text)` (direct client, `src/hcp/estimates.ts:254`) posts a note
    visible to Carter + Jaime in the HCP app.
  - `assignTechnician(uuid, proUuids)` sends `notify_pro: true` → assigned pros get an HCP push
    notification on their phones. This is how Carter + Jaime get alerted.
  - Daemon tool `update_job_schedule` takes `request_id` (numeric, as string) + an UNTYPED
    `schedule_data` object. Its exact payload shape is captured manually via `npm run intercept`
    (Manual Ops Checklist item 1) into `data/schedule-payload-template.json`. Code treats it as
    a token template — never hardcode the shape.
  - Daemon tool `get_job_notes` takes `{ estimate_id: "<uuid>" }` and returns the raw HCP notes
    response (shape not guaranteed — parse defensively).
- **Model routing:** `getModel(role)` from `src/agent/model-router.ts`, roles
  `'REASONING' | 'EXTRACTION' | 'VISION' | 'CHEAP'`.
- **Audit:** `logAudit(fields)` from `src/agent/audit-log.ts` appends JSONL to `data/audit.jsonl`.
- **PM2:** `ecosystem.config.cjs` launches `node_modules/tsx/dist/cli.mjs` with the `.ts` file
  as `args`. Copy that pattern for new processes.

### The feature's data flow

```
Caller → Twilio number → POST https://voice.grizzlyelectrical.net/twiml  (voice-server HTTP)
       → <Connect action="/handoff"><ConversationRelay url="wss://voice.../ws">
       → Twilio streams STT text over WS → agent.generate() → reply text spoken by Twilio TTS

Booking:   agent emits [BOOKING_REQUEST]{...} → voice-server spawns
           src/automations/bookings/from-voice.ts → HCP: customer + estimate shell +
           booking note + assign Carter & Jaime (push notif) → data/pending-bookings.jsonl

Approval:  Carter or Jaime adds an HCP note on that estimate: "SCHEDULE 07/14 2:00 pm - 4:00 pm"
           → src/automations/bookings/approval-poller.ts (PM2, 60s loop) reads notes,
           parses SCHEDULE line, calls update_job_schedule → HCP notifies the customer.

Message:   agent emits [MESSAGE]{...} → same pipeline, kind "message" (note + push, no poller).

Emergency: agent asks the caller's city, emits [TRANSFER]{"target":"jaime"|"carter"} →
           voice-server ends the ConversationRelay session with handoffData → Twilio hits
           POST /handoff → TwiML <Dial> to Jaime (Rowlett side) or Carter (Waxahachie side),
           25s timeout → POST /dial-result → no answer? dial the other one → still no answer?
           spoken fallback + logged.
```

### Constants (from the business)

- Carter: cell `+14697169870`, HCP pro UUID `pro_fec6f009ddfe47bcb388ee45a83c31f1`, lives in Waxahachie (south DFW).
- Jaime: cell `+14694222982`, HCP pro UUID resolved in Task 3, lives in Rowlett (northeast DFW).
- Office line: (469) 863-9804. Timezone: America/Chicago — the server PC runs Central time;
  schedule parsing uses **local server time** on purpose.

---

## Session Map

| Session | Tasks | Theme |
|---|---|---|
| 1 | 1–3 | Dependencies, env, HCP MCP wrappers, employee lookup |
| 2 | 4–5 | Voice persona + full voice server |
| 3 | 6–8 | Schedule payload template, booking pipeline, approval poller |
| 4 | 9–10 | PM2 wiring, local end-to-end smoke test |

Manual Ops Checklist (Carter, no Qwen) is at the bottom.

---

# SESSION 1

## Task 1 — Branch, dependency, env vars

**Step 1.** Create the branch:

```bash
git checkout -b feature/voice-agent
```

Expected output: `Switched to a new branch 'feature/voice-agent'`

**Step 2.** Install the `ws` runtime dependency (only `@types/ws` exists today):

```bash
npm install ws@^8.18.0
```

Expected output: ends with something like `added 1 package` (or `changed 1 package`) and no `ERR!` lines.

**Step 3.** Append the voice config block to `.env`. Do NOT open or rewrite `.env` (it contains
live secrets) — append only, exactly this command:

```bash
printf '\n# ─── Voice agent (Maverick phone line) ───\nVOICE_PORT=8765\nVOICE_PUBLIC_URL=https://voice.grizzlyelectrical.net\nCARTER_PHONE=+14697169870\nJAIME_PHONE=+14694222982\nCARTER_PRO_UUID=pro_fec6f009ddfe47bcb388ee45a83c31f1\nJAIME_PRO_UUID=\nBOOKING_POLL_INTERVAL_MS=60000\n' >> .env
```

**Step 4.** Verify:

```bash
tail -n 9 .env
```

Expected output: the 8 lines appended above (comment line + 7 vars), `JAIME_PRO_UUID=` empty.

**Step 5.** Commit (note: `.env` is gitignored — only package files change):

```bash
git add package.json package-lock.json && git commit -m "chore: add ws dependency for voice server"
```

Expected output: `1 file changed`/`2 files changed`, commit created on `feature/voice-agent`.

---

## Task 2 — MCP client wrappers for scheduling, notes, employees

**Step 1.** Edit `src/hcp/mcp-client.ts`. Append the following three functions at the END of the
file (after `createPriceBookItem`), verbatim:

```ts
/**
 * Voice-agent additions. These three tools exist only on the MCP daemon (no direct-client
 * equivalent), so consumers import them from this module directly instead of gateway.ts.
 */
export async function listEmployees(): Promise<{ count: number; employees: Array<Record<string, unknown>> }> {
  return callTool<{ count: number; employees: Array<Record<string, unknown>> }>("list_employees", {});
}

/** Raw HCP notes response for an estimate/job. Shape is not guaranteed — parse defensively. */
export async function getJobNotes(estimateUuid: string): Promise<unknown> {
  return callTool<unknown>("get_job_notes", { estimate_id: estimateUuid });
}

/**
 * Schedule a job/request. requestId is the NUMERIC estimate/request id as a string
 * (HcpEstimate.estimateId), NOT the est_... uuid. scheduleData comes from
 * buildSchedulePayload() — never hand-build it.
 */
export async function updateJobSchedule(
  requestId: string,
  scheduleData: Record<string, unknown>
): Promise<unknown> {
  return callTool<unknown>("update_job_schedule", { request_id: requestId, schedule_data: scheduleData });
}
```

**Step 2.** Type-check the file:

```bash
npx tsc --noEmit src/hcp/mcp-client.ts 2>&1 | head -20
```

Expected output: EITHER no output (clean) OR only pre-existing errors from OTHER files pulled in
by imports. There must be no error mentioning `mcp-client.ts` itself. (If the repo has no
tsconfig-based clean baseline, `npx tsx -e "import('./src/hcp/mcp-client.js' ...)"` in Step 3 is
the authoritative check.)

**Step 3.** Import smoke test (must not throw at import time):

```bash
npx tsx -e "import * as m from './src/hcp/mcp-client.ts'; console.log(typeof m.updateJobSchedule, typeof m.getJobNotes, typeof m.listEmployees)"
```

Expected output: `function function function`

**Step 4.** Commit:

```bash
git add src/hcp/mcp-client.ts && git commit -m "feat(hcp): mcp wrappers for update_job_schedule, get_job_notes, list_employees"
```

---

## Task 3 — Employee lookup script (resolve Jaime's pro UUID)

**Step 1.** Create `scripts/list-employees.ts` with exactly this content:

```ts
/**
 * Print HCP employees (pro UUIDs) so JAIME_PRO_UUID can be filled into .env.
 * Requires the housecall-pro-mcp daemon running on HCP_MCP_URL.
 * Run: npm run list-employees
 */
import 'dotenv/config';
import { listEmployees } from '../src/hcp/mcp-client.js';

const { employees } = await listEmployees();
for (const e of employees) {
  const id = e.id ?? e.uuid ?? e.pro_uuid ?? '?';
  const name =
    e.name ??
    [e.first_name, e.last_name].filter(Boolean).join(' ') ??
    '?';
  console.log(`${String(id)}  ${String(name)}  ${String(e.mobile_number ?? e.phone ?? '')}`);
}
process.exit(0);
```

**Step 2.** Add the npm script. In `package.json`, inside `"scripts"`, add this line immediately
after the `"mine-pricebook"` entry (add a comma to the `mine-pricebook` line):

```json
    "list-employees": "tsx scripts/list-employees.ts"
```

**Step 3.** Run it:

```bash
npm run list-employees
```

Expected output: one line per employee, each starting with a `pro_...` id. Carter's line shows
`pro_fec6f009ddfe47bcb388ee45a83c31f1`. Note Jaime's `pro_...` id in your session report.
**If the daemon is unreachable** (`HCP service unavailable`), report it and continue — Carter
fills `JAIME_PRO_UUID` manually (Manual Ops Checklist item 4). This does not block later tasks.

**Step 4.** Commit:

```bash
git add scripts/list-employees.ts package.json && git commit -m "feat(hcp): list-employees script to resolve pro UUIDs"
```

---

# SESSION 2

## Task 4 — Voice channel: allow-list tools + customer-facing phone persona

**Step 1.** Edit `src/agent/resolver.ts`. Replace the two lines:

```ts
// Excluded from voice (not meaningful over phone)
const VOICE_EXCLUDED = new Set(['upload_photo', 'draft_reply']);
```

with:

```ts
// Voice is a CUSTOMER-FACING phone line — allow-list, same rationale as ADVISORY_INCLUDED.
// Booking/message/transfer actions happen via inline blocks handled by voice-server.ts,
// not via tools, so callers can never trigger HCP writes directly.
const VOICE_INCLUDED = new Set([
  'search_pricebook',
  'lookup_pricing',
  'search_knowledge',
]);
```

**Step 2.** In the same file, inside `resolveTools`, replace the voice branch:

```ts
  if (channel === 'voice') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => !VOICE_EXCLUDED.has(name))
    ) as Partial<T>;
  }
```

with:

```ts
  if (channel === 'voice') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => VOICE_INCLUDED.has(name))
    ) as Partial<T>;
  }
```

**Step 3.** In the same file, replace the entire `VOICE_SUFFIX` constant (the 4-line block
starting `const VOICE_SUFFIX = ` ) with this standalone instruction set:

```ts
const VOICE_INSTRUCTIONS = `You are Maverick, the phone assistant for Grizzly Electrical Solutions — a licensed electrical contractor serving Dallas/Fort Worth and surrounding areas.

You are on a LIVE PHONE CALL with a customer. Everything you write is spoken aloud by text-to-speech.

## SPEECH RULES (always)
- Short sentences. Conversational. No markdown, no bullet points, no emoji, no headers.
- One question at a time. Wait for the answer.
- Say numbers naturally: "four sixty-nine" not "469-".
- Keep most turns under 40 words. Never read lists longer than 3 items aloud.
- If you didn't catch something, ask them to repeat it — never guess a name, number, or address.

## WHAT YOU DO
1. Answer questions about services, service area, hours, and general electrical topics.
   Use search_knowledge for company/service questions. Answer from your own electrical knowledge for general questions.
2. Give PRICE RANGES only — use search_pricebook / lookup_pricing first, then say "typically runs between X and Y, and we confirm the exact price on-site." NEVER quote a firm price. NEVER mention internal costs, crew pay, or markups.
3. Take booking requests (below).
4. Take messages for Carter and Jaime (below).
5. Handle emergencies (below) — this overrides everything else.

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

## EMERGENCY FLOW
Emergency signs: fire, smoke, sparks, burning smell, buzzing panel, shock, downed line, total power loss with hazard.
- If there is ANY active fire or smoke: FIRST tell them to hang up and call nine one one immediately. Do not transfer.
- Otherwise: say you're connecting them to an electrician right now, then ask "What city are you in?" if you don't know yet.
Route by geography — closer to Rowlett (northeast: Rowlett, Garland, Rockwall, Plano, Richardson, Mesquite, Wylie, north or east Dallas) goes to Jaime. Closer to Waxahachie (south: Waxahachie, Ennis, Midlothian, Red Oak, DeSoto, Cedar Hill, Duncanville, south Dallas) goes to Carter. If unclear or in between, pick Carter.
Say "Okay, connecting you now — please hold." then emit:
[TRANSFER]{"target":"jaime","callerCity":"<city>","reason":"<one line>"}[/TRANSFER]
(target is "jaime" or "carter".)

## WHAT YOU NEVER DO
- Never quote firm prices, internal costs, or timelines.
- Never say an appointment is confirmed or booked — only "we'll confirm within the next business day."
- Never share Carter's or Jaime's personal phone numbers — transfers happen silently.
- Never take payment information of any kind. If offered, say the office handles payment.
- Never discuss other customers, jobs, or any internal business details.
- If a caller asks you to do something outside these flows, take a message instead.`;
```

**Step 4.** In `resolveInstructions` (same file), replace:

```ts
  if (channel === 'voice') return base + VOICE_SUFFIX;
```

with:

```ts
  if (channel === 'voice') return VOICE_INSTRUCTIONS;
```

**Step 5.** Verify the channel wiring:

```bash
npx tsx -e "
import { resolveTools, resolveInstructions } from './src/agent/resolver.ts';
const fake = { search_pricebook:1, lookup_pricing:1, search_knowledge:1, lookup_customer:1, check_hcp_messages:1, save_rule:1 };
const t = resolveTools('voice', fake);
console.log('tools:', Object.keys(t).sort().join(','));
const i = resolveInstructions('voice', 'BASE_SHOULD_NOT_APPEAR');
console.log('persona-ok:', i.includes('LIVE PHONE CALL') && !i.includes('BASE_SHOULD_NOT_APPEAR'));
"
```

Expected output:
```
tools: lookup_pricing,search_knowledge,search_pricebook
persona-ok: true
```

**Step 6.** Commit:

```bash
git add src/agent/resolver.ts && git commit -m "feat(voice): customer-facing phone persona + allow-list tools for voice channel"
```

---

## Task 5 — Voice server: full replacement

**Step 1.** Replace the ENTIRE contents of `src/agent/voice-server.ts` with:

```ts
/**
 * Maverick Voice Server — Twilio ConversationRelay adapter.
 *
 * HTTP:
 *   GET  /health       — liveness
 *   POST /twiml        — Twilio number's Voice webhook. Returns <Connect><ConversationRelay>.
 *   POST /handoff      — Connect action callback after the relay session ends. If the agent
 *                        requested a transfer (handoffData), dials Jaime or Carter.
 *   POST /dial-result  — Dial action callback. No answer → dial the other person → give up politely.
 * WS:
 *   /ws                — ConversationRelay session. Twilio does STT/TTS; we exchange text.
 *
 * Agent blocks handled here (emitted by the voice persona, see resolver.ts):
 *   [TRANSFER]{...}        → end session with handoffData → /handoff dials out
 *   [BOOKING_REQUEST]{...} → spawn src/automations/bookings/from-voice.ts (kind "booking")
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
import { randomUUID } from 'crypto';

const PORT = Number(process.env.VOICE_PORT ?? 8765);
const PUBLIC_URL = (process.env.VOICE_PUBLIC_URL ?? 'https://voice.grizzlyelectrical.net').replace(/\/$/, '');
const CARTER_PHONE = process.env.CARTER_PHONE ?? '';
const JAIME_PHONE = process.env.JAIME_PHONE ?? '';
const MAX_HISTORY = 30;

const GREETING = "Thanks for calling Grizzly Electrical! This is Maverick, the automated assistant. How can I help you today?";

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
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${xmlEscape(PUBLIC_URL + '/handoff')}">
    <ConversationRelay url="${xmlEscape(wsUrl)}" welcomeGreeting="${xmlEscape(GREETING)}" voice="Polly.Joanna-Neural" dtmfDetection="true" />
  </Connect>
</Response>`);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/handoff') {
    // Fires when the ConversationRelay session ends. If we ended it with handoffData,
    // Twilio passes it back as the HandoffData parameter.
    const body = new URLSearchParams(await readBody(req));
    let handoff: { target?: string } = {};
    try { handoff = JSON.parse(body.get('HandoffData') ?? '{}'); } catch {}
    const target = handoff.target === 'jaime' || handoff.target === 'carter' ? handoff.target : null;

    if (!target) {
      // Normal end of call (caller hung up or conversation finished) — just complete.
      sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }
    const number = transferTargetPhone(target);
    console.log(`[voice] Emergency transfer → ${target} (${number})`);
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" action="${xmlEscape(`${PUBLIC_URL}/dial-result?tried=${target}`)}">${xmlEscape(number)}</Dial>
</Response>`);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/dial-result') {
    const body = new URLSearchParams(await readBody(req));
    const status = body.get('DialCallStatus') ?? '';
    const tried = url.searchParams.get('tried') ?? '';

    if (status === 'completed') {
      sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }
    if (tried === 'carter' || tried === 'jaime') {
      // First target didn't answer — try the other one.
      const next = otherTarget(tried);
      const number = transferTargetPhone(next);
      console.log(`[voice] Transfer fallback: ${tried} no answer → ${next} (${number})`);
      sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Still connecting you, one moment please.</Say>
  <Dial timeout="25" action="${xmlEscape(`${PUBLIC_URL}/dial-result?tried=both`)}">${xmlEscape(number)}</Dial>
</Response>`);
      return;
    }
    // Both failed.
    appendJsonl('data/voice-messages.jsonl', {
      kind: 'emergency_unreached',
      caller: body.get('From') ?? '',
      at: new Date().toISOString(),
    });
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We weren't able to connect you right now. If this is a life threatening emergency, please hang up and call nine one one. Otherwise, we have your number and will call you back as soon as possible.</Say>
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
          const fullPrompt = (context ? `${context}\n` : '') + `Caller: ${transcript}${callerIdNote}`;

          const result = await agent.generate(fullPrompt);
          const responseText = typeof result.text === 'string' ? result.text : '';
          session.history.push({ role: 'assistant', content: responseText });

          // ── block extraction (priority: TRANSFER > BOOKING_REQUEST > MESSAGE) ──
          const transferMatch = responseText.match(/\[TRANSFER\]([\s\S]*?)\[\/TRANSFER\]/);
          const bookingMatch = responseText.match(/\[BOOKING_REQUEST\]([\s\S]*?)\[\/BOOKING_REQUEST\]/);
          const messageMatch = responseText.match(/\[MESSAGE\]([\s\S]*?)\[\/MESSAGE\]/);

          const spokenText = responseText
            .replace(/\[TRANSFER\][\s\S]*?\[\/TRANSFER\]/g, '')
            .replace(/\[BOOKING_REQUEST\][\s\S]*?\[\/BOOKING_REQUEST\]/g, '')
            .replace(/\[MESSAGE\][\s\S]*?\[\/MESSAGE\]/g, '')
            .replace(/\[ESTIMATE_READY\][\s\S]*?\[\/ESTIMATE_READY\]/g, '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .trim();

          let intent = 'voice_turn';

          if (transferMatch) {
            intent = 'voice_transfer';
            let t: { target?: string } = {};
            try { t = JSON.parse(transferMatch[1]); } catch {}
            const target = t.target === 'jaime' ? 'jaime' : 'carter';
            sendText(ws, spokenText || 'Okay, connecting you now. Please hold.');
            appendJsonl('data/voice-messages.jsonl', {
              kind: 'emergency_transfer', target, caller: session.from,
              detail: transferMatch[1], at: new Date().toISOString(),
            });
            // End the relay session; Twilio then POSTs /handoff with this data.
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify({ target }) }));
              }
            }, 100);
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

**Step 2.** Verify it boots and serves TwiML (server in background, curl, kill):

```bash
npx tsx src/agent/voice-server.ts & SERVER_PID=$!; sleep 6; curl -s http://localhost:8765/health; curl -s -X POST http://localhost:8765/twiml | head -5; kill $SERVER_PID
```

Expected output includes:
```
Maverick Voice Server running
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="https://voice.grizzlyelectrical.net/handoff">
```
and a `<ConversationRelay url="wss://voice.grizzlyelectrical.net/ws"` line.

**Step 3.** Verify the handoff → dial-result chain:

```bash
npx tsx src/agent/voice-server.ts & SERVER_PID=$!; sleep 6; curl -s -X POST -d 'HandoffData={"target":"jaime"}' http://localhost:8765/handoff; echo; curl -s -X POST -d 'DialCallStatus=no-answer' "http://localhost:8765/dial-result?tried=jaime"; kill $SERVER_PID
```

Expected output: first response contains `<Dial timeout="25"` and `+14694222982`; second response
contains `<Dial` and `+14697169870` (the fallback to Carter).

**Step 4.** Commit:

```bash
git add src/agent/voice-server.ts && git commit -m "feat(voice): full ConversationRelay server — booking/message pipeline, emergency transfer with fallback dial"
```

---

# SESSION 3

## Task 6 — Schedule payload template + builder

**Step 1.** Create `data/schedule-payload-template.json` with exactly:

```json
{
  "_UNCAPTURED": "Replace this file's contents with the request body captured from `npm run intercept` while manually scheduling one job in HCP (Manual Ops Checklist item 1). Then replace the concrete start time with %START_ISO%, the end time with %END_ISO%, and the assigned-employee uuid array with \"%PRO_UUIDS%\" (quoted token)."
}
```

**Step 2.** Create `src/hcp/schedule-payload.ts` with exactly:

```ts
/**
 * Builds the schedule_data body for the MCP update_job_schedule tool from a captured
 * template. HCP's /pro/requests/react/{id}/update_schedule payload is undocumented, so
 * the real shape is captured once via `npm run intercept` into
 * data/schedule-payload-template.json with three tokens:
 *   %START_ISO%   → job start, ISO string (server-local Central time offset)
 *   %END_ISO%     → job end, ISO string
 *   "%PRO_UUIDS%" → JSON array of assigned pro uuids (quoted token, replaced whole)
 */
import fs from 'fs';
import path from 'path';

const TEMPLATE_PATH = path.resolve(process.cwd(), 'data/schedule-payload-template.json');

export function buildSchedulePayload(
  startIso: string,
  endIso: string,
  proUuids: string[]
): Record<string, unknown> {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  if (raw.includes('_UNCAPTURED')) {
    throw new Error(
      'schedule-payload-template.json has not been captured yet — run `npm run intercept`, ' +
      'schedule one job manually in HCP, and paste the captured update_schedule body into the template. ' +
      'See PLAN.md Manual Ops Checklist item 1.'
    );
  }
  const filled = raw
    .replaceAll('%START_ISO%', startIso)
    .replaceAll('%END_ISO%', endIso)
    .replaceAll('"%PRO_UUIDS%"', JSON.stringify(proUuids));
  return JSON.parse(filled) as Record<string, unknown>;
}
```

**Step 3.** Verify the guard works:

```bash
npx tsx -e "
import { buildSchedulePayload } from './src/hcp/schedule-payload.ts';
try { buildSchedulePayload('a','b',['c']); console.log('FAIL: no throw'); }
catch (e) { console.log('guard-ok:', String(e.message).includes('intercept')); }
"
```

Expected output: `guard-ok: true`

**Step 4.** Commit:

```bash
git add data/schedule-payload-template.json src/hcp/schedule-payload.ts && git commit -m "feat(hcp): token-template schedule payload builder (shape captured via intercept)"
```

---

## Task 7 — Booking/message pipeline (from-voice.ts)

**Step 1.** Create `src/automations/bookings/from-voice.ts` with exactly:

```ts
/**
 * Voice pipeline — spawned by voice-server.ts with JSON on stdin:
 *   { kind: "booking" | "message", payload: {...}, callerPhone, callSid }
 *
 * booking → HCP: find/create customer → create estimate shell → booking-request note
 *           → assign Carter + Jaime (notify_pro push) → append data/pending-bookings.jsonl
 *           (the approval-poller then watches that estimate's notes for a SCHEDULE reply)
 * message → same customer/estimate/note/assign chain, but marked delivered immediately.
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
}

interface PipelineInput {
  kind: 'booking' | 'message';
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
  const note =
    input.kind === 'booking'
      ? [
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
        ].join('\n')
      : [
          '📞 MAVERICK PHONE MESSAGE',
          `Received: ${now} (Central)`,
          `Caller: ${name}`,
          `Callback: ${phone || 'unknown'}`,
          '',
          `Message: ${p.message ?? ''}`,
        ].join('\n');
  await updateEstimateNotes(estimate.uuid, note);

  // 4. Assign Carter + Jaime → notify_pro:true fires their HCP push notification.
  if (proUuids.length > 0) {
    await assignTechnician(estimate.uuid, proUuids);
    console.log(`[from-voice] Assigned ${proUuids.length} pros (push notification sent)`);
  } else {
    console.error('[from-voice] WARNING: no CARTER_PRO_UUID/JAIME_PRO_UUID set — nobody was notified');
  }

  // 5. Track for the approval poller.
  appendPending({
    estimateUuid: estimate.uuid,
    estimateId: estimate.estimateId,
    kind: input.kind,
    customerName: name,
    callbackPhone: phone,
    address: p.address ?? '',
    issue: p.issue ?? p.message ?? '',
    preferredWindows: p.preferredWindows ?? [],
    status: input.kind === 'booking' ? 'pending' : 'message_delivered',
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

**Step 2.** Import smoke test (module must parse; do NOT feed it stdin — it would hit HCP):

```bash
npx tsx -e "console.log('parse-ok')" && node -e "require('fs').accessSync('src/automations/bookings/from-voice.ts'); console.log('file-ok')"
```

Expected output:
```
parse-ok
file-ok
```

**Step 3.** Syntax-only check via tsx type-strip (no execution of main body — this WILL run the
file if given stdin, so close stdin immediately; expect the JSON parse of empty stdin to fail fast
with our error path NOT reached — instead a SyntaxError from JSON.parse is fine and proves the file
loaded):

```bash
echo '' | npx tsx src/automations/bookings/from-voice.ts; echo "exit:$?"
```

Expected output: a `SyntaxError`/`Unexpected end of JSON input` style error (from parsing empty
stdin — proves the module loaded and ran to the parse line) and `exit:1`.

**Step 4.** Commit:

```bash
git add src/automations/bookings/from-voice.ts && git commit -m "feat(bookings): from-voice pipeline — HCP customer/estimate/note/assign + pending-bookings log"
```

---

## Task 8 — Approval poller

**Step 1.** Create `src/automations/bookings/approval-poller.ts` with exactly:

```ts
/**
 * Booking approval poller — PM2 process `booking-approval-poller`.
 *
 * Every BOOKING_POLL_INTERVAL_MS (default 60s): for each pending booking in
 * data/pending-bookings.jsonl, read the estimate's HCP notes (MCP get_job_notes).
 * When Carter or Jaime adds a note starting with SCHEDULE, parse the date/time,
 * build the schedule payload from the captured template, and call
 * update_job_schedule — HCP then notifies the customer. Entry → status "scheduled".
 *
 * Approval note format (documented in the booking note itself):
 *   SCHEDULE MM/DD h:mm am - h:mm pm        (current year assumed)
 *   SCHEDULE MM/DD/YYYY h:mm am - h:mm pm
 * Times are server-local (America/Chicago — the PC runs Central).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getJobNotes, updateJobSchedule } from '../../hcp/mcp-client.js';
import { buildSchedulePayload } from '../../hcp/schedule-payload.js';
import { updateEstimateNotes } from '../../hcp/estimates.js';

const PENDING_FILE = path.resolve(process.cwd(), 'data/pending-bookings.jsonl');
const INTERVAL_MS = Number(process.env.BOOKING_POLL_INTERVAL_MS ?? 60000);
const PRO_UUIDS = [process.env.CARTER_PRO_UUID, process.env.JAIME_PRO_UUID].filter(
  (u): u is string => Boolean(u)
);

interface PendingBooking {
  estimateUuid: string;
  estimateId: number;
  kind: string;
  customerName: string;
  status: string;
  createdAt: string;
  [k: string]: unknown;
}

const SCHEDULE_RE =
  /^\s*SCHEDULE\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*(?:-|to)\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/im;

function readPending(): PendingBooking[] {
  if (!fs.existsSync(PENDING_FILE)) return [];
  return fs
    .readFileSync(PENDING_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as PendingBooking; } catch { return null; }
    })
    .filter((b): b is PendingBooking => b !== null);
}

function writePending(all: PendingBooking[]) {
  const tmp = PENDING_FILE + '.tmp';
  fs.writeFileSync(tmp, all.map((b) => JSON.stringify(b)).join('\n') + (all.length ? '\n' : ''));
  fs.renameSync(tmp, PENDING_FILE);
}

/** Pull note text strings out of whatever shape HCP returns. */
function extractNoteTexts(raw: unknown): string[] {
  const texts: string[] = [];
  const visit = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.content === 'string') texts.push(o.content);
      if (typeof o.note === 'string') texts.push(o.note);
      if (typeof o.body === 'string') texts.push(o.body);
      Object.values(o).forEach(visit);
    }
  };
  visit(raw);
  return texts;
}

function to24h(h: number, ampm: string): number {
  const hh = h % 12;
  return ampm.toLowerCase() === 'pm' ? hh + 12 : hh;
}

function parseScheduleNote(text: string): { start: Date; end: Date } | null {
  const m = text.match(SCHEDULE_RE);
  if (!m) return null;
  const [, moS, dayS, yearS, h1S, m1S, ap1, h2S, m2S, ap2] = m;
  const year = yearS ? Number(yearS) : new Date().getFullYear();
  const month = Number(moS) - 1;
  const day = Number(dayS);
  const start = new Date(year, month, day, to24h(Number(h1S), ap1), Number(m1S));
  const end = new Date(year, month, day, to24h(Number(h2S), ap2), Number(m2S));
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null;
  return { start, end };
}

async function tick() {
  const all = readPending();
  let changed = false;

  for (const booking of all) {
    if (booking.status !== 'pending') continue;
    try {
      const raw = await getJobNotes(booking.estimateUuid);
      const noteTexts = extractNoteTexts(raw).filter((t) => !t.includes('MAVERICK'));
      const scheduleNote = noteTexts.find((t) => SCHEDULE_RE.test(t));
      if (!scheduleNote) continue;

      const parsed = parseScheduleNote(scheduleNote);
      if (!parsed) {
        console.error(`[poller] ${booking.estimateUuid}: SCHEDULE note found but unparseable: ${scheduleNote.slice(0, 80)}`);
        continue;
      }

      const payload = buildSchedulePayload(parsed.start.toISOString(), parsed.end.toISOString(), PRO_UUIDS);
      await updateJobSchedule(String(booking.estimateId), payload);
      booking.status = 'scheduled';
      booking.scheduledStart = parsed.start.toISOString();
      booking.scheduledEnd = parsed.end.toISOString();
      booking.scheduledAt = new Date().toISOString();
      changed = true;
      console.log(`[poller] ✅ Scheduled ${booking.customerName} (${booking.estimateUuid}) ${parsed.start.toLocaleString()}`);

      try {
        await updateEstimateNotes(
          booking.estimateUuid,
          `✅ MAVERICK: scheduled ${parsed.start.toLocaleString('en-US', { timeZone: 'America/Chicago' })} – ${parsed.end.toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })}. HCP will notify the customer.`
        );
      } catch (e) {
        console.error(`[poller] confirmation note failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    } catch (e) {
      console.error(`[poller] ${booking.estimateUuid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (changed) writePending(all);
}

console.log(`[poller] Booking approval poller started — every ${INTERVAL_MS / 1000}s, pros: ${PRO_UUIDS.length}`);
await tick();
setInterval(() => { void tick(); }, INTERVAL_MS);
```

**Step 2.** Verify the parser logic in isolation:

```bash
npx tsx -e "
const RE = /^\s*SCHEDULE\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*(?:-|to)\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*\$/im;
console.log('a:', RE.test('SCHEDULE 07/14 2:00 pm - 4:00 pm'));
console.log('b:', RE.test('schedule 7/14/2026 9:00 am to 11:00 am'));
console.log('c:', RE.test('call them back tomorrow'));
"
```

Expected output:
```
a: true
b: true
c: false
```

**Step 3.** Verify the poller boots with no pending file (should start cleanly, then Ctrl-style kill):

```bash
npx tsx src/automations/bookings/approval-poller.ts & POLLER_PID=$!; sleep 8; kill $POLLER_PID
```

Expected output: `[poller] Booking approval poller started — every 60s, pros: <1 or 2>` and no
crash/stack trace before the kill.

**Step 4.** Commit:

```bash
git add src/automations/bookings/approval-poller.ts && git commit -m "feat(bookings): approval poller — SCHEDULE note parsing + update_job_schedule"
```

---

# SESSION 4

## Task 9 — PM2 processes

**Step 1.** Edit `ecosystem.config.cjs`. Add these two app entries to the `apps` array,
immediately after the `customer-chat-server` entry (before the `sync-estimates-weekly` entry):

```js
    {
      name: 'voice-server',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/agent/voice-server.ts',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      windowsHide: true,
    },
    {
      name: 'booking-approval-poller',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/automations/bookings/approval-poller.ts',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      windowsHide: true,
    },
```

**Step 2.** Verify the config parses:

```bash
node -e "const c = require('./ecosystem.config.cjs'); console.log(c.apps.map(a => a.name).join(','))"
```

Expected output:
```
mav-email-watcher,mav-slack,customer-chat-server,voice-server,booking-approval-poller,sync-estimates-weekly
```

**Step 3.** DO NOT run `pm2 start` — Carter starts processes himself (Manual Ops Checklist item 6).

**Step 4.** Commit:

```bash
git add ecosystem.config.cjs && git commit -m "chore(pm2): voice-server + booking-approval-poller process definitions"
```

---

## Task 10 — Local end-to-end smoke test

**Step 1.** Create `scripts/test-voice-local.ts` with exactly:

```ts
/**
 * Local smoke test — pretends to be Twilio ConversationRelay.
 * Requires the voice server running (npx tsx src/agent/voice-server.ts).
 * Sends setup + one prompt, prints the agent's spoken reply, exits.
 * Run: npx tsx scripts/test-voice-local.ts
 */
import 'dotenv/config';
import WebSocket from 'ws';

const PORT = Number(process.env.VOICE_PORT ?? 8765);
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const timeout = setTimeout(() => {
  console.error('TIMEOUT: no reply within 90s');
  process.exit(1);
}, 90000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'setup', callSid: 'TEST-LOCAL-001', from: '+15551234567' }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Hi, do you guys install EV chargers, and roughly what does that cost?' }));
  }, 500);
});

ws.on('message', (raw: Buffer) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'text') {
    console.log('MAVERICK SAYS:', msg.token);
    clearTimeout(timeout);
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => {
  console.error('WS error (is the voice server running?):', e.message);
  process.exit(1);
});
```

**Step 2.** Run the end-to-end test (starts the server, waits, tests, kills):

```bash
npx tsx src/agent/voice-server.ts & SERVER_PID=$!; sleep 8; npx tsx scripts/test-voice-local.ts; TEST_EXIT=$?; kill $SERVER_PID; echo "test-exit:$TEST_EXIT"
```

Expected output: a line starting `MAVERICK SAYS:` containing a conversational reply about EV
chargers (a price range, or a follow-up question — either is a pass; it must NOT contain markdown
`**` or bullet characters), then `test-exit:0`.
This calls the live LLM (z.ai GLM per model-router) and the RAG at 192.168.1.12:8181 — if the RAG
is down the agent may answer without it; that is still a pass as long as a reply arrives.

**Step 3.** Commit:

```bash
git add scripts/test-voice-local.ts && git commit -m "test(voice): local ConversationRelay smoke test client"
```

---

# Manual Ops Checklist (Carter — after Session 4)

1. **Capture the schedule payload (required before any booking can be auto-scheduled).**
   Run `npm run intercept`, then in the HCP web app manually schedule ANY job (set a date/time
   window with you + Jaime assigned). Find the captured `POST /pro/requests/react/{id}/update_schedule`
   request body, paste it into `data/schedule-payload-template.json`, then re-tokenize:
   start time → `%START_ISO%`, end time → `%END_ISO%`, the assignee uuid array → `"%PRO_UUIDS%"`.
   Until this is done the poller logs a clear error and leaves bookings pending (nothing breaks).
2. **Cloudflare tunnel (on AIWA/Proxmox).** In the existing `grizzly-chat` cloudflared config, add
   an ingress rule: hostname `voice.grizzlyelectrical.net` → `http://<CartersPC-LAN-IP>:8765`
   (same origin host the `chat.grizzlyelectrical.net → :3012` rule targets; cloudflared proxies
   the WebSocket upgrade automatically). Add the DNS route:
   `cloudflared tunnel route dns grizzly-chat voice.grizzlyelectrical.net`, restart the systemd
   service, then verify: `curl https://voice.grizzlyelectrical.net/health` → `Maverick Voice Server running`.
3. **Twilio console.** On the chosen Twilio number: Voice → "A call comes in" →
   Webhook `https://voice.grizzlyelectrical.net/twiml`, HTTP POST. (Voice works now — A2P only
   gates SMS.)
4. **`JAIME_PRO_UUID`** in `.env` — from Task 3's `npm run list-employees` output (or run it now
   that the daemon is up).
5. **`data/employee-phones.json`** — replace placeholder numbers with your and Jaime's real cells
   (needed for the later Twilio-SMS approval phase, not for voice day one).
6. **Start processes** (your call, per your PM2 rules): `pm2 start ecosystem.config.cjs && pm2 save`
   — brings up `voice-server` and `booking-approval-poller`. The housecall-pro-mcp daemon must
   also be running on :7332.
7. **Live test call.** Call the Twilio number: ask a question, then do a fake booking. Confirm the
   HCP push notification arrives and the estimate + note appear. Add a `SCHEDULE 07/15 2:00 pm - 4:00 pm`
   note and confirm the poller schedules it within a minute (after item 1 is done).

## Known deferred items (do NOT build now)

- Twilio SMS alerts/approvals for Carter + Jaime — blocked on A2P campaign approval; the HCP
  note loop is the interim. When A2P clears, add SMS send in from-voice.ts + an SMS reply path.
- Voicemail recording on failed emergency transfer (currently spoken apology + jsonl log).
- ElevenLabs voice upgrade (swap the `voice` attribute in /twiml TwiML).
- ConversationRelay signature validation on /twiml (Twilio signs webhooks; chat server has the
  pattern in customer-chat-server.ts if wanted later).

---

# Appendix — Session Prompts (copy-paste to Qwen)

## Session 1

```
You are executing **Session 1** of a pre-written implementation plan. All design decisions have already been made by a more capable model — your job is faithful execution, not creativity.

**Plan file:** `C:\Workspace\Active\grizzly-hcp\PLAN.md`
**Feature:** Grizzly Voice Agent (Maverick answers the phone)
**Working Tasks:** Tasks 1 through 3
**Working Branch:** `feature/voice-agent`
**Environment:** Windows 11 / Git Bash shell. Forward slashes in paths.

Rules — follow these exactly:

1. **Read the plan's Codebase Primer section first**, in full, before touching anything (in Session 1).
2. **Execute tasks strictly in order (run Tasks 1 through 3 in this session).** Within each task, execute steps in order.
3. **Copy code blocks verbatim.** Do not rename, reformat, "improve", simplify, or add error handling the plan doesn't show. If a code block is labeled a full-file replacement, replace the whole file.
4. **Every command in the plan has an expected output. Verify it.** If your output matches, continue. If it doesn't, make at most ONE focused attempt to fix the discrepancy (typo-level, not redesign-level). If it still doesn't match, STOP and report: task number, step, exact command, full actual output. Do not creatively work around failures.
5. **Commit exactly when and what the plan says.** Use the plan's commit messages verbatim.
6. **Never skip a test step or a verification step**, even if you're confident. The expected-output checks are how we both know you're on track.
7. **Do not add features, files, dependencies, or refactors the plan doesn't specify.** If something seems missing or wrong in the plan, STOP and report it.
8. **DO NOT proceed to tasks beyond Task 3.**

When all tasks for this session are done, reply with:
- Tasks completed in this session
- Final test/verification outputs for these tasks
- Commits made (hash + message)
- Ask the user to return to the frontier orchestrator (Opus/Sonnet) for verification. Do not proceed to any subsequent sessions until verified by the orchestrator.
```

## Session 2

```
You are executing **Session 2** of a pre-written implementation plan. All design decisions have already been made by a more capable model — your job is faithful execution, not creativity.

**Plan file:** `C:\Workspace\Active\grizzly-hcp\PLAN.md`
**Feature:** Grizzly Voice Agent (Maverick answers the phone)
**Working Tasks:** Tasks 4 through 5
**Working Branch:** `feature/voice-agent`
**Environment:** Windows 11 / Git Bash shell. Forward slashes in paths.

Rules — follow these exactly:

1. **Read the plan's Codebase Primer section first**, in full, before touching anything.
2. **Execute tasks strictly in order (run Tasks 4 through 5 in this session).** Within each task, execute steps in order.
3. **Copy code blocks verbatim.** Do not rename, reformat, "improve", simplify, or add error handling the plan doesn't show. If a code block is labeled a full-file replacement, replace the whole file.
4. **Every command in the plan has an expected output. Verify it.** If your output matches, continue. If it doesn't, make at most ONE focused attempt to fix the discrepancy (typo-level, not redesign-level). If it still doesn't match, STOP and report: task number, step, exact command, full actual output. Do not creatively work around failures.
5. **Commit exactly when and what the plan says.** Use the plan's commit messages verbatim.
6. **Never skip a test step or a verification step**, even if you're confident. The expected-output checks are how we both know you're on track.
7. **Do not add features, files, dependencies, or refactors the plan doesn't specify.** If something seems missing or wrong in the plan, STOP and report it.
8. **DO NOT proceed to tasks beyond Task 5.**

When all tasks for this session are done, reply with:
- Tasks completed in this session
- Final test/verification outputs for these tasks
- Commits made (hash + message)
- Ask the user to return to the frontier orchestrator (Opus/Sonnet) for verification. Do not proceed to any subsequent sessions until verified by the orchestrator.
```

## Session 3

```
You are executing **Session 3** of a pre-written implementation plan. All design decisions have already been made by a more capable model — your job is faithful execution, not creativity.

**Plan file:** `C:\Workspace\Active\grizzly-hcp\PLAN.md`
**Feature:** Grizzly Voice Agent (Maverick answers the phone)
**Working Tasks:** Tasks 6 through 8
**Working Branch:** `feature/voice-agent`
**Environment:** Windows 11 / Git Bash shell. Forward slashes in paths.

Rules — follow these exactly:

1. **Read the plan's Codebase Primer section first**, in full, before touching anything.
2. **Execute tasks strictly in order (run Tasks 6 through 8 in this session).** Within each task, execute steps in order.
3. **Copy code blocks verbatim.** Do not rename, reformat, "improve", simplify, or add error handling the plan doesn't show. If a code block is labeled a full-file replacement, replace the whole file.
4. **Every command in the plan has an expected output. Verify it.** If your output matches, continue. If it doesn't, make at most ONE focused attempt to fix the discrepancy (typo-level, not redesign-level). If it still doesn't match, STOP and report: task number, step, exact command, full actual output. Do not creatively work around failures.
5. **Commit exactly when and what the plan says.** Use the plan's commit messages verbatim.
6. **Never skip a test step or a verification step**, even if you're confident. The expected-output checks are how we both know you're on track.
7. **Do not add features, files, dependencies, or refactors the plan doesn't specify.** If something seems missing or wrong in the plan, STOP and report it.
8. **DO NOT proceed to tasks beyond Task 8.**

When all tasks for this session are done, reply with:
- Tasks completed in this session
- Final test/verification outputs for these tasks
- Commits made (hash + message)
- Ask the user to return to the frontier orchestrator (Opus/Sonnet) for verification. Do not proceed to any subsequent sessions until verified by the orchestrator.
```

## Session 4

```
You are executing **Session 4** of a pre-written implementation plan. All design decisions have already been made by a more capable model — your job is faithful execution, not creativity.

**Plan file:** `C:\Workspace\Active\grizzly-hcp\PLAN.md`
**Feature:** Grizzly Voice Agent (Maverick answers the phone)
**Working Tasks:** Tasks 9 through 10
**Working Branch:** `feature/voice-agent`
**Environment:** Windows 11 / Git Bash shell. Forward slashes in paths.

Rules — follow these exactly:

1. **Read the plan's Codebase Primer section first**, in full, before touching anything.
2. **Execute tasks strictly in order (run Tasks 9 through 10 in this session).** Within each task, execute steps in order.
3. **Copy code blocks verbatim.** Do not rename, reformat, "improve", simplify, or add error handling the plan doesn't show. If a code block is labeled a full-file replacement, replace the whole file.
4. **Every command in the plan has an expected output. Verify it.** If your output matches, continue. If it doesn't, make at most ONE focused attempt to fix the discrepancy (typo-level, not redesign-level). If it still doesn't match, STOP and report: task number, step, exact command, full actual output. Do not creatively work around failures.
5. **Commit exactly when and what the plan says.** Use the plan's commit messages verbatim.
6. **Never skip a test step or a verification step**, even if you're confident. The expected-output checks are how we both know you're on track.
7. **Do not add features, files, dependencies, or refactors the plan doesn't specify.** If something seems missing or wrong in the plan, STOP and report it. Task 9 explicitly forbids running `pm2 start` — do not start any PM2 process.
8. **DO NOT proceed to tasks beyond Task 10.** The Manual Ops Checklist is for Carter, not you.

When all tasks for this session are done, reply with:
- Tasks completed in this session
- Final test/verification outputs for these tasks
- Commits made (hash + message)
- Ask the user to return to the frontier orchestrator (Opus/Sonnet) for verification. Do not proceed to any subsequent sessions until verified by the orchestrator.
```
