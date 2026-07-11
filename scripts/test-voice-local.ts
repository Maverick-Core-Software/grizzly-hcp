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
