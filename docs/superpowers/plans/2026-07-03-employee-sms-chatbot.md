# Employee SMS Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `customer-chat-server.ts` to handle a second Twilio number that routes inbound employee texts to the Maverick agent (`employee` channel), with phone-number-based allowlist and the same `[ESTIMATE_READY]` auto-submit flow used by the customer channel.

**Architecture:** Add `To`-based routing in the existing HTTP server — customer number → customer channel (unchanged), employee number → employee channel (new). Employee access is gated by `data/employee-phones.json`, hot-reloaded on each request. The employee agent flow mirrors the customer flow exactly except no `sendEstimate()` call (estimates stay internal for Carter to review and send).

**Tech Stack:** TypeScript, tsx, Node.js `http`, Twilio Node SDK (`twilio` ^6), `from-chat.ts` subprocess pipeline.

---

### Task 1: Scaffold env var + allowlist file

**Files:**
- Create: `data/employee-phones.json`
- Modify: `.env.example`

- [ ] **Step 1: Create the employee allowlist file**

Create `data/employee-phones.json` with this structure (fill in real E.164 phone numbers):

```json
{
  "+1XXXXXXXXXX": { "name": "Carter", "role": "owner" },
  "+1XXXXXXXXXX": { "name": "Jaime", "role": "owner" }
}
```

- [ ] **Step 2: Add env var to .env.example**

In `src/server/customer-chat-server.ts`, the header comment lists required env vars. Add the employee number to `.env.example` after the existing Twilio vars:

```
# Customer SMS chatbot
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=       # E.164 format — customer-facing number
CUSTOMER_CHAT_PORT=3012
PUBLIC_URL=                # Tailscale Funnel URL, e.g. https://aiwa.tailf72e3f.ts.net

# Employee SMS chatbot (same server, same port, different number)
EMPLOYEE_PHONE_NUMBER=     # E.164 format — internal employee number
```

- [ ] **Step 3: Commit**

```bash
git add data/employee-phones.json .env.example
git commit -m "feat: scaffold employee SMS allowlist and env var"
```

---

### Task 2: Add SMS format rules to EMPLOYEE_INSTRUCTIONS

**Files:**
- Modify: `src/agent/resolver.ts`

The existing `EMPLOYEE_INSTRUCTIONS` (line 96) says Carter must push "BUILD IT" — that's the MCC flow. For SMS the employee confirms in conversation and the server auto-submits. Also needs SMS format rules like the customer channel has.

- [ ] **Step 1: Update EMPLOYEE_INSTRUCTIONS**

In `src/agent/resolver.ts`, replace the `EMPLOYEE_INSTRUCTIONS` constant (lines 96–114) with:

```typescript
const EMPLOYEE_INSTRUCTIONS = `You are Maverick, the field assistant for Grizzly Electrical Solutions employees.

You help electricians scope jobs, look up pricing, check schedule, and build estimates — all via text message.

## What you can do
- Look up customers, prior estimates, and pricing
- Search the price book for service items and help scope jobs
- Check schedule and job details
- Check HCP messages related to jobs
- Build estimate scopes with smart pricebook matching
- Answer electrical code, NEC, and Oncor procedure questions

## Estimate flow
Scope the job through conversation. When you have a complete scope and all required info, summarize it and ask the employee to confirm. Once they confirm ("yes", "build it", "go ahead"), emit the estimate block immediately:

[ESTIMATE_READY]{"scope":"<concise job description>","customerName":"<name>","customerEmail":"<email>","customerPhone":"<customer phone>","depositPercent":0}[/ESTIMATE_READY]

The server will create the estimate in HCP and notify you. Do NOT send a confirmation message after emitting the block — the server handles that.

## TEXT RULES (SMS — keep these always)
- Keep every response under 320 characters where possible
- No markdown, no bullet points, no headers — plain text only
- One question per message
- Be concise and field-focused — electricians are on job sites

## Smart pricebook matching
Use search_pricebook for each work item as scope is discussed. When no match is found, note it and continue — flag it in the scope description.`;
```

- [ ] **Step 2: Verify resolveInstructions still returns EMPLOYEE_INSTRUCTIONS for employee channel**

Line 203 should still read:
```typescript
if (channel === 'employee') return EMPLOYEE_INSTRUCTIONS;
```
No change needed here — confirm it's still there.

