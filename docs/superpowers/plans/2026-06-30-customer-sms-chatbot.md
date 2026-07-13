# Customer SMS Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a customer-facing Twilio SMS chatbot that triages electrical job requests, gives rough price ranges, and auto-creates + sends HCP estimates when customers want to book.

**Architecture:** A slim Node.js HTTP server on port 3012 receives Twilio webhook POSTs, routes them through a new `customer` channel variant of the Maverick agent, and replies via TwiML XML. When the agent emits an `[ESTIMATE_READY]` block, the server spawns `from-chat.ts` (same pattern as the Slack bot), then calls `sendEstimate()` and saves the transcript to the estimate notes. Cloudflare Tunnel exposes the server at `chat.grizzlyelectrical.net`.

**Tech Stack:** TypeScript/tsx, Mastra Agent (`@mastra/core/agent`), `twilio` npm SDK, existing `src/hcp/estimates.ts` HTTP client, `from-chat.ts` subprocess pipeline, PM2, Cloudflare Tunnel

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/server/customer-chat-server.ts` | Create | HTTP server, Twilio webhook, session store, pipeline orchestration |
| `src/agent/resolver.ts` | Modify | Add `'customer'` channel: full system prompt + tool allowlist |
| `src/hcp/estimates.ts` | Modify | Add `sendEstimate()` and `updateEstimateNotes()` |
| `ecosystem.config.cjs` | Modify | Add `customer-chat-server` PM2 process |
| `.env.example` | Modify | Add `TWILIO_*` vars |

**Reused without modification:**
- `src/agent/index.ts` → `createMaverickAgent('customer')` (new channel)
- `src/automations/estimates/from-chat.ts` → spawned as subprocess (same as Slack bot)
- `src/hcp/client.ts` → `hcpPost`, `hcpPatch` for new HCP functions

---

## Task 1: Install Twilio SDK and scaffold env vars

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `.env.example`

- [ ] **Step 1: Install twilio SDK**

```bash
npm install twilio
```

Expected output: `added 1 package` (or similar — `twilio` should now appear in `package.json` dependencies)

- [ ] **Step 2: Add env vars to `.env.example`**

Append to `.env.example`:

```
# Customer SMS chatbot
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=       # E.164 format, e.g. +14695551234
CUSTOMER_CHAT_PORT=3012
```

- [ ] **Step 3: Add the same vars to your `.env` file with real values**

Copy the four lines above into `.env` and fill in your Twilio credentials. The phone number comes from your Twilio console once a number is provisioned.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add twilio SDK and customer chat env vars"
```

---

## Task 2: Add `sendEstimate()` and `updateEstimateNotes()` to HCP client

**Files:**
- Modify: `src/hcp/estimates.ts`

The HCP "Send Estimate" button triggers an API call that emails + texts the estimate to the customer. We need to intercept that endpoint, then implement it.

- [ ] **Step 1: Intercept the HCP send estimate endpoint**

Run the HCP intercept tool:
```bash
npm run intercept
```

In the browser session that opens, navigate to any existing estimate in HCP and click the **"Send Estimate"** button. Watch the terminal output for the request captured. Note:
- The HTTP method (POST/PUT/PATCH)
- The URL path (something like `/pro/estimates/{uuid}/send` or `/alpha/estimates/{uuid}/communicate`)
- Any request body fields

Do the same for **"Edit Estimate" → save** to find the notes/description update endpoint.

- [ ] **Step 2: Implement `sendEstimate()` in `src/hcp/estimates.ts`**

Add after the `addEstimateOption` function (around line 70):

```typescript
/**
 * Send an estimate to the customer via HCP (emails + texts them a link to approve).
 * Endpoint discovered via npm run intercept — adjust path if HCP changes it.
 */
export async function sendEstimate(estimateUuid: string): Promise<void> {
  // Replace with the exact path + body you captured from intercept:
  await hcpPost(`/pro/estimates/${estimateUuid}/send`, {});
}
```

