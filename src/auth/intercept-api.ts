/**
 * One-time discovery tool: logs into HCP, intercepts all API calls made
 * during manual actions, and saves them to data/hcp-api-calls.json.
 *
 * Run: npm run intercept
 * Do your actions in the browser, then CLOSE THE BROWSER WINDOW when done.
 * Output saved to data/hcp-api-calls.json automatically.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';

const HCP_EMAIL    = process.env.HCP_EMAIL!;
const HCP_PASSWORD = process.env.HCP_PASSWORD!;
const OUT_FILE     = 'data/hcp-api-calls.json';

interface Capture {
  index: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
}

const captured: Capture[] = [];
let index = 0;

function save() {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(captured, null, 2));
}

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on('request', req => {
    const url = req.url();
    if (!url.includes('housecallpro.com')) return;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) return;
    if (/\.(js|css|png|jpg|svg|woff)/.test(url)) return;

    let body: unknown = null;
    try { body = JSON.parse(req.postData() ?? 'null'); } catch { body = req.postData(); }

    const headers = req.headers();
    const entry: Capture = {
      index: index++,
      method: req.method(),
      url,
      requestHeaders: {
        authorization: headers['authorization'] ?? '',
        'x-auth-token': headers['x-auth-token'] ?? '',
        'content-type': headers['content-type'] ?? '',
      },
      requestBody: body,
      responseStatus: 0,
      responseBody: null,
    };

    captured.push(entry);
    console.log(`[${entry.index}] ${entry.method} ${url}`);
    save(); // write after every request so nothing is lost
  });

  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('housecallpro.com')) return;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(res.request().method())) return;

    const entry = captured.findLast(c => c.url === url && c.responseStatus === 0);
    if (!entry) return;

    entry.responseStatus = res.status();
    try { entry.responseBody = await res.json(); } catch { entry.responseBody = await res.text().catch(() => null); }
    save();
  });

  // Log in
  console.log('Logging in...');
  await page.goto('https://pro.housecallpro.com/app/log_in', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="email"]', HCP_EMAIL);
  await page.fill('input[type="password"], input[name="password"]', HCP_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('https://pro.housecallpro.com/app/**', { timeout: 15_000 });

  console.log('\nLogged in. Do your actions in HCP now.');
  console.log(`API calls are being saved to ${OUT_FILE} in real time.`);
  console.log('CLOSE THE BROWSER WINDOW when done.\n');

  // Wait for browser to close
  await ctx.waitForEvent('close', { timeout: 0 }).catch(() => {});

  save();
  console.log(`\nDone. ${captured.length} calls captured → ${OUT_FILE}`);
}

run().catch(console.error);