- [ ] **Step 3: Commit**

```bash
git add src/agent/resolver.ts
git commit -m "feat: update employee instructions for SMS channel"
```

---

### Task 3: Extend customer-chat-server.ts with employee routing

**Files:**
- Modify: `src/server/customer-chat-server.ts`

This is the main task. Read the existing file fully before editing — every change below must fit the existing structure. The changes are:
1. Add `EMPLOYEE_PHONE_NUMBER` constant
2. Add `loadEmployeePhones()` with hot-reload + parse-error safety
3. Add `employeeAgent` singleton
4. Add `employeeSessions` Map + `getEmployeeSession()`
5. Update `sendSms()` to accept a `from` parameter (update all existing call sites)
6. Update `spawnPipeline()` to accept a log-prefix parameter
7. Add `handleEmployee()` async function
8. Update the HTTP request handler to route on `params.To`
9. Update startup warnings

- [ ] **Step 1: Add employee env constant and agent singleton**

After line 21 (`const PUBLIC_URL = ...`), add:

```typescript
const EMPLOYEE_PHONE_NUMBER = process.env.EMPLOYEE_PHONE_NUMBER ?? '';
```

After line 28 (`const agent = createMaverickAgent('customer');`), add:

```typescript
const employeeAgent = createMaverickAgent('employee');
```

- [ ] **Step 2: Add loadEmployeePhones()**

After the `try { mkdirSync(...) }` block (line 32), add:

```typescript
interface EmployeeRecord {
  name: string;
  role: string;
}

function loadEmployeePhones(): Record<string, EmployeeRecord> {
  try {
    const raw = require('fs').readFileSync('data/employee-phones.json', 'utf8');
    return JSON.parse(raw) as Record<string, EmployeeRecord>;
  } catch (e) {
    console.error('[employee] Failed to load employee-phones.json:', e);
    return {};
  }
}
```

> Note: `require('fs').readFileSync` is used (not the already-imported `appendFileSync`) to keep the import minimal. Alternatively, add `readFileSync` to the existing `import { appendFileSync, mkdirSync } from 'fs'` import — that's cleaner:

Update line 11 to:
```typescript
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
```

Then write `loadEmployeePhones()` as:

```typescript
interface EmployeeRecord {
  name: string;
  role: string;
}

function loadEmployeePhones(): Record<string, EmployeeRecord> {
  try {
    const raw = readFileSync('data/employee-phones.json', 'utf8');
    return JSON.parse(raw) as Record<string, EmployeeRecord>;
  } catch (e) {
    console.error('[employee] Failed to load employee-phones.json:', e);
    return {};
  }
}
```

- [ ] **Step 3: Add employee session map**

After the `const sessions = new Map<string, CustomerSession>();` line (line 41), add:

```typescript
const employeeSessions = new Map<string, CustomerSession>();

function getEmployeeSession(phone: string): CustomerSession {
  const existing = employeeSessions.get(phone);
  if (existing && Date.now() - existing.lastActivity < SESSION_TTL_MS) {
    existing.lastActivity = Date.now();
    return existing;
  }
  const fresh: CustomerSession = { phone, history: [], lastActivity: Date.now() };
  employeeSessions.set(phone, fresh);
  return fresh;
}
```

- [ ] **Step 4: Update sendSms() to accept a from parameter**

Change line 88–90 from:
```typescript
async function sendSms(to: string, body: string): Promise<void> {
  await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to, body });
}
```
To:
```typescript
async function sendSms(to: string, body: string, from: string = TWILIO_PHONE_NUMBER): Promise<void> {
  await twilioClient.messages.create({ from, to, body });
}
```

No existing call sites need updating — the default preserves customer behaviour.

- [ ] **Step 5: Update spawnPipeline() to accept a log prefix**

Change line 68:
```typescript
function spawnPipeline(
  payload: unknown,
): Promise<{ success: boolean; estimateUrl?: string; estimateUuid?: string; error?: string }> {
```
To:
```typescript
function spawnPipeline(
  payload: unknown,
  logPrefix = 'customer',
): Promise<{ success: boolean; estimateUrl?: string; estimateUuid?: string; error?: string }> {
```

Change line 80:
```typescript
proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[customer:pipeline] ${d}`));
```
To:
```typescript
proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[${logPrefix}:pipeline] ${d}`));
```