> **Note:** Fill in the exact endpoint path and body from what you captured in Step 1.
> Common patterns seen in this codebase: `/pro/...` (form-urlencoded) or `/alpha/...` (JSON).
> If the endpoint uses form-urlencoded, use `hcpPostForm` instead of `hcpPost`.

- [ ] **Step 3: Implement `updateEstimateNotes()` in `src/hcp/estimates.ts`**

Add immediately after `sendEstimate`:

```typescript
/**
 * Write conversation transcript to the estimate's internal notes field.
 * Carter and Jaime see this when they open the estimate in HCP.
 */
export async function updateEstimateNotes(
  estimateUuid: string,
  notes: string
): Promise<void> {
  // Adjust path/method/field name from intercept if needed:
  await hcpPatch(`/alpha/estimates/${estimateUuid}`, { note: notes });
}
```

- [ ] **Step 4: Export check — verify new functions are accessible**

```bash
npx tsx -e "import { sendEstimate, updateEstimateNotes } from './src/hcp/estimates.js'; console.log(typeof sendEstimate, typeof updateEstimateNotes);"
```

Expected output: `function function`

- [ ] **Step 5: Commit**

```bash
git add src/hcp/estimates.ts
git commit -m "feat(hcp): add sendEstimate and updateEstimateNotes"
```

---

## Task 3: Add 'customer' channel to resolver

**Files:**
- Modify: `src/agent/resolver.ts`

The customer channel gets a completely different system prompt (no Maverick technical operator instructions) and a minimal tool allowlist (pricebook lookup only — no operator tools exposed to customers).

- [ ] **Step 1: Add `'customer'` to the Channel type**

In `src/agent/resolver.ts`, find:
```typescript
export type Channel = 'text' | 'voice' | 'cli' | 'employee' | 'slack' | 'advisory';
```

Replace with:
```typescript
export type Channel = 'text' | 'voice' | 'cli' | 'employee' | 'slack' | 'advisory' | 'customer';
```

- [ ] **Step 2: Add the customer tool allowlist**

After the `ADVISORY_INCLUDED` set, add:

```typescript
// Customer SMS surface: read-only pricing lookups only.
// Estimate creation happens via [ESTIMATE_READY] block → server-side subprocess.
const CUSTOMER_INCLUDED = new Set([
  'search_pricebook',
  'lookup_pricing',
]);
```

- [ ] **Step 3: Add customer instructions constant**

Add after the `EMPLOYEE_INSTRUCTIONS` constant (before `resolveTools`):

```typescript
const CUSTOMER_INSTRUCTIONS = `You are the virtual assistant for Grizzly Electrical Solutions — a licensed electrical contractor in the Dallas/Fort Worth area.

You talk to potential customers via text message. Be friendly, warm, and direct. You are NOT a robot — you're helpful like a knowledgeable local contractor who happens to text fast.

## TEXT RULES
- Keep every message under 300 characters (2 SMS segments max)
- Never use markdown, bullet points, or headers — this is a text conversation
- Light emoji is fine (👋 🔌 🤙 ✅) — don't overdo it
- One question per message. Never dump a list of questions on them.
- Sign important messages as "— Grizzly Electrical" where it feels natural

## YOUR FLOW

### 1. GREET (first message only)
"Hey! 👋 Grizzly Electrical here. What can we help you with today?"

### 2. TRIAGE — nail down the job category
Ask: "What are we working on?"
Then map their answer to one of these:
- outlets/receptacles
- tripping breaker or electrical troubleshoot
- light fixtures
- panel or service upgrade
- low voltage (cameras, Ethernet, smart home, EV charger)
- remodel or commercial build → go to SITE WALK path immediately

### 3. FOLLOW-UP (1–2 questions max, based on category)

