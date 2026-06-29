import 'dotenv/config';
import { App } from '@slack/bolt';
import { spawn } from 'child_process';
import { createMaverickAgent } from '../../agent/index.js';
import { shouldHandleMessage } from './filter.js';

const TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? '';
const OPERATOR_USER_ID = process.env.SLACK_OPERATOR_USER_ID ?? '';

if (!TOKEN || !APP_TOKEN) {
  console.error('[slack] SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
  process.exit(1);
}

const app = new App({ token: TOKEN, appToken: APP_TOKEN, socketMode: true });
const agent = createMaverickAgent('slack');

// Per-user conversation history (resets on restart)
const histories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
const MAX_HISTORY = 20;

// Slack occasionally re-delivers events; deduplicate on message ts
const seenTs = new Set<string>();

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
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[slack:estimate] ${d}`));
    proc.on('close', () => {
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ success: false, error: 'Invalid response from estimate pipeline' }); }
    });
  });
}

type SlackMessage = {
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  channel: string;
  channel_type?: string;
};

app.event('message', async ({ event, say }) => {
  const msg = event as SlackMessage;

  // Ignore bot messages, edits, deletions
  if (msg.subtype || msg.bot_id || !msg.user || !msg.text) return;

  // Answer in the configured ops channel or in a 1:1 DM, operator-only either way
  if (!shouldHandleMessage(msg.channel, msg.channel_type, msg.user, {
    channelId: CHANNEL_ID,
    operatorUserId: OPERATOR_USER_ID,
  })) return;

  // Dedup
  if (seenTs.has(msg.ts)) return;
  seenTs.add(msg.ts);
  if (seenTs.size > 1000) {
    const arr = [...seenTs];
    arr.splice(0, 500).forEach(ts => seenTs.delete(ts));
  }

  const prompt = msg.text.trim();
  if (!prompt) return;

  const userId = msg.user;
  console.log(`[slack] [${userId}] "${prompt.slice(0, 60)}"`);

  const history = histories.get(userId) ?? [];

  try {
    const contextLines = history
      .map(m => `${m.role === 'user' ? 'Carter' : 'Maverick'}: ${m.content}`)
      .join('\n');
    const fullPrompt = contextLines ? `${contextLines}\nCarter: ${prompt}` : prompt;

    const result = await agent.generate(fullPrompt);
    const response = typeof result.text === 'string' ? result.text : JSON.stringify(result);

    history.push({ role: 'user', content: prompt });
    history.push({ role: 'assistant', content: response });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    histories.set(userId, history);

    const estimateMatch = response.match(ESTIMATE_READY_RE);
    if (estimateMatch) {
      const visibleResponse = response.replace(ESTIMATE_READY_RE, '').trim();
      if (visibleResponse) await say(visibleResponse);

      await say('Building estimate in HCP...');
      try {
        const payload = JSON.parse(estimateMatch[1]);
        const est = await runEstimatePipeline(payload);
        if (est.success) {
          await say(`✅ Estimate ready: ${est.estimateUrl}`);
        } else {
          await say(`⚠️ Estimate failed: ${est.error ?? 'unknown error'}`);
        }
      } catch {
        await say('⚠️ Could not create the estimate — check MCC.');
      }
    } else {
      await say(response);
    }

    console.log(`[slack] [${userId}] replied (${response.length} chars)`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`[slack] error for ${userId}:`, err);
    await say('Sorry, something went wrong. Try again in a moment.');
  }
});

await app.start();
console.log('[slack] Maverick Slack bot ready (Socket Mode)');