- [ ] **Step 6: Add handleEmployee() function**

Add this function after the `sendSms` function (before the `const server = http.createServer(...)` line):

```typescript
async function handleEmployee(fromPhone: string, messageBody: string): Promise<void> {
  const phones = loadEmployeePhones();
  const record = phones[fromPhone];

  if (!record) {
    await sendSms(
      fromPhone,
      "This number isn't authorized to use the Grizzly employee assistant. Contact Carter to request access.",
      EMPLOYEE_PHONE_NUMBER,
    ).catch(() => {});
    console.warn(`[employee] Rejected unauthorized number: ${fromPhone}`);
    return;
  }

  console.log(`[employee] ${record.name} (${record.role}) ${fromPhone}: "${messageBody.slice(0, 60)}"`);

  const session = getEmployeeSession(fromPhone);
  const contextLines = session.history
    .map(m => `${m.role === 'user' ? 'Employee' : 'Maverick'}: ${m.content}`)
    .join('\n');
  const fullPrompt = contextLines ? `${contextLines}\nEmployee: ${messageBody}` : messageBody;

  let agentReply = '';
  try {
    const result = await employeeAgent.generate(fullPrompt);
    agentReply = typeof result.text === 'string' ? result.text : '';
  } catch (e) {
    console.error('[employee] Agent error:', e);
    await sendSms(fromPhone, 'Something went wrong. Try again in a moment.', EMPLOYEE_PHONE_NUMBER).catch(() => {});
    return;
  }

  session.history.push({ role: 'user', content: messageBody });
  const estimateMatch = agentReply.match(ESTIMATE_READY_RE);

  if (estimateMatch) {
    const visibleReply = agentReply.replace(ESTIMATE_READY_RE, '').trim();
    const sendText = visibleReply || 'Building the estimate now ⚡';
    session.history.push({ role: 'assistant', content: sendText });

    await sendSms(fromPhone, sendText, EMPLOYEE_PHONE_NUMBER).catch(e =>
      console.error('[employee] SMS error:', e),
    );

    try {
      const payload = JSON.parse(estimateMatch[1]) as Record<string, unknown>;
      const est = await spawnPipeline(payload, 'employee');

      if (est.success && est.estimateUuid) {
        session.estimateUuid = est.estimateUuid;

        try {
          appendFileSync(
            'data/employee-sessions.jsonl',
            JSON.stringify({
              phone: fromPhone,
              name: record.name,
              role: record.role,
              estimateUuid: est.estimateUuid,
              ts: Date.now(),
            }) + '\n',
          );
        } catch { /* non-fatal */ }

        const transcript = session.history
          .map(m => `[${m.role === 'user' ? record.name : 'Maverick'}] ${m.content}`)
          .join('\n');
        await updateEstimateNotes(
          est.estimateUuid,
          `=== Employee SMS Transcript (${record.name}) ===\n${transcript}`,
        ).catch(e => console.warn('[employee] Could not save transcript:', e));

        await sendSms(
          fromPhone,
          `Estimate created ✅ UUID: ${est.estimateUuid}${est.estimateUrl ? '\n' + est.estimateUrl : ''}`,
          EMPLOYEE_PHONE_NUMBER,
        ).catch(() => {});

        console.log(`[employee] Estimate created: ${est.estimateUrl}`);
      } else {
        await sendSms(
          fromPhone,
          'Pipeline failed — check the server logs.',
          EMPLOYEE_PHONE_NUMBER,
        ).catch(() => {});
        console.error('[employee] Pipeline failed:', est.error);
      }
    } catch (e) {
      console.error('[employee] Post-reply error:', e);
      await sendSms(fromPhone, 'Hit a snag — check server logs.', EMPLOYEE_PHONE_NUMBER).catch(() => {});
    }
  } else {
    session.history.push({ role: 'assistant', content: agentReply });
    if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
    await sendSms(fromPhone, agentReply, EMPLOYEE_PHONE_NUMBER).catch(e =>
      console.error('[employee] SMS error:', e),
    );
  }
}
```

- [ ] **Step 7: Update the HTTP request handler to route on To field**

Replace the `setImmediate` block (lines 134–222) with a version that routes based on `params.To`:

