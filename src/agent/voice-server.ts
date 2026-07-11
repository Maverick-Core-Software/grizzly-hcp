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
