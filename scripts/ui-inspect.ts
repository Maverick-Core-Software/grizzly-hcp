import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();
const cookies: any[] = [];
for (const c of cookie.split('; ')) {
  const idx = c.indexOf('=');
  cookies.push({ name: c.slice(0, idx), value: c.slice(idx + 1), domain: '.housecallpro.com', path: '/' });
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies(cookies);
const page = await context.newPage();

// Collect mutation requests
const mutations: any[] = [];
page.on('request', (req) => {
  if (['PATCH', 'POST', 'PUT', 'DELETE'].includes(req.method()) &&
      req.url().includes('housecallpro.com') &&
      !req.url().includes('segment') &&
      !req.url().includes('sendbird') &&
      !req.url().includes('google') &&
      !req.url().includes('analytics') &&
      !req.url().includes('sentry')) {
    mutations.push({
      method: req.method(),
      url: req.url().replace('https://app.housecallpro.com', '').replace('https://pro.housecallpro.com', 'pro:'),
      body: req.postData()?.slice(0, 500),
    });
  }
});

await page.goto('https://app.housecallpro.com/app/estimates/467166953', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(10000);

const text = await page.locator('body').innerText();
console.log('PAGE TEXT (first 3000 chars):');
console.log(text.slice(0, 3000));
console.log('\n--- Has Westmoreland:', text.includes('Westmoreland'));
console.log('--- Has Sycamore:', text.includes('Sycamore'));
console.log('--- Has 1388:', text.includes('1388'));
console.log('--- Has Remodel:', text.includes('Remodel'));

// Try to find the address area - it might be an icon/button rather than text
// Look for all clickable elements near "Service" or address-like content
const allButtons = await page.locator('button, [role="button"], [role="combobox"], [role="listbox"], [data-testid]').all();
console.log(`\nFound ${allButtons.length} interactive elements`);
for (let i = 0; i < Math.min(allButtons.length, 30); i++) {
  const el = allButtons[i];
  const text = (await el.innerText().catch(() => '')).trim();
  if (text && text.length < 100) {
    console.log(`  [${i}] ${text}`);
  }
}

await browser.close();