```typescript
  setImmediate(async () => {
    const toPhone = params.To ?? '';
    if (toPhone === EMPLOYEE_PHONE_NUMBER && EMPLOYEE_PHONE_NUMBER) {
      await handleEmployee(fromPhone, messageBody);
    } else {
      // Customer channel (default)
      const session = getSession(fromPhone);
      const contextLines = session.history
        .map(m => `${m.role === 'user' ? 'Customer' : 'Grizzly'}: ${m.content}`)
        .join('\n');
      const fullPrompt = contextLines ? `${contextLines}\nCustomer: ${messageBody}` : messageBody;

      let agentReply = '';
      try {
        const result = await agent.generate(fullPrompt);
        agentReply = typeof result.text === 'string' ? result.text : '';
      } catch (e) {
        console.error('[customer] Agent error:', e);
        await sendSms(fromPhone, "Sorry, something went wrong on our end. Try again in a moment!")
          .catch(() => {});
        return;
      }

      session.history.push({ role: 'user', content: messageBody });
      const estimateMatch = agentReply.match(ESTIMATE_READY_RE);

      if (estimateMatch) {
        const visibleReply = agentReply.replace(ESTIMATE_READY_RE, '').trim();
        const sendText = visibleReply || 'Building your estimate now ⚡';
        session.history.push({ role: 'assistant', content: sendText });

        await sendSms(fromPhone, sendText).catch(e => console.error('[customer] SMS error:', e));

        try {
          const payload = JSON.parse(estimateMatch[1]) as Record<string, unknown>;
          payload.customerPhone = fromPhone;

          if (payload.siteWalk) {
            payload.scope = 'Initial site assessment visit with site assessment fee waiver';
            delete payload.lineItems;
          }

          const est = await spawnPipeline(payload);

          if (est.success && est.estimateUuid) {
            session.estimateUuid = est.estimateUuid;
            try {
              appendFileSync(
                'data/customer-sessions.jsonl',
                JSON.stringify({ phone: fromPhone, estimateUuid: est.estimateUuid, ts: Date.now() }) + '\n',
              );
            } catch { /* non-fatal */ }

            const transcript = buildTranscript(session.history);
            await updateEstimateNotes(
              est.estimateUuid,
              `=== Customer SMS Transcript ===\n${transcript}`,
            ).catch(e => console.warn('[customer] Could not save transcript:', e));

            await sendEstimate(est.estimateUuid, {
              phone: fromPhone,
              email: typeof payload.customerEmail === 'string' ? payload.customerEmail : undefined,
              customerName: typeof payload.customerName === 'string' ? payload.customerName : undefined,
            }).catch(e => console.warn('[customer] Could not send estimate:', e));

            await sendSms(
              fromPhone,
              'Sent! Check your text/email for the estimate. Just approve and sign — takes 30 seconds — and you\'re on the books. ✅',
            ).catch(() => {});
            console.log(`[customer] Estimate created and sent: ${est.estimateUrl}`);
          } else {
            await sendSms(
              fromPhone,
              "Hmm, something went wrong building the estimate. Carter will reach out shortly!",
            ).catch(() => {});
            console.error('[customer] Pipeline failed:', est.error);
          }
        } catch (e) {
          console.error('[customer] Post-reply error:', e);
          await sendSms(
            fromPhone,
            'Sorry, we hit a snag. Carter will follow up with you directly!',
          ).catch(() => {});
        }
      } else {
        session.history.push({ role: 'assistant', content: agentReply });
        if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
        await sendSms(fromPhone, agentReply).catch(e => console.error('[customer] SMS error:', e));
      }
    }
  });
```

- [ ] **Step 8: Update startup warnings**

At the bottom of the file, update the `server.listen` callback (lines 225–230):

```typescript
server.listen(PORT, () => {
  console.log(`[server] SMS chatbot listening on port ${PORT}`);
  if (!TWILIO_ACCOUNT_SID) console.warn('[server] TWILIO_ACCOUNT_SID not set');
  if (!TWILIO_AUTH_TOKEN)  console.warn('[server] TWILIO_AUTH_TOKEN not set');
  if (!TWILIO_PHONE_NUMBER) console.warn('[server] TWILIO_PHONE_NUMBER not set — customer channel inactive');
  if (!EMPLOYEE_PHONE_NUMBER) console.warn('[server] EMPLOYEE_PHONE_NUMBER not set — employee channel inactive');
});
```

