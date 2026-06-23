/**
 * Maverick Voice Server — Twilio ConversationRelay WebSocket adapter.
 *
 * Phase 4 placeholder. Wires Twilio's ConversationRelay to the same Maverick
 * agent used by MCC/MCA text chat. STT + TTS are Twilio platform features;
 * this server only handles the conversation logic.
 *
 * Start: npx tsx src/agent/voice-server.ts
 * Env:   TWILIO_AUTH_TOKEN, VOICE_PORT (default 8765)
 *
 * Twilio config (set in Twilio console after number arrives):
 *   - ConversationRelay webhook: wss://<your-ngrok-or-tunnel>/voice
 *   - TTS voice: Polly.Joanna or similar
 *   - STT language: en-US
 *
 * ponytail: full implementation deferred until Twilio number is verified.
 * Replace PLACEHOLDER sections when number arrives.
 */
import 'dotenv/config';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createMaverickAgent } from './index.js';
import { logAudit } from './audit-log.js';
import { randomUUID } from 'crypto';

const PORT = Number(process.env.VOICE_PORT ?? 8765);

interface CallSession {
  callSid: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  pendingEstimate: unknown | null;
}

const sessions = new Map<string, CallSession>();

const server = http.createServer((_req, res) => {
  // Health check
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Maverick Voice Server running\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  let session: CallSession | null = null;

  ws.on('message', async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ConversationRelay event types: 'start', 'prompt', 'interrupt', 'dtmf', 'stop'
    switch (msg.type) {
      case 'start': {
        const callSid = String(msg.callSid ?? randomUUID());
        session = { callSid, history: [], pendingEstimate: null };
        sessions.set(callSid, session);
        console.log(`[voice] Call started: ${callSid}`);

        // PLACEHOLDER: send greeting
        sendText(ws, "Hi, this is Maverick for Grizzly Electrical. How can I help you today?");
        break;
      }

      case 'prompt': {
        if (!session) break;
        const transcript = String(msg.voicePrompt ?? '').trim();
        if (!transcript) break;
        console.log(`[voice] User: ${transcript}`);

        session.history.push({ role: 'user', content: transcript });
        const agent = createMaverickAgent('voice');
        const turnId = randomUUID();

        try {
          const contextMessages = session.history
            .slice(0, -1) // exclude the one we just added — will be in fullPrompt
            .map(m => `${m.role === 'user' ? 'Caller' : 'Maverick'}: ${m.content}`)
            .join('\n');
          const fullPrompt = contextMessages ? `${contextMessages}\nCaller: ${transcript}` : transcript;

          const result = await agent.generate(fullPrompt);
          const responseText = typeof result.text === 'string' ? result.text : '';

          // Strip any [ESTIMATE_READY] blocks — voice reads only the text
          const spokenText = responseText
            .replace(/\[ESTIMATE_READY\][\s\S]*?\[\/ESTIMATE_READY\]/, '')
            .replace(/\*\*(.+?)\*\*/g, '$1') // strip markdown bold
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links
            .trim();

          // If estimate block was present, hold it for when caller confirms
          const estMatch = responseText.match(/\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/);
          if (estMatch) {
            try { session.pendingEstimate = JSON.parse(estMatch[1]); } catch {}
          }

          session.history.push({ role: 'assistant', content: responseText });
          console.log(`[voice] Maverick: ${spokenText.slice(0, 120)}`);
          sendText(ws, spokenText || "Let me check on that for you.");

          logAudit({
            turnId,
            userRequest: transcript.slice(0, 120),
            intent: 'voice_turn',
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
          sendText(ws, "I'm having trouble with that. Let me get Carter to call you back.");
        }
        break;
      }

      case 'interrupt':
        // Twilio handles barge-in at the platform level — nothing to do here
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
  // ConversationRelay expects: { type: 'text', token: string }
  ws.send(JSON.stringify({ type: 'text', token: text }));
}

server.listen(PORT, () => {
  console.log(`[voice] Maverick Voice Server listening on ws://0.0.0.0:${PORT}`);
  console.log('[voice] PLACEHOLDER: Twilio ConversationRelay not yet live (number pending verification)');
});