Outlets: "How many outlets, and are they in a kitchen, bathroom, outdoor, or regular room?"
Tripping breaker: "Which circuit is it — like HVAC, kitchen, or something else? And does it trip under load or randomly?"
Light fixtures: "How many, and are you swapping existing fixtures or adding at a new location?"
Panel/service upgrade: "What size is your current panel — 100A, 150A, or 200A? And what's driving the upgrade?"
Low voltage: "What specifically — cameras, Ethernet, smart home, or EV charger? And how many locations?"

Make reasonable assumptions rather than asking unnecessary questions. If they say "replace an outlet in the kitchen" — you know it's GFCI, probably 1 outlet, standard voltage. Only ask when the answer would materially change the price.

### 4. ESTIMATE — give a dollar range
Use search_pricebook and lookup_pricing to get accurate ranges from Grizzly's actual pricebook.
Format: "A job like that typically runs $X–$Y. That covers parts and labor." 
Always give a range, not a single number.

### 5. CONFIRM
"Does that range work for you? Want to get on the schedule?"
- No: "No worries — reach out anytime! 🤙"
- Yes: go to COLLECT

### 6. COLLECT — gather info one field at a time
Ask in this order (stop after each, wait for their reply):
1. "What's your full name?"
2. "What's the service address?"
3. "And your email — for the estimate?"
4. "Last one — how'd you hear about us?"
(You already have their phone number — never ask for it)

### 7. CREATE — emit the estimate block
Once you have all four pieces of info, emit this block IMMEDIATELY (no extra text before it):

[ESTIMATE_READY]{"scope":"<1-2 sentence job description with category and follow-up answers>","customerName":"<name>","customerEmail":"<email>","customerPhone":"<their phone — already known from SMS>","depositPercent":0}[/ESTIMATE_READY]

Then send this message: "Perfect! I'm building your estimate now — takes just a second. ⚡"

### 8. SENT (server will send this after pipeline succeeds)
The server handles this — do NOT send a "sent" message yourself after emitting ESTIMATE_READY.

## SITE WALK PATH (remodel or commercial)
"That sounds like a bigger project — we'd want to come out and take a look before quoting you a solid number. The site visit is free. Want to get that on the calendar?"
- Yes: go to COLLECT (same 4 questions)
- No: "No problem! Reach out anytime. 🤙"

Once you have their info, emit:
[ESTIMATE_READY]{"scope":"Initial site assessment - remodel/commercial project","customerName":"<name>","customerEmail":"<email>","customerPhone":"<phone>","depositPercent":0,"siteWalk":true}[/ESTIMATE_READY]

## WHAT YOU NEVER DO
- Ask for their phone number (you already have it)
- Give prices without using search_pricebook first
- Use electrical jargon: say "breaker box" not "load center", "outlet" not "receptacle", "main panel" not "service entrance"
- Send a "sent" message after emitting ESTIMATE_READY (server handles that)
- Emit ESTIMATE_READY before you have name, address, email, and "how'd you hear from us"

## PRICING
Use search_pricebook for every estimate. Always give a range. When in doubt, go wider.
The HCP estimate will be created at the HIGH end of the range — better to come in under.`;
```

- [ ] **Step 4: Wire the customer channel into `resolveTools` and `resolveInstructions`**

In `resolveTools`, add a customer case before the final `return allTools`:

```typescript
export function resolveTools<T extends Record<string, unknown>>(
  channel: Channel,
  allTools: T
): Partial<T> {
  if (channel === 'advisory') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => ADVISORY_INCLUDED.has(name))
    ) as Partial<T>;
  }
  if (channel === 'customer') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => CUSTOMER_INCLUDED.has(name))
    ) as Partial<T>;
  }
  if (channel === 'voice') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => !VOICE_EXCLUDED.has(name))
    ) as Partial<T>;
  }
  if (channel === 'employee') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => !EMPLOYEE_EXCLUDED.has(name))
    ) as Partial<T>;
  }
  return allTools;
}
```

In `resolveInstructions`, add customer case:

