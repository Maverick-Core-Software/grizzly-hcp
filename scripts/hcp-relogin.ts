/**
 * Automated HCP re-login via Google OAuth.
 *
 * auth/hcp-session/ is a persistent Playwright profile that already holds the
 * Google session, so no password is needed — just two clicks:
 *   1. "Sign in with Google" on the HCP login page.
 *   2. carterbarns@grizzlyelectrical.net in the Google account picker popup.
 *
 * After the headed flow, the existing headless extraction step (from auth.ts)
 * boots the React app to capture the csrf_token cookie, then writes
 * auth/hcp-cookies.json in exactly the same format as `npm run login`.
 *
 * Usage:
 *   npm run relogin            ← interactive (shows the browser briefly)
 *   npx tsx scripts/hcp-relogin.ts
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs/promises';
import { COOKIES_FILE, SESSION_DIR } from '../src/hcp/auth.js';

const BASE = 'https://pro.housecallpro.com';
const GOOGLE_EMAIL = process.env.HCP_GOOGLE_EMAIL ?? 'carterbarns@grizzlyelectrical.net';

// ── Step 1: headed 2-click Google OAuth ─────────────────────────────────────

console.log('[hcp-relogin] Opening browser for Google sign-in…');

const loginCtx = await chromium.launchPersistentContext(SESSION_DIR, {
  headless: false,
  viewport: null,
  args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});

await loginCtx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = await loginCtx.newPage();
await page.goto(`${BASE}/app/log_in`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

// Click "Sign in with Google" and catch the popup it opens.
const [popup] = await Promise.all([
  loginCtx.waitForEvent('page'),
  page.click('text=Sign in with Google'),
]);

console.log('[hcp-relogin] Google account picker open — selecting account…');
await popup.waitForLoadState('domcontentloaded');

// Google renders the account as a div/button containing the email text.
// Try the data-email attribute first (most reliable), fall back to visible text.
try {
  await popup.click(`[data-email="${GOOGLE_EMAIL}"]`, { timeout: 6_000 });
} catch {
  await popup.click(`text=${GOOGLE_EMAIL}`, { timeout: 6_000 });
}

// Wait for the popup to close (OAuth complete) then for HCP to finish loading.
await popup.waitForEvent('close', { timeout: 20_000 });
await page.waitForURL(`${BASE}/app**`, { timeout: 20_000 });
await loginCtx.close();

console.log('[hcp-relogin] Signed in — extracting cookies…');

// ── Step 2: headless extraction — lets React set the csrf_token cookie ───────
// (Identical to the extraction step in src/hcp/auth.ts loginAndSave().)

const extractCtx = await chromium.launchPersistentContext(SESSION_DIR, { headless: true });
const page2 = await extractCtx.newPage();
await page2.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

let csrf: { name: string } | undefined;
for (let i = 0; i < 15; i++) {
  const cookies = await extractCtx.cookies(BASE);
  csrf = cookies.find((c) => c.name === 'csrf_token');
  if (csrf) break;
  await new Promise((r) => setTimeout(r, 1_000));
}

const cookies = await extractCtx.cookies(BASE);
await extractCtx.close();

if (!cookies.length) throw new Error('[hcp-relogin] No cookies captured — did Google sign-in complete?');
if (!csrf) console.warn('[hcp-relogin] csrf_token not found — POST requests may fail; run again.');

await fs.mkdir('auth', { recursive: true });
await fs.writeFile(COOKIES_FILE, JSON.stringify(cookies, null, 2));
console.log(`[hcp-relogin] Done — ${cookies.length} cookies saved${csrf ? ' (csrf_token ✓)' : ''} → ${COOKIES_FILE}`);
