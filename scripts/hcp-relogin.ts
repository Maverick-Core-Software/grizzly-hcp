/**
 * Automated HCP re-login via Google OAuth — the recovery path when the session
 * is genuinely dead. Day-to-day expiry is handled by `npm run keepalive`
 * (scripts/hcp-keepalive.ts), which rolls the session forward with one
 * authenticated GET and never needs a browser. Reach for this only when the
 * keepalive reports a 401.
 *
 * auth/hcp-session/ is a persistent Playwright profile that normally still
 * holds the Google session, so no password is needed — just two clicks:
 *   1. The Google sign-in button on the HCP login page.
 *   2. carterbarns@grizzlyelectrical.net in the Google account picker popup.
 *
 * That button is now a Google Identity Services <iframe>
 * (accounts.google.com/gsi/button), not a "Sign in with Google" text button.
 * The old `text=Sign in with Google` selector matched nothing and every run
 * died on an opaque 30s `waitForEvent("page")` timeout — silently, weekly,
 * from 2026-08-24 until the keepalive replaced this on the schedule. Both
 * selectors are tried below, newest first, and a miss says so out loud.
 *
 * Two guards earn their keep here:
 *   - A headless session check runs first. When the profile is already signed
 *     in there is no login page and therefore no button, so the old script
 *     timed out on exactly the runs that had nothing to do.
 *   - Cookies are written only after the extraction context proves it is
 *     authenticated. A logged-out profile still yields ~19 cookies, including
 *     a csrf_token and a *fresh 14-day* session cookie handed out by the login
 *     page itself — so an unguarded write replaces a good jar with a dead one
 *     that every expiry check then calls healthy for a fortnight. That is the
 *     shape of the silent Jul 31–Aug 8 booking outage.
 *
 * Usage:
 *   npm run relogin                       ← interactive (shows the browser briefly)
 *   npx tsx scripts/hcp-relogin.ts
 *   npx tsx scripts/hcp-relogin.ts --no-oauth
 *
 * --no-oauth stays headless: it reports whether the profile is signed in and
 * re-saves the cookies if it is, but never opens a window. Use it to inspect
 * profile health, and to exercise the write guard, without a desktop session.
 */
import 'dotenv/config';
import { chromium, type BrowserContext } from 'playwright';
import fs from 'fs/promises';
import { COOKIES_FILE, SESSION_DIR } from '../src/hcp/auth.js';

const BASE = 'https://pro.housecallpro.com';
const GOOGLE_EMAIL = process.env.HCP_GOOGLE_EMAIL ?? 'carterbarns@grizzlyelectrical.net';

const log = (msg: string) => console.log(`[hcp-relogin] ${msg}`);

function isLoginUrl(url: string): boolean {
  return url.includes('/log_in') || url.includes('/login');
}

function launchProfile(headless: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(SESSION_DIR, {
    headless,
    viewport: headless ? { width: 1280, height: 800 } : null,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(headless ? [] : ['--start-maximized']),
    ],
    ignoreDefaultArgs: headless ? [] : ['--enable-automation'],
  });
}

/**
 * Report whether an already-loaded page is signed in.
 *
 * HCP's bounce to /log_in is client-side and routinely takes 4-6 seconds, so a
 * fixed sleep races it: a 3s wait called a logged-out profile "still valid",
 * which skipped OAuth on exactly the runs that needed it and left the run to
 * die on the write guard instead. Wait for the redirect explicitly and treat
 * the timeout — not the clock — as the signed-in answer.
 */
async function isSignedIn(page: import('playwright').Page): Promise<boolean> {
  try {
    await page.waitForURL((u) => isLoginUrl(u.toString()), { timeout: 15_000 });
    return false;
  } catch {
    return !isLoginUrl(page.url());
  }
}

/** Navigate to the app and report whether the profile session is signed in. */
async function checkSession(): Promise<boolean> {
  const ctx = await launchProfile(true);
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await isSignedIn(page);
  } finally {
    await ctx.close();
  }
}

// ── Step 1: headed 2-click Google OAuth ─────────────────────────────────────

/**
 * Click whichever Google sign-in affordance HCP is currently rendering.
 * Returns the popup it opened. Throws with a readable diagnosis if neither
 * the GIS iframe nor the legacy text button is on the page.
 */
