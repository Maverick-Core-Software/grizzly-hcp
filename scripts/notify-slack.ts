// One-shot Slack notifier. Usage: tsx scripts/notify-slack.ts "<message>"
// Exits 0 on send, non-zero on failure. No-ops (exit 0, logged) if SLACK_BOT_TOKEN/CHANNEL_ID unset.
import 'dotenv/config';
import { WebClient } from '@slack/web-api';

async function main() {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) { console.error('[notify-slack] no message text'); process.exit(2); }

  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) {
    console.warn('[notify-slack] SLACK_BOT_TOKEN/SLACK_CHANNEL_ID unset — skipping send');
    process.exit(0);
  }

  const client = new WebClient(token);
  await client.chat.postMessage({ channel, text });
  console.log('[notify-slack] sent');
}

main().catch((e) => { console.error('[notify-slack] failed:', e?.message ?? e); process.exit(1); });
