/**
 * SMS chatbot server — Twilio webhook → agent → TwiML reply.
 * Handles two numbers on one port: customer channel + employee channel.
 * Start: npx tsx src/server/customer-chat-server.ts
 * Env:   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
 *        EMPLOYEE_PHONE_NUMBER, CUSTOMER_CHAT_PORT (default 3012), PUBLIC_URL
 * Allowlist: data/employee-phones.json  { "+1...": { name, role } }
 */
import 'dotenv/config';
import http from 'http';
import { URLSearchParams } from 'url';
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import twilio from 'twilio';
const { validateRequest } = twilio;
import { createMaverickAgent } from '../agent/index.js';
import { sendEstimate, updateEstimateNotes } from '../hcp/estimates.js';

const PORT = Number(process.env.CUSTOMER_CHAT_PORT ?? 3012);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? '';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://chat.grizzlyelectrical.net';
const EMPLOYEE_PHONE_NUMBER = process.env.EMPLOYEE_PHONE_NUMBER ?? '';

const ESTIMATE_READY_RE = /\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/;
const MAX_HISTORY = 20;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Module-level singletons — no need to reconstruct on every request.
const agent = createMaverickAgent('customer');
const employeeAgent = createMaverickAgent('employee');
const twilioClient = new twilio.Twilio(process.env.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Ensure data dir exists for session log
try { mkdirSync('data', { recursive: true }); } catch { /* already exists */ }

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

function buildTranscript(history: CustomerSession['history']): string {
  return history
    .map(m => `[${m.role === 'user' ? 'Customer' : 'Grizzly'}] ${m.content}`)
    .join('\n');
}

function twiml(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function spawnPipeline(
  payload: unknown,
  logPrefix = 'customer',
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
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[${logPrefix}:pipeline] ${d}`));
    proc.on('close', () => {
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ success: false, error: 'Invalid pipeline response' }); }
    });
  });
}

async function sendSms(to: string, body: string, from: string = TWILIO_PHONE_NUMBER): Promise<void> {
  await twilioClient.messages.create({ from, to, body });
}

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
    .map(m => `${m.role === 'user' ? record.name : 'Maverick'}: ${m.content}`)
    .join('\n');
  const fullPrompt = contextLines ? `${contextLines}\n${record.name}: ${messageBody}` : messageBody;

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

        console.log(`[employee] Estimate created: ${est.estimateUrl ?? est.estimateUuid}`);
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

  let body = '';
  for await (const chunk of req) body += chunk;
  const params = Object.fromEntries(new URLSearchParams(body));

  const signature = (req.headers['x-twilio-signature'] as string) ?? '';
  const webhookUrl = `${PUBLIC_URL}/webhook/twilio`;
  const valid = validateRequest(TWILIO_AUTH_TOKEN, signature, webhookUrl, params);
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
    res.end('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    return;
  }

  console.log(`[customer] ${fromPhone}: "${messageBody.slice(0, 60)}"`);

  // Respond to Twilio immediately — LLM latency exceeds the 5s webhook timeout.
  // Real reply goes out via sendSms in the setImmediate below.
  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end('<?xml version="1.0" encoding="UTF-8"?><Response/>');

  setImmediate(async () => {
    const toPhone = params.To ?? '';
    if (toPhone === EMPLOYEE_PHONE_NUMBER && EMPLOYEE_PHONE_NUMBER) {
      await handleEmployee(fromPhone, messageBody);
      return;
    }

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
          // ponytail: from-chat.ts only accepts { scope, customerName, customerEmail, customerPhone }.
          // Set a specific scope string so the pipeline can match against pricebook items.
          // HCP pricebook must have: "Site Assessment" ($125 labor) + "Site Assessment Waiver" ($125 discount).
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
  });
});

server.listen(PORT, () => {
  console.log(`[server] SMS chatbot listening on port ${PORT}`);
  if (!TWILIO_ACCOUNT_SID) console.warn('[server] TWILIO_ACCOUNT_SID not set');
  if (!TWILIO_AUTH_TOKEN)  console.warn('[server] TWILIO_AUTH_TOKEN not set');
  if (!TWILIO_PHONE_NUMBER) console.warn('[server] TWILIO_PHONE_NUMBER not set — customer channel inactive');
  if (!EMPLOYEE_PHONE_NUMBER) console.warn('[server] EMPLOYEE_PHONE_NUMBER not set — employee channel inactive');
});
