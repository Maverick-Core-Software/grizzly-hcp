import 'dotenv/config';
import { spawn } from 'child_process';
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';
import { whatsappBusiness } from 'spectrum-ts/providers/whatsapp-business';
import { telegram } from 'spectrum-ts/providers/telegram';
import { createMaverickAgent } from '../../agent/index.js';

// Per-sender conversation history (resets on restart)
const histories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
const MAX_HISTORY = 20; // 10 exchanges

// Dedup: Photon occasionally delivers the same message twice
const seenIds = new Set<string>();

// Sender name lookup — phone numbers from Photon dashboard
const SENDER_NAMES: Record<string, string> = {};
if (process.env.CARTER_PHONE) SENDER_NAMES[process.env.CARTER_PHONE] = 'Carter';
if (process.env.JAIME_PHONE)  SENDER_NAMES[process.env.JAIME_PHONE]  = 'Jaime';

function senderName(id: string): string {
  return SENDER_NAMES[id] ?? 'Carter'; // default to Carter for unknown senders
}

// Parse and fire the estimate pipeline when agent emits [ESTIMATE_READY]
const ESTIMATE_READY_RE = /\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/;

async function runEstimatePipeline(
  payload: unknown,
): Promise<{ success: boolean; estimateUrl?: string; error?: string }> {
  return new Promise(resolve => {
    const proc = spawn('tsx', ['src/automations/estimates/from-chat.ts'], {
      cwd: process.cwd(),
      env: process.env as NodeJS.ProcessEnv,
    });
    let stdout = '';
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[imessage:estimate] ${d}`));
    proc.on('close', () => {
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ success: false, error: 'Invalid response from estimate pipeline' }); }
    });
  });
}

const providers = [
  imessage.config(),
  whatsappBusiness.config(),
  // Telegram: add TELEGRAM_BOT_TOKEN to .env — get one free from @BotFather
  ...(process.env.TELEGRAM_BOT_TOKEN
    ? [telegram.config({ botToken: process.env.TELEGRAM_BOT_TOKEN })]
    : []),
];

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers,
});

const agent = createMaverickAgent('imessage');
console.log('[imessage] Maverick iMessage listener ready');

for await (const [space, message] of app.messages) {
  if (message.direction !== 'inbound') continue;
  if (message.content.type !== 'text') continue;
  if (seenIds.has(message.id)) continue;
  seenIds.add(message.id);

  const prompt = (message.content as { type: 'text'; text: string }).text.trim();
  const senderId = message.sender?.id ?? 'unknown';
  const name = senderName(senderId);
  if (!prompt) continue;

  const history = histories.get(senderId) ?? [];

  try {
    const contextLines = history
      .map(m => `${m.role === 'user' ? name : 'Maverick'}: ${m.content}`)
      .join('\n');
    const fullPrompt = contextLines ? `${contextLines}\n${name}: ${prompt}` : prompt;

    const result = await agent.generate(fullPrompt);
    const response = typeof result.text === 'string' ? result.text : JSON.stringify(result);

    history.push({ role: 'user', content: prompt });
    history.push({ role: 'assistant', content: response });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    histories.set(senderId, history);

    // Check for ESTIMATE_READY block — strip it from the visible message and fire the pipeline
    const estimateMatch = response.match(ESTIMATE_READY_RE);
    if (estimateMatch) {
      const visibleResponse = response.replace(ESTIMATE_READY_RE, '').trim();
      if (visibleResponse) await space.send(visibleResponse);

      await space.send('Building estimate in HCP...');
      try {
        const payload = JSON.parse(estimateMatch[1]);
        const est = await runEstimatePipeline(payload);
        if (est.success) {
          await space.send(`✅ Estimate ready: ${est.estimateUrl}`);
        } else {
          await space.send(`⚠️ Estimate failed: ${est.error ?? 'unknown error'}`);
        }
      } catch (e) {
        await space.send('⚠️ Could not create the estimate — check MCC.');
      }
    } else {
      await space.send(response);
    }

    console.log(`[imessage] [${senderId}/${name}] replied (${response.length} chars)`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`[imessage] error for ${senderId}:`, err);
    await space.send('Sorry, something went wrong. Try again in a moment.');
  }
}
