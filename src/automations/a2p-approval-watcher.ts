/**
 * Twilio A2P 10DLC approval watcher.
 * Polls Gmail hourly for the carrier approval email, runs a webhook smoke test,
 * then posts results to Slack. Exits after firing so PM2 cron_restart re-runs it.
 *
 * PM2: cron_restart '13 * * * *', autorestart: false
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '../../..');
const STATE_FILE = path.join(REPO_ROOT, 'data', 'a2p-approval-fired.json');

const GMAIL_URL  = process.env.GMAIL_MULTI_URL || 'http://localhost:8000';
const GMAIL_KEY  = process.env.GMAIL_MULTI_API_KEY || '';
const ACCOUNTS   = (process.env.GMAIL_ACCOUNTS || 'grizzly1,grizzly2').split(',').map(s => s.trim());
const SLACK_TOKEN   = process.env.SLACK_BOT_TOKEN!;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID!;
const SLACK_USER    = process.env.SLACK_OPERATOR_USER_ID!;
const WEBHOOK_URL   = 'https://aiwa.tailf72e3f.ts.net/webhook/twilio';

async function gmailSearch(account: string, q: string): Promise<Array<{ id: string; subject: string; from: string; snippet: string }>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GMAIL_KEY) headers['X-API-Key'] = GMAIL_KEY;
  const res = await fetch(`${GMAIL_URL}/search/${account}?q=${encodeURIComponent(q)}&max_results=10`, { headers });
  if (!res.ok) return [];
  const data = await res.json() as { emails?: Array<{ id: string; subject: string; from: string; snippet: string }> };
  return data.emails ?? [];
}

async function postSlack(text: string): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
  });
}

async function smokeTest(): Promise<{ pass: boolean; reply: string }> {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'Body=Hi+I+need+a+quote+on+replacing+a+few+outlets&From=%2B15551234567&To=%2B14698963862',
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    const pass = body.includes('<Response>') && body.includes('<Message>');
    const excerpt = body.replace(/<[^>]+>/g, '').trim().slice(0, 120);
    return { pass, reply: excerpt };
  } catch (e) {
    return { pass: false, reply: String(e) };
  }
}

async function alreadyFired(): Promise<boolean> {
  try {
    await fs.access(STATE_FILE);
    return true;
  } catch {
    return false;
  }
}

async function markFired(emailId: string): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({ emailId, firedAt: new Date().toISOString() }));
}

async function run() {
  if (await alreadyFired()) {
    console.log('[a2p-watcher] Already fired — exiting.');
    return;
  }

  const query = 'from:twilio (approved OR verified OR "10DLC" OR "A2P campaign")';
  let approvalEmail: { id: string; subject: string; from: string; snippet: string } | null = null;

  for (const account of ACCOUNTS) {
    const emails = await gmailSearch(account, query).catch(() => []);
    const match = emails.find(e =>
      /approv|verif|approved|verified/i.test(e.subject + ' ' + e.snippet)
    );
    if (match) { approvalEmail = match; break; }
  }

  if (!approvalEmail) {
    console.log('[a2p-watcher] No approval email found yet.');
    return;
  }

  console.log(`[a2p-watcher] Found approval email: "${approvalEmail.subject}"`);
  await markFired(approvalEmail.id);

  const test = await smokeTest();
  const testLine = test.pass
    ? `✅ Webhook smoke test *PASSED* — bot replied: _"${test.reply}"_`
    : `❌ Webhook smoke test *FAILED*: ${test.reply}`;

  await postSlack(
    `<@${SLACK_USER}> 🎉 *Twilio A2P 10DLC campaign approved!* The customer SMS number \`+14698963862\` is cleared for production.\n\n${testLine}\n\nText \`+14698963862\` to run a live end-to-end test.`
  );

  console.log(`[a2p-watcher] Slack alert sent. Smoke test: ${test.pass ? 'PASS' : 'FAIL'}`);
}

run().catch(e => console.error('[a2p-watcher]', e));
