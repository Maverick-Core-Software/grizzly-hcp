/**
 * Customer SMS chatbot server — Twilio webhook → customer agent → TwiML reply.
 * Start: npx tsx src/server/customer-chat-server.ts
 * Env:   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
 *        CUSTOMER_CHAT_PORT (default 3012), PUBLIC_URL
 */
import 'dotenv/config';
import http from 'http';
import { URLSearchParams } from 'url';
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import twilio from 'twilio';
const { validateRequest } = twilio;
import { createMaverickAgent } from '../agent/index.js';
import { sendEstimate, updateEstimateNotes } from '../hcp/estimates.js';

const PORT = Number(process.env.CUSTOMER_CHAT_PORT ?? 3012);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? '';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://chat.grizzlyelectrical.net';

const ESTIMATE_READY_RE = /\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/;
const MAX_HISTORY = 20;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Ensure data dir exists for session log
try { mkdirSync('data', { recursive: true }); } catch { /* already exists */ }

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

function twiml(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function spawnPipeline(
  payload: unknown,
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
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[customer:pipeline] ${d}`));
    proc.on('close', () => {
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ success: false, error: 'Invalid pipeline response' }); }
    });
  });
}

async function sendSms(to: string, body: string): Promise<void> {
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
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
    res.end(twiml(''));
    return;
  }

  console.log(`[customer] ${fromPhone}: "${messageBody.slice(0, 60)}"`);

  const session = getSession(fromPhone);
  const agent = createMaverickAgent('customer');

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
    res.end(twiml('Sorry, something went wrong on our end. Try again in a moment!'));
    return;
  }

  session.history.push({ role: 'user', content: messageBody });
  const estimateMatch = agentReply.match(ESTIMATE_READY_RE);

  if (estimateMatch) {
    const visibleReply = agentReply.replace(ESTIMATE_READY_RE, '').trim();
    const sendText = visibleReply || 'Building your estimate now ⚡';
    session.history.push({ role: 'assistant', content: sendText });
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }

    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(twiml(sendText));

    setImmediate(async () => {
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

          await sendEstimate(est.estimateUuid)
            .catch(e => console.warn('[customer] Could not send estimate:', e));

          await sendSms(
            fromPhone,
            'Sent! Check your text/email for the estimate. Just approve and sign — takes 30 seconds — and you\'re on the books. ✅',
          );
          console.log(`[customer] Estimate created and sent: ${est.estimateUrl}`);
        } else {
          await sendSms(
            fromPhone,
            "Hmm, something went wrong building the estimate. Carter will reach out shortly!",
          );
          console.error('[customer] Pipeline failed:', est.error);
        }
      } catch (e) {
        console.error('[customer] Post-reply error:', e);
        await sendSms(
          fromPhone,
          'Sorry, we hit a snag. Carter will follow up with you directly!',
        ).catch(() => {});
      }
    });
  } else {
    session.history.push({ role: 'assistant', content: agentReply });
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }

    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(twiml(agentReply));
  }
});

server.listen(PORT, () => {
  console.log(`[customer] SMS chatbot listening on port ${PORT}`);
  if (!TWILIO_ACCOUNT_SID) console.warn('[customer] TWILIO_ACCOUNT_SID not set');
  if (!TWILIO_AUTH_TOKEN) console.warn('[customer] TWILIO_AUTH_TOKEN not set');
  if (!TWILIO_PHONE_NUMBER) console.warn('[customer] TWILIO_PHONE_NUMBER not set');
});
