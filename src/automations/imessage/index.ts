import 'dotenv/config';
import { spawn } from 'child_process';
import fs from 'fs';
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';
import { whatsappBusiness } from 'spectrum-ts/providers/whatsapp-business';
import { telegram } from 'spectrum-ts/providers/telegram';
import { createMaverickAgent } from '../../agent/index.js';

// Per-sender conversation history (resets on restart)
const histories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
const MAX_HISTORY = 20; // 10 exchanges

// Dedup: persisted across restarts so Photon re-deliveries are ignored
const SEEN_IDS_PATH = 'data/seen-message-ids.json';
const MAX_SEEN = 500; // rolling cap — older IDs pruned

function loadSeenIds(): Set<string> {
  try {
    const ids = JSON.parse(fs.readFileSync(SEEN_IDS_PATH, 'utf-8')) as string[];
    return new Set(ids);
  } catch { return new Set(); }
}

function saveSeenId(id: string, set: Set<string>) {
  set.add(id);
  // Keep only the most recent MAX_SEEN ids
  const arr = [...set];
  if (arr.length > MAX_SEEN) arr.splice(0, arr.length - MAX_SEEN);
  try { fs.writeFileSync(SEEN_IDS_PATH, JSON.stringify(arr), 'utf-8'); } catch {}
  // Sync the in-memory set to the pruned list
  set.clear();
  arr.forEach(i => set.add(i));
}

const seenIds = loadSeenIds();

// Secondary dedup: same text from same sender within 2min = duplicate (Photon multi-delivery).
// Window must exceed the longest agent.generate() call (~60s) because Spectrum buffers
// re-deliveries and we don't process them until the current loop body awaits complete.
const DEDUP_WINDOW_MS = 120_000;
const recentMessages = new Map<string, number>(); // `${senderId}:${text}` → timestamp

function isDuplicate(senderId: string, text: string): boolean {
  const key = `${senderId}:${text}`;
  const last = recentMessages.get(key);
  const now = Date.now();
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  recentMessages.set(key, now);
  // Prune old entries every 100 messages
  if (recentMessages.size > 100) {
    for (const [k, t] of recentMessages) {
      if (now - t > DEDUP_WINDOW_MS) recentMessages.delete(k);
    }
  }
  return false;
}

// Sender name lookup — phone numbers from Photon dashboard
const SENDER_NAMES: Record<string, string> = {};
if (process.env.CARTER_PHONE) SENDER_NAMES[process.env.CARTER_PHONE] = 'Carter';
if (process.env.JAIME_PHONE)  SENDER_NAMES[process.env.JAIME_PHONE]  = 'Jaime';

function senderName(id: string): string {
  return SENDER_NAMES[id] ?? 'Carter';
}

// Never let a send failure (rate limit, network) crash the listener
async function safeSend(space: { send: (t: string) => Promise<unknown> }, text: string) {
  try { await space.send(text); }
  catch (e) { console.error('[imessage] send failed:', e instanceof Error ? e.message : e); }
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
  // WhatsApp: enabled once Photon project is approved (set WHATSAPP_ENABLED=true in .env)
  ...(process.env.WHATSAPP_ENABLED === 'true' ? [whatsappBusiness.config()] : []),
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
  // Log every raw delivery so we can see exactly what Photon sends
  const rawText = message.content.type === 'text'
    ? (message.content as { type: 'text'; text: string }).text.slice(0, 60)
    : `[${message.content.type}]`;
  console.log(`[imessage] raw: dir=${message.direction} id=${message.id} sender=${message.sender?.id} text="${rawText}"`);

  if (message.direction !== 'inbound') continue;
  if (message.content.type !== 'text') continue;
  if (seenIds.has(message.id)) {
    console.log(`[imessage] dedup (id): ${message.id}`);
    continue;
  }
  saveSeenId(message.id, seenIds);

  const prompt = (message.content as { type: 'text'; text: string }).text.trim();
  const senderId = message.sender?.id ?? 'unknown';
  const name = senderName(senderId);
  if (!prompt) continue;
  if (isDuplicate(senderId, prompt)) {
    console.log(`[imessage] [${senderId}] dedup (content): "${prompt.slice(0, 40)}"`);
    continue;
  }

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
      if (visibleResponse) await safeSend(space, visibleResponse);

      await safeSend(space, 'Building estimate in HCP...');
      try {
        const payload = JSON.parse(estimateMatch[1]);
        const est = await runEstimatePipeline(payload);
        if (est.success) {
          await safeSend(space, `✅ Estimate ready: ${est.estimateUrl}`);
        } else {
          await safeSend(space, `⚠️ Estimate failed: ${est.error ?? 'unknown error'}`);
        }
      } catch {
        await safeSend(space, '⚠️ Could not create the estimate — check MCC.');
      }
    } else {
      await safeSend(space, response);
    }

    console.log(`[imessage] [${senderId}/${name}] replied (${response.length} chars)`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`[imessage] error for ${senderId}:`, err);
    await safeSend(space, 'Sorry, something went wrong. Try again in a moment.');
  }
}