```typescript
export function resolveInstructions(channel: Channel, base: string): string {
  if (channel === 'advisory') return base + ADVISORY_SUFFIX;
  if (channel === 'voice') return base + VOICE_SUFFIX;
  if (channel === 'cli') return base + CLI_SUFFIX;
  if (channel === 'employee') return EMPLOYEE_INSTRUCTIONS;
  if (channel === 'slack') return base + SLACK_SUFFIX;
  if (channel === 'customer') return CUSTOMER_INSTRUCTIONS;
  return base;
}
```

- [ ] **Step 5: Smoke test the customer agent**

```bash
npx tsx -e "
import { createMaverickAgent } from './src/agent/index.js';
const agent = createMaverickAgent('customer');
const result = await agent.generate('hi i need an outlet replaced in my garage');
console.log(result.text?.slice(0, 300));
"
```

Expected: A short, friendly text-style response asking what type of outlet or confirming the job category. Should NOT contain markdown or multiple questions.

- [ ] **Step 6: Commit**

```bash
git add src/agent/resolver.ts
git commit -m "feat(agent): add customer SMS channel with triage system prompt"
```

---

## Task 4: Build the customer chat server

**Files:**
- Create: `src/server/customer-chat-server.ts`

- [ ] **Step 1: Create the server file**

Create `src/server/customer-chat-server.ts`:

```typescript
/**
 * Customer SMS chatbot server — receives Twilio webhook POSTs, routes through
 * the customer-channel Maverick agent, and replies via TwiML.
 *
 * When the agent emits [ESTIMATE_READY]{...}[/ESTIMATE_READY]:
 *   1. Spawns from-chat.ts subprocess to create the HCP estimate
 *   2. Calls sendEstimate() to send it to the customer via HCP
 *   3. Saves the full conversation transcript to the estimate notes
 *   4. Texts the customer confirmation
 *
 * Start: npx tsx src/server/customer-chat-server.ts
 * Env:   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, CUSTOMER_CHAT_PORT
 */
import 'dotenv/config';
import http from 'http';
import { URLSearchParams } from 'url';
import { spawn } from 'child_process';
import twilio from 'twilio';
import { createMaverickAgent } from '../agent/index.js';
import { sendEstimate, updateEstimateNotes } from '../hcp/estimates.js';

const PORT = Number(process.env.CUSTOMER_CHAT_PORT ?? 3012);
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? '';

const ESTIMATE_READY_RE = /\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/;
const MAX_HISTORY = 20;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CustomerSession {
  phone: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastActivity: number;
  estimateUuid?: string;
}

const sessions = new Map<string, CustomerSession>();

function getSession(phone: string): CustomerSession {
  const existing = sessions.get(phone);
  if (existing && Date.now() - existing.lastActivity < SESSION_TTL_MS) {
    existing.lastActivity = Date.now();
    return existing;
  }
  const fresh: CustomerSession = { phone, history: [], lastActivity: Date.now() };
  sessions.set(phone, fresh);
  return fresh;
}

function buildTranscript(history: CustomerSession['history']): string {
  return history
    .map(m => `[${m.role === 'user' ? 'Customer' : 'Grizzly'}] ${m.content}`)
    .join('\n');
}

function twimlReply(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

async function spawnEstimatePipeline(
  payload: unknown
): Promise<{ success: boolean; estimateUrl?: string; estimateUuid?: string; error?: string }> {
  return new Promise(resolve => {
    const proc = spawn('tsx', ['src/automations/estimates/from-chat.ts'], {
      cwd: process.cwd(),
      env: process.env as NodeJS.ProcessEnv,
    });
    let stdout = '';
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[customer:estimate] ${d}`));
    proc.on('close', () => {
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ success: false, error: 'Invalid pipeline response' }); }
    });
  });
}

