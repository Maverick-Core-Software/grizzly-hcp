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
