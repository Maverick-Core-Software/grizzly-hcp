/**
 * HCP session keepalive CLI — run daily by a Scheduled Task.
 *
 * Replaces the weekly `Grizzly_HCPRelogin` browser run, which has been failing
 * since HCP swapped its "Sign in with Google" button for a Google Identity
 * Services iframe (logs/relogin.log, 2026-08-24). One authenticated GET rolls
 * the Rails session cookie forward another ~14 days, so the session never
 * reaches its expiry as long as this runs at least once a fortnight.
 *
 * Exit codes: 0 rolled forward, 1 alert sent (session dead or unreachable).
 * A non-zero exit means a human has to sign in — nothing here can recover it.
 *
 * Usage: npx tsx scripts/hcp-keepalive.ts
 *
 * ponytail: exits via `process.exitCode` + return, never `process.exit()` —
 * a forced exit after fetch trips libuv's UV_HANDLE_CLOSING assertion on
 * Windows and corrupts the exit code the Scheduled Task reports. Same reason
 * as src/hcp/preflight-cli.ts.
 */
import 'dotenv/config';
import { keepAlive } from '../src/hcp/session-keepalive.js';
import { sendOpsAlert } from '../src/ops/alert.js';

const r = await keepAlive();

if (r.ok) {
  const when = r.expiresAt
    ? r.expiresAt.toLocaleString('en-US', { timeZone: 'America/Chicago' })
    : 'unknown';
  const days = r.daysLeft === null ? '?' : r.daysLeft.toFixed(1);
  console.log(`[keepalive] OK — session valid, expires ${when} Central (${days} days); ${r.detail}`);
} else {
  const title = 'HCP session keepalive FAILED';
  console.error(`[keepalive] ${title}: ${r.detail}`);
  await sendOpsAlert(`🔑 ${title}`, `${r.detail} Sign in at pro.housecallpro.com, then run: npm run login`, {
    tags: 'key',
    priority: 'high',
  });
  process.exitCode = 1;
}