async function sendSms(to: string, body: string): Promise<void> {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await client.messages.create({ from: TWILIO_PHONE_NUMBER, to, body });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('customer-chat-server ok\n');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook/twilio') {
    res.writeHead(404);
    res.end();
    return;
  }

  // Validate Twilio signature
  const signature = req.headers['x-twilio-signature'] as string ?? '';
  const fullUrl = `https://chat.grizzlyelectrical.net/webhook/twilio`;

  let body = '';
  for await (const chunk of req) body += chunk;
  const params = Object.fromEntries(new URLSearchParams(body));

  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, params);
  if (!valid) {
    console.warn('[customer] Invalid Twilio signature — rejected');
    res.writeHead(403);
    res.end();
    return;
  }

  const fromPhone = params.From ?? '';
  const messageBody = (params.Body ?? '').trim();

  if (!fromPhone || !messageBody) {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(twimlReply(''));
    return;
  }

  console.log(`[customer] ${fromPhone}: "${messageBody.slice(0, 60)}"`);

  const session = getSession(fromPhone);
  const agent = createMaverickAgent('customer');

  // Build context string for the agent (same pattern as slack bot)
  const contextLines = session.history
    .map(m => `${m.role === 'user' ? 'Customer' : 'Grizzly'}: ${m.content}`)
    .join('\n');
  const fullPrompt = contextLines
    ? `${contextLines}\nCustomer: ${messageBody}`
    : messageBody;

  let agentReply = '';
  try {
    const result = await agent.generate(fullPrompt);
    agentReply = typeof result.text === 'string' ? result.text : '';
  } catch (e) {
    console.error('[customer] Agent error:', e);
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(twimlReply("Sorry, something went wrong on our end. Try again in a moment!"));
    return;
  }

  session.history.push({ role: 'user', content: messageBody });

  // Check for estimate-ready block
  const estimateMatch = agentReply.match(ESTIMATE_READY_RE);

  if (estimateMatch) {
    const visibleReply = agentReply.replace(ESTIMATE_READY_RE, '').trim();

    // Send the visible part of the agent reply first (e.g. "Building your estimate now ⚡")
    session.history.push({ role: 'assistant', content: visibleReply || 'Building your estimate now ⚡' });
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(twimlReply(visibleReply || 'Building your estimate now ⚡'));

    // Run the pipeline async — Twilio doesn't wait for this
    setImmediate(async () => {
      try {
        const payload = JSON.parse(estimateMatch[1]);
        const isSiteWalk = payload.siteWalk === true;

        // For site walk: override scope with fixed assessment item + discount
        if (isSiteWalk) {
          payload.scope = undefined;
          payload.lineItems = [
            { name: 'Initial Site Assessment', quantity: 1, unitPrice: 125, type: 'labor' },
            { name: 'Site Assessment Waiver', quantity: 1, unitPrice: 125, type: 'fixed discount' },
          ];
        }

        // Ensure phone is set from the inbound number
        payload.customerPhone = payload.customerPhone || fromPhone;

        const est = await spawnEstimatePipeline(payload);

        if (est.success && est.estimateUuid) {
          session.estimateUuid = est.estimateUuid;

          // Persist estimateUuid → phone mapping for approval watcher
          try {
            const { appendFileSync } = await import('fs');
            appendFileSync(
              'data/customer-sessions.jsonl',
              JSON.stringify({ phone: fromPhone, estimateUuid: est.estimateUuid, ts: Date.now() }) + '\n'
            );
          } catch { /* non-fatal */ }

          // Save transcript to estimate notes
          const transcript = buildTranscript(session.history);
          await updateEstimateNotes(est.estimateUuid, `=== Customer SMS Transcript ===\n${transcript}`).catch(
            e => console.warn('[customer] Could not save transcript:', e)
          );

          // Send estimate to customer via HCP
          await sendEstimate(est.estimateUuid).catch(
            e => console.warn('[customer] Could not send estimate:', e)
          );

          // Text the customer confirmation
          await sendSms(
            fromPhone,
            "Sent! Check your text/email for the estimate. Just approve and sign — takes 30 seconds — and you're on the books. ✅"
          );
          console.log(`[customer] Estimate sent: ${est.estimateUrl}`);
        } else {
          await sendSms(
            fromPhone,
            "Hmm, something went wrong building the estimate. Carter will reach out shortly to sort it out!"
          );
          console.error('[customer] Pipeline failed:', est.error);
        }
      } catch (e) {
        console.error('[customer] Post-reply pipeline error:', e);
        await sendSms(fromPhone, "Sorry, we hit a snag. Carter will follow up with you directly!").catch(() => {});
      }
    });

  } else {
    // Normal conversational reply
    session.history.push({ role: 'assistant', content: agentReply });
    if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);

    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(twimlReply(agentReply));
  }
});