async function clickGoogleSignIn(ctx: BrowserContext, page: import('playwright').Page) {
  const gisFrame = page.frameLocator('iframe[src*="accounts.google.com/gsi/button"]');
  const strategies: Array<{ what: string; click: () => Promise<void> }> = [
    {
      what: 'Google Identity Services iframe button',
      click: () => gisFrame.locator('[role="button"]').first().click({ timeout: 10_000 }),
    },
    {
      what: 'legacy "Sign in with Google" text button',
      click: () => page.click('text=Sign in with Google', { timeout: 10_000 }),
    },
  ];

  for (const { what, click } of strategies) {
    try {
      const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 20_000 }), click()]);
      log(`Clicked the ${what}.`);
      return popup;
    } catch {
      log(`No ${what} on this page — trying the next selector.`);
    }
  }

  throw new Error(
    '[hcp-relogin] Could not find a Google sign-in control on the HCP login page. ' +
      'HCP has changed its login UI again — re-inspect https://pro.housecallpro.com/app/log_in ' +
      'and update the selectors in clickGoogleSignIn(). ' +
      'Meanwhile, sign in by hand in a browser to restore the session.',
  );
}

/** Pick the Grizzly account in the OAuth popup. */
async function chooseAccount(popup: import('playwright').Page): Promise<void> {
  await popup.waitForLoadState('domcontentloaded');

  // Google renders the account as a div/button containing the email text.
  // Try the data-email attribute first (most reliable), fall back to visible text.
  try {
    await popup.click(`[data-email="${GOOGLE_EMAIL}"]`, { timeout: 8_000 });
    return;
  } catch {
    /* fall through */
  }
  try {
    await popup.click(`text=${GOOGLE_EMAIL}`, { timeout: 8_000 });
    return;
  } catch {
    /* fall through */
  }

  // No account chip means the profile's Google session is gone and Google is
  // asking for credentials. Nothing here can or should type a password.
  const wantsCredentials = await popup
    .locator('input[type="email"], input[type="password"]')
    .count()
    .catch(() => 0);
  throw new Error(
    wantsCredentials > 0
      ? `[hcp-relogin] Google is asking for credentials — the Google session in ${SESSION_DIR} has expired. ` +
        `Sign in as ${GOOGLE_EMAIL} by hand in the open browser window to re-seed the profile, then re-run. ` +
        'This script will not enter a password.'
      : `[hcp-relogin] ${GOOGLE_EMAIL} was not offered in the Google account picker. ` +
        'Complete the sign-in manually in the open window, then re-run.',
  );
}

async function googleRelogin(): Promise<void> {
  log('Opening browser for Google sign-in…');
  const ctx = await launchProfile(false);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app/log_in`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // The GIS iframe is injected after the bundle boots.
    await page.waitForTimeout(4_000);

    const popup = await clickGoogleSignIn(ctx, page);
    log('Google account picker open — selecting account…');
    await chooseAccount(popup);

    // Popup closes when OAuth completes; then HCP finishes loading.
    await popup.waitForEvent('close', { timeout: 30_000 });
    await page.waitForURL((u) => !isLoginUrl(u.toString()), { timeout: 30_000 });
    // Let the app settle so every session cookie is written to the profile.
    await page.waitForTimeout(5_000);
    log('Signed in.');
  } finally {
    await ctx.close();
  }
}

// ── Step 2: headless extraction — lets React set the csrf_token cookie ───────
// (Identical to the extraction step in src/hcp/auth.ts loginAndSave(), plus the
// authenticated-before-write guard.)

async function extractAndSave(): Promise<void> {
  const ctx = await launchProfile(true);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

  // Settle the auth redirect before trusting the URL — the csrf loop below can
  // break in under a second, well before a bounce to /log_in would land.
  const signedIn = await isSignedIn(page);

  let csrf: { name: string } | undefined;
  for (let i = 0; i < 15; i++) {
    csrf = (await ctx.cookies(BASE)).find((c) => c.name === 'csrf_token');
    if (csrf) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const url = page.url();
  const cookies = await ctx.cookies(BASE);
  await ctx.close();

  if (!signedIn) {
    throw new Error(
      `[hcp-relogin] Refusing to save: the profile is still logged out (landed on ${url}). ` +
        'The login page hands out a fresh 14-day session cookie and a csrf_token, so saving now ' +
        `would overwrite ${COOKIES_FILE} with a dead session that every expiry check reports as healthy.`,
    );
  }
  if (!cookies.length) throw new Error('[hcp-relogin] No cookies captured — did Google sign-in complete?');
  if (!csrf) console.warn('[hcp-relogin] csrf_token not found — POST requests may fail; run again.');

  await fs.mkdir('auth', { recursive: true });
  await fs.writeFile(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  log(`Done — ${cookies.length} cookies saved${csrf ? ' (csrf_token ✓)' : ''} → ${COOKIES_FILE}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const noOauth = process.argv.includes('--no-oauth');

if (await checkSession()) {
  log('Profile session is still valid — skipping OAuth, refreshing the saved cookies.');
} else if (noOauth) {
  log('Profile session is logged out, and --no-oauth was passed — not opening a browser.');
} else {
  log('Profile session is logged out — starting Google OAuth relogin.');
  await googleRelogin();
}

log('Extracting cookies…');
await extractAndSave();