- [ ] **Step 9: Update file header comment**

Replace lines 1–6:

```typescript
/**
 * SMS chatbot server — Twilio webhook → agent → TwiML reply.
 * Handles two numbers on one port: customer channel + employee channel.
 * Start: npx tsx src/server/customer-chat-server.ts
 * Env:   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
 *        EMPLOYEE_PHONE_NUMBER, CUSTOMER_CHAT_PORT (default 3012), PUBLIC_URL
 * Allowlist: data/employee-phones.json  { "+1...": { name, role } }
 */
```

- [ ] **Step 10: Commit**

```bash
git add src/server/customer-chat-server.ts
git commit -m "feat: add employee SMS channel with allowlist routing"
```

---

### Task 4: Deploy and smoke test

**Files:**
- Modify: `/opt/grizzly-hcp/.env` (on AIWA via SSH)

- [ ] **Step 1: Add EMPLOYEE_PHONE_NUMBER to server .env**

SSH to AIWA and add the new Twilio employee number to `/opt/grizzly-hcp/.env`:

```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12 \
  "echo 'EMPLOYEE_PHONE_NUMBER=+1XXXXXXXXXX' >> /opt/grizzly-hcp/.env"
```

Replace `+1XXXXXXXXXX` with the actual purchased Twilio number.

- [ ] **Step 2: Copy employee-phones.json to server with real numbers**

```bash
scp -i C:/Users/carte/.ssh/id_ed25519_proxmox \
  "C:/Workspace/Active/grizzly-hcp/data/employee-phones.json" \
  root@192.168.1.12:/opt/grizzly-hcp/data/employee-phones.json
```

Then SSH in and replace the placeholder numbers with real E.164 phone numbers.

- [ ] **Step 3: Pull latest code and reload PM2**

```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12 \
  "cd /opt/grizzly-hcp && git pull origin main && pm2 reload customer-chat-server --update-env && pm2 save"
```

Expected output: `[PM2] [customer-chat-server](0) ✓`

- [ ] **Step 4: Verify health endpoint still works**

```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12 \
  "curl -s https://aiwa.tailf72e3f.ts.net/health"
```

Expected: `customer-chat-server ok`

- [ ] **Step 5: Smoke test — unauthorized number rejection**

Send a test POST to the webhook simulating a text from an unknown number to the employee number. Replace `+19999999999` with your EMPLOYEE_PHONE_NUMBER and `+10000000000` with a number NOT in employee-phones.json:

```bash
# Get Twilio signature for test (use Twilio CLI or skip signature check in dev)
curl -s -X POST https://aiwa.tailf72e3f.ts.net/webhook/twilio \
  -d "From=%2B10000000000&To=%2B19999999999&Body=hello"
```

Check PM2 logs:
```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12 \
  "pm2 logs customer-chat-server --lines 20 --nostream"
```

Expected log line: `[employee] Rejected unauthorized number: +10000000000`

> Note: Twilio signature validation will reject the curl test above unless you provide a valid `X-Twilio-Signature` header. To test routing logic without a real Twilio signature, text the employee number from a phone not in the allowlist and verify the rejection SMS is received.

- [ ] **Step 6: Live test — authorized number**

Text the employee Twilio number from Carter's phone with a job scoping question (e.g. "I need to scope a panel upgrade at a house in Frisco, 200A, homeowner wants EV charger added too"). Verify:
- Response comes back from the employee number
- Agent responds in plain text, no markdown
- Conversation flows correctly
- `pm2 logs customer-chat-server` shows `[employee]` log lines

- [ ] **Step 7: Commit deployment notes**

No code change — just push if there's anything uncommitted:

```bash
git push origin main
```

---

## Post-Implementation Notes

- **A2P registration for the employee number:** Purchase the number in the Twilio console, then register it to the same A2P brand (already approved). Create a new campaign for internal/employee use. Point the SMS webhook in the Twilio console to `https://aiwa.tailf72e3f.ts.net/webhook/twilio`.
- **Adding employees later:** Edit `data/employee-phones.json` on the server — no restart needed. Hot-reloaded on each request.
- **Role-based tool filtering:** When ready to enforce roles, add a `resolveEmployeeTools(role)` function in `resolver.ts` and pass the role into `createMaverickAgent()`.