server.listen(PORT, () => {
  console.log(`[customer] SMS chatbot listening on port ${PORT}`);
  if (!process.env.TWILIO_ACCOUNT_SID) console.warn('[customer] TWILIO_ACCOUNT_SID not set');
  if (!TWILIO_PHONE_NUMBER) console.warn('[customer] TWILIO_PHONE_NUMBER not set');
});
```

- [ ] **Step 2: Run the server and verify it starts**

```bash
npx tsx src/server/customer-chat-server.ts
```

Expected output:
```
[customer] SMS chatbot listening on port 3012
```

Hit Ctrl+C to stop.

- [ ] **Step 3: Verify health endpoint**

In a second terminal (while server is running):
```bash
curl http://localhost:3012/health
```

Expected: `customer-chat-server ok`

- [ ] **Step 4: Commit**

```bash
git add src/server/customer-chat-server.ts
git commit -m "feat: add customer SMS chatbot server"
```

---

## Task 5: Add PM2 process

**Files:**
- Modify: `ecosystem.config.cjs`

- [ ] **Step 1: Add customer-chat-server to PM2 config**

In `ecosystem.config.cjs`, add to the `apps` array after `mav-slack`:

```javascript
{
  name: 'customer-chat-server',
  script: 'node_modules/tsx/dist/cli.mjs',
  args: 'src/server/customer-chat-server.ts',
  cwd: __dirname,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 5000,
  windowsHide: true,
},
```

- [ ] **Step 2: Commit**

```bash
git add ecosystem.config.cjs
git commit -m "chore: add customer-chat-server to PM2 config"
```

---

## Task 6: End-to-end local test

> **Before running locally:** The Twilio signature validation uses the public URL. In development, set `PUBLIC_URL` in your `.env` to the ngrok/tunnel URL so validation passes:
> ```
> PUBLIC_URL=https://your-ngrok-url.ngrok.io
> ```
> The server reads this as the webhook URL for signature checking. Update `src/server/customer-chat-server.ts` line that sets `fullUrl`:
> ```typescript
> const fullUrl = `${process.env.PUBLIC_URL ?? 'https://chat.grizzlyelectrical.net'}/webhook/twilio`;
> ```



Before deploying to Proxmox, test the full flow locally using Twilio CLI.

- [ ] **Step 1: Install Twilio CLI (if not installed)**

```bash
npm install -g twilio-cli
twilio login
```

- [ ] **Step 2: Expose local server via Twilio CLI tunnel**

In a terminal:
```bash
npx tsx src/server/customer-chat-server.ts
```

In a second terminal:
```bash
twilio phone-numbers:update YOUR_TWILIO_NUMBER --sms-url http://localhost:3012/webhook/twilio
# Or use the built-in dev tunnel:
twilio dev-tunnel http 3012
```

Note the public URL the tunnel gives you, then update the Twilio webhook URL in the console to that URL + `/webhook/twilio`.

- [ ] **Step 3: Send a test SMS from your phone to the Twilio number**

Send: `"hi I need to replace an outlet in my kitchen"`

Expected conversation flow:
1. Bot replies with a greeting or follow-up question
2. After you answer category questions, bot gives a price range
3. Bot asks if you want to schedule
4. After confirmation, bot collects name/address/email/referral
5. Bot says "Building your estimate now ⚡"
6. HCP estimate appears in the HCP dashboard
7. Customer receives the HCP estimate via text/email
8. You receive "Sent! Check your text/email..." confirmation text

- [ ] **Step 4: Test the site walk branch**

Send: `"I need to rewire my whole house, it's a full remodel"`

Expected:
1. Bot immediately offers a free site visit
2. After confirmation + info collection, creates $0 estimate (site assessment + waiver) in HCP

- [ ] **Step 5: Verify transcript in HCP estimate notes**

Open the HCP estimate that was created. Check that the estimate notes contain the full SMS conversation transcript formatted as `[Customer] ... [Grizzly] ...`.

---

## Task 7: Cloudflare Tunnel on Proxmox

These commands run **on Proxmox via SSH** — not on CartersPC.

```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12
```

- [ ] **Step 1: Install cloudflared on Proxmox**

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb
cloudflared --version
```

