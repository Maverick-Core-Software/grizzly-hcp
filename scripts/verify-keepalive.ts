/**
 * Does the keepalive actually work? — the 14-day proof.
 *
 * The keepalive was installed 2026-08-29, when the saved session had a hard
 * expiry of 2026-09-12. If the daily `Grizzly_HCPKeepalive` task is really
 * rolling the session forward, then on 09-12 the jar on disk is dated ~09-26
 * and everything still authenticates. If the task silently stopped, the jar is
 * still dated 09-12 and the session is dead — the exact failure this whole
 * mechanism exists to prevent.
 *
 * Alerts on BOTH outcomes. A watchdog that only speaks up on failure cannot
 * tell you "it works" — silence is indistinguishable from a broken watchdog,
 * which is how the Jul 31 - Aug 8 outage stayed invisible for eight days.
 *
 * The verdict rests on two independent signals:
 *   1. A live authenticated GET succeeds (the session genuinely works).
 *   2. The expiry *as stored on disk* is comfortably in the future.
 *
 * Signal 2 is the load-bearing one. The server re-issues a fresh 14-day cookie
 * on every request, so the post-request expiry always looks healthy — only the
 * stored value reveals whether anything has been touching the jar daily.
 *
 * Exit codes: 0 verified, 1 verification failed.
 *
 * Usage:
 *   npm run verify-keepalive
 *   npx tsx scripts/verify-keepalive.ts --no-alert   ← print the verdict, page nobody
 *
 * ponytail: exits via `process.exitCode`, never `process.exit()` — a forced
 * exit after fetch trips libuv's UV_HANDLE_CLOSING assertion on Windows and
 * corrupts the exit code the Scheduled Task reports. Same as preflight-cli.ts.
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { keepAlive } from '../src/hcp/session-keepalive.js';
import { sendOpsAlert } from '../src/ops/alert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.resolve(__dirname, '../logs/keepalive.log');

/** Days of remaining life on the stored cookie below which we call it a fail. */
const HEALTHY_STORED_DAYS = 7;

/** Count how the scheduled runs have actually been going. */
async function readRunHistory(): Promise<{ ok: number; failed: number } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(LOG_FILE, 'utf-8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  return {
    ok: lines.filter((l) => l.includes('[keepalive] OK')).length,
    failed: lines.filter((l) => l.includes('FAILED')).length,
  };
}

function fmt(d: Date | null): string {
  return d ? d.toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'unknown';
}

/** --no-alert lets a human run the verdict on demand without paging anyone. */
const alerting = !process.argv.includes('--no-alert');

async function alert(title: string, message: string, opts: { tags: string; priority: 'default' | 'high' }) {
  if (!alerting) {
    console.log('[verify-keepalive] --no-alert — would have sent:', title);
    return;
  }
  await sendOpsAlert(title, message, opts);
}

// dryRun: a real authenticated request, but it does not write the jar. The
// daily task owns that; a verifier should not be able to paper over a gap by
// rolling the session forward itself.
const r = await keepAlive({ dryRun: true });
const history = await readRunHistory();

const runs = history
  ? `${history.ok} successful keepalive run(s), ${history.failed} failed.`
  : 'No keepalive log found — the scheduled task may never have run.';

const storedDays = r.storedDaysLeft;
const storedFresh = storedDays !== null && storedDays > HEALTHY_STORED_DAYS;
const verified = r.ok && storedFresh;

if (verified) {
  const message =
    `Session authenticates, and the saved cookie is good until ${fmt(r.storedExpiresAt)} Central ` +
    `(${storedDays!.toFixed(1)} days out) — proof the daily task is rolling it forward. ${runs}`;
  console.log(`[verify-keepalive] VERIFIED — ${message}`);
  await alert('HCP keepalive VERIFIED (14-day check)', message, {
    tags: 'white_check_mark',
    priority: 'default',
  });
} else {
  const why = !r.ok
    ? `The authenticated probe failed: ${r.detail}`
    : `The probe worked, but the saved cookie only has ${storedDays === null ? 'no' : storedDays.toFixed(1)} ` +
      `day(s) left (expires ${fmt(r.storedExpiresAt)} Central) — the daily task is not refreshing it.`;
  const message = `${why} ${runs} Check the Grizzly_HCPKeepalive Scheduled Task and logs/keepalive.log.`;
  console.error(`[verify-keepalive] FAILED — ${message}`);
  await alert('HCP keepalive FAILED its 14-day check', message, {
    tags: 'key',
    priority: 'high',
  });
  process.exitCode = 1;
}
