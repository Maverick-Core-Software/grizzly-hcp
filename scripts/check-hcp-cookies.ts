/**
 * HCP cookie-expiry watchdog — run daily by the Grizzly_HCPCookieCheck
 * Scheduled Task. Alerts via ntfy (src/ops/alert.ts) when the direct-client
 * session in auth/hcp-cookies.json is missing, expiring soon, or lacks
 * csrf_token — the exact conditions that caused the silent Jul 31–Aug 8
 * voice-booking outage.
 *
 * Exit codes: 0 healthy, 1 alert sent (or cookie problem found).
 * Usage: npx tsx scripts/check-hcp-cookies.ts [--warn-days N]   (default 3)
 */
import 'dotenv/config';
import fs from 'fs/promises';
import { COOKIES_FILE } from '../src/hcp/auth-cookies.js';
import { sendOpsAlert } from '../src/ops/alert.js';

const warnIdx = process.argv.indexOf('--warn-days');
const WARN_DAYS = warnIdx > -1 ? Number(process.argv[warnIdx + 1]) : 3;

async function main() {
  let cookies: Array<{ name: string; value: string; expires?: number }>;
  try {
    cookies = JSON.parse(await fs.readFile(COOKIES_FILE, 'utf-8'));
  } catch {
    await alert('HCP cookies MISSING', `No readable cookie file at ${COOKIES_FILE}. Run: npm run relogin`);
    return;
  }
  if (!cookies.length) {
    await alert('HCP cookie file EMPTY', 'Run: npm run relogin');
    return;
  }

  const now = Date.now() / 1000;
  // Health is gated by the Rails session cookie (~2-week life). Short-lived
  // marketing/analytics cookies (__stripe_sid, _uetsid, …) expire in minutes
  // and must not trigger alerts — getCookieHeader just drops them.
  const session = cookies.find((c) => c.name === '_housecall-web_session_with_domain');
  const hasCsrf = cookies.some((c) => c.name === 'csrf_token');

  if (!session || !session.expires || session.expires <= 0) {
    await alert('HCP session cookie MISSING', '_housecall-web_session_with_domain not in cookie file. Run: npm run relogin');
    return;
  }
  if (session.expires <= now) {
    await alert('HCP session EXPIRED', 'The HCP session cookie is past expiry — voice bookings will 401. Run: npm run relogin');
    return;
  }
  if (!hasCsrf) {
    await alert('HCP csrf_token MISSING', 'POSTs (customer/estimate creation) will fail. Run: npm run relogin');
    return;
  }

  const daysLeft = (session.expires - now) / 86_400;
  if (daysLeft <= WARN_DAYS) {
    await alert(
      `HCP session expires in ${daysLeft.toFixed(1)} days`,
      `Session cookie expires ${new Date(session.expires * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' })} (Central). Run: npm run relogin`
    );
    return;
  }

  console.log(`[cookie-check] OK — session cookie valid, csrf ✓, expires in ${daysLeft.toFixed(1)} days`);
}

async function alert(title: string, message: string): Promise<void> {
  console.error(`[cookie-check] ${title}: ${message}`);
  await sendOpsAlert(`🔑 ${title}`, message, { tags: 'key' });
  process.exitCode = 1;
}

await main();