Expected: `cloudflared version X.X.X`

- [ ] **Step 2: Authenticate cloudflared with your Cloudflare account**

```bash
cloudflared tunnel login
```

This opens a browser link — copy it and authenticate via Cloudflare dashboard. Creates `~/.cloudflared/cert.pem`.

- [ ] **Step 3: Create the tunnel**

```bash
cloudflared tunnel create grizzly-chat
```

Note the tunnel ID printed (a UUID like `abc123...`). You'll use it in the next step.

- [ ] **Step 4: Create tunnel config**

```bash
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: grizzly-chat
credentials-file: /root/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: chat.grizzlyelectrical.net
    service: http://localhost:3012
  - service: http_status:404
EOF
```

Replace `<TUNNEL_UUID>` with the UUID from Step 3.

- [ ] **Step 5: Add DNS record**

```bash
cloudflared tunnel route dns grizzly-chat chat.grizzlyelectrical.net
```

- [ ] **Step 6: Test the tunnel manually**

In one SSH session, start the grizzly-hcp server (from wherever it's deployed on Proxmox):
```bash
cd /path/to/grizzly-hcp && npx tsx src/server/customer-chat-server.ts &
```

In another:
```bash
cloudflared tunnel run grizzly-chat
```

From your local machine:
```bash
curl https://chat.grizzlyelectrical.net/health
```

Expected: `customer-chat-server ok`

- [ ] **Step 7: Install as systemd service**

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
systemctl status cloudflared
```

Expected: `active (running)`

- [ ] **Step 8: Update Twilio webhook URL to production**

In the Twilio console, set the SMS webhook URL for your number to:
```
https://chat.grizzlyelectrical.net/webhook/twilio
```

Send a final end-to-end test SMS to verify the full production path works.

---

## Task 9: Approval monitoring + follow-up SMS

When a customer approves their estimate in HCP, HCP emails `contactus@grizzlyelectrical.net`. This task wires that into a follow-up text to the customer asking technical questions to nail the final price.

**Files:**
- Modify: `src/automations/estimates/email-watcher.ts`
- Read: `data/customer-sessions.jsonl` (written by customer-chat-server)

- [ ] **Step 1: Understand the HCP approval email format**

Run `npm run watch-email` while logged into HCP. Approve a test estimate. Check the console output from the email-watcher to see how HCP formats the approval notification email (subject line, body structure). Note:
- Subject line (e.g., "Estimate #12345 has been approved")
- Whether it contains the customer name or estimate UUID

- [ ] **Step 2: Add approval detection to `email-watcher.ts`**

In `src/automations/estimates/email-watcher.ts`, find where emails are classified (the `classify` or main processing function). Add a check for HCP approval notifications:

```typescript
// Near the top of the file, add this helper:
import { readFileSync } from 'fs';

function lookupCustomerPhone(estimateUuid: string): string | null {
  try {
    const lines = readFileSync('data/customer-sessions.jsonl', 'utf-8').trim().split('\n');
    for (const line of lines.reverse()) {  // most recent first
      try {
        const entry = JSON.parse(line);
        if (entry.estimateUuid === estimateUuid) return entry.phone;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file doesn't exist yet */ }
  return null;
}
```

- [ ] **Step 3: Add the approval handler function**

```typescript
async function handleEstimateApproval(
  customerName: string,
  phone: string | null
): Promise<void> {
  if (!phone) {
    console.log(`[approval] No phone found for approved estimate — skipping SMS`);
    return;
  }
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: phone,
    body: `Great news — your estimate is approved! 🎉 To finalize our pricing before we head out, do you know the age of your electrical panel or when the wiring was last updated?`
  });
  console.log(`[approval] Sent follow-up SMS to ${phone}`);
}
```

- [ ] **Step 4: Wire the approval check into the email processing loop**

In the main email processing logic (where emails are read and classified), add before the existing classification:

```typescript
// Check if this is an HCP estimate approval notification
const subjectLower = (email.subject ?? '').toLowerCase();
const isApprovalNotification =
  subjectLower.includes('estimate') &&
  (subjectLower.includes('approved') || subjectLower.includes('signed')) &&
  (email.from ?? '').includes('housecallpro');  // adjust to actual HCP sender domain

if (isApprovalNotification) {
  console.log(`[approval] HCP estimate approved: ${email.subject}`);
  // Extract customer name from subject or body — adjust regex to match real format
  const nameMatch = email.subject?.match(/by (.+?)(?:\s*$|[,.])/i);
  const customerName = nameMatch?.[1] ?? 'unknown';
  // Look up phone from local session store
  const phone = lookupCustomerPhone(/* estimateUuid from email body if available */ '');
  await handleEstimateApproval(customerName, phone);
  continue; // don't process as a customer request
}
```

> **Note:** Adjust the subject/sender matching and customer name extraction based on what you observed in Step 1.

- [ ] **Step 5: Test the approval flow end-to-end**

1. Complete a test estimate via SMS (Task 6 flow)
2. Open the estimate in HCP and click "Approve"
3. Watch the email-watcher console output for `[approval] HCP estimate approved`
4. Verify the customer phone receives the follow-up text

- [ ] **Step 6: Commit**

```bash
git add src/automations/estimates/email-watcher.ts
git commit -m "feat: send follow-up SMS when HCP estimate is approved"
```

---

## Task 8: WordPress CTA injection

Use Maverick's existing WordPress API access to add a "Text us" CTA to the site.

- [ ] **Step 1: Ask Maverick to inject the CTA via WordPress API**

In Slack or MCC, send Maverick:

```
Add a sticky "Text for a free estimate" CTA to the Grizzly WordPress site. 
Phone number: [YOUR_TWILIO_NUMBER in (XXX) XXX-XXXX format]
On mobile, the number should be an sms: link so it opens the native texting app.
Place it in the footer or as a floating button — wherever it gets the most visibility.
```

Maverick will use its WordPress tools to inject this.

- [ ] **Step 2: Verify on the live site**

Load the Grizzly website on both desktop and mobile. Confirm:
- The CTA is visible
- On mobile, tapping the number opens the SMS app with the number pre-filled

---

## Verification Checklist

- [ ] `curl https://chat.grizzlyelectrical.net/health` → `customer-chat-server ok`
- [ ] Twilio webhook → `/webhook/twilio` signature validation passes
- [ ] Full SMS conversation → outlet replacement → estimate created in HCP
- [ ] Full SMS conversation → remodel → $0 site walk estimate created in HCP
- [ ] HCP estimate notes contain full conversation transcript
- [ ] Customer receives estimate via HCP text/email
- [ ] Approving estimate in HCP → customer receives follow-up SMS within minutes
- [ ] `pm2 status` on Proxmox shows `customer-chat-server` as `online`
- [ ] `systemctl status cloudflared` shows `active (running)`
- [ ] WordPress site shows "Text us" CTA on mobile with working sms: link
