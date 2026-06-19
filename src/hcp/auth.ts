/**
 * HCP session management.
 * Login once with: npm run login
 * Cookies (including csrf_token) are saved to auth/hcp-cookies.json.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const COOKIES_FILE = path.resolve(__dirname, '../../auth/hcp-cookies.json');
const SESSION_DIR   = path.resolve(__dirname, '../../auth/hcp-session');
const BASE = 'https://pro.housecallpro.com';

/**
 * Two-step login:
 *   1. Open a visible browser so the user can log in manually.
 *   2. After they close it, open a headless browser with the same session
 *      and navigate to /app so the React app sets the csrf_token cookie.
 *   3. Save all cookies to auth/hcp-cookies.json.
 */
export async function loginAndSave(): Promise<void> {
  await fs.mkdir(path.dirname(COOKIES_FILE), { recursive: true });
  await fs.mkdir(SESSION_DIR, { recursive: true });

  // ── Step 1: interactive login ────────────────────────────────────────────
  console.log('Opening browser — log into HCP, then close the window when done.\n');

  const loginCtx = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  await loginCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await loginCtx.newPage();
  await page.goto(`${BASE}/app/log_in`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch(() => {});

  await loginCtx.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await loginCtx.close().catch(() => {});

  // ── Step 2: headless extraction — lets React boot and set csrf_token ─────
  console.log('Extracting cookies (loading HCP app to get CSRF token)...');

  const extractCtx = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: true,
  });

  const page2 = await extractCtx.newPage();
  await page2.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch(() => {});

  // Poll up to 15s for csrf_token cookie to be set by the React app
  let csrf: { name: string } | undefined;
  for (let i = 0; i < 15; i++) {
    const cookies = await extractCtx.cookies(BASE);
    csrf = cookies.find(c => c.name === 'csrf_token');
    if (csrf) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  const cookies = await extractCtx.cookies(BASE);
  await extractCtx.close();

  if (!cookies.length) throw new Error('No cookies found — did you log in?');
  if (!csrf) console.warn('Warning: csrf_token not found — POST requests may fail. Try logging in again.');

  await fs.writeFile(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log(`Saved ${cookies.length} cookies${csrf ? ' (csrf_token ✓)' : ''} → ${COOKIES_FILE}`);
}

/** Read saved cookies and return as a Cookie header string. */
export async function getCookieHeader(): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(COOKIES_FILE, 'utf-8');
  } catch {
    throw new Error('No HCP session found. Run: npm run login');
  }

  const cookies: Array<{ name: string; value: string; expires?: number }> = JSON.parse(raw);
  if (!cookies.length) throw new Error('HCP cookie file is empty. Run: npm run login');

  // expires -1 = session cookie (keep); positive = Unix timestamp
  const now = Date.now() / 1000;
  const valid = cookies.filter(c => !c.expires || c.expires === -1 || c.expires > now);
  if (!valid.length) throw new Error('HCP session has expired. Run: npm run login');

  const hasCsrf = valid.some(c => c.name === 'csrf_token');
  if (!hasCsrf) {
    console.warn('[HCP] csrf_token missing from saved cookies — POST requests will fail. Run: npm run login');
  }

  return valid.map(c => `${c.name}=${c.value}`).join('; ');
}

// Run as CLI: npm run login
const isMain = /[/\\]hcp[/\\]auth\.(ts|js)$/.test(process.argv[1] ?? '');
if (isMain) loginAndSave().catch(console.error);
