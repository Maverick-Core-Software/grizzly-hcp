/**
 * One-time discovery tool: logs into HCP, intercepts all API calls made
 * during a manual action, and prints them so we can reverse-engineer the
 * internal API for direct use.
 *
 * Run with: tsx src/auth/intercept-api.ts
 * Then manually create or edit an estimate in the browser window.
 * Press Ctrl+C when done — captured calls print to console.
 */
import 'dotenv/config';
import { chromium } from 'playwright';

const HCP_EMAIL    = process.env.HCP_EMAIL!;
const HCP_PASSWORD = process.env.HCP_PASSWORD!;

interface Capture {
  method: string;
  url: string;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
}

const captured: Capture[] = [];

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Intercept every request to housecallpro.com APIs
  page.on('request', req => {
    const url = req.url();
    if (!url.includes('housecallpro.com') && !url.includes('hcp.')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) return;
    if (url.includes('/assets/') || url.includes('.js') || url.includes('.css')) return;

    let body: unknown = null;
    try { body = JSON.parse(req.postData() ?? 'null'); } catch { body = req.postData(); }

    captured.push({ method: req.method(), url, requestBody: body, responseStatus: 0, responseBody: null });
  });

  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('housecallpro.com') && !url.includes('hcp.')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(res.request().method())) return;

    const entry = captured.findLast(c => c.url === url && c.responseStatus === 0);
    if (!entry) return;

    entry.responseStatus = res.status();
    try { entry.responseBody = await res.json(); } catch { entry.responseBody = await res.text().catch(() => null); }
  });

  // Log in
  console.log('Logging in...');
  await page.goto('https://pro.housecallpro.com/app/log_in', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="email"]', HCP_EMAIL);
  await page.fill('input[type="password"], input[name="password"]', HCP_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('https://pro.housecallpro.com/app/**', { timeout: 15_000 });
  console.log('Logged in. Browser is open — create or edit an estimate now.');
  console.log('All API calls will be captured. Press Ctrl+C when done.\n');

  // Grab auth headers from next API call
  ctx.on('request', async req => {
    if (!req.url().includes('housecallpro.com')) return;
    const headers = req.headers();
    if (headers['authorization'] || headers['x-auth-token']) {
      const token = headers['authorization'] ?? headers['x-auth-token'];
      if (!process.env._HCP_TOKEN_PRINTED) {
        console.log('\n=== AUTH TOKEN ===');
        console.log(token);
        console.log('==================\n');
        process.env._HCP_TOKEN_PRINTED = '1';
      }
    }
  });

  // Keep browser open until Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\n=== CAPTURED API CALLS ===\n');
    for (const c of captured) {
      console.log(`${c.method} ${c.url}`);
      if (c.requestBody) console.log('  REQ:', JSON.stringify(c.requestBody, null, 2));
      console.log(`  RES [${c.responseStatus}]:`, JSON.stringify(c.responseBody, null, 2)?.substring(0, 500));
      console.log();
    }
    console.log(`Total: ${captured.length} calls captured`);
    process.exit(0);
  });

  await new Promise(() => {}); // wait forever
}

run().catch(console.error);
