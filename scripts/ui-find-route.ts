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

// The correct URL for HCP React app uses the composite_service_request numeric ID
// Try /app/requests/{csr_id} or /app/estimates/{csr_id} with full numeric path
console.log('Trying /app/estimates/494624336...');
await page.goto('https://app.housecallpro.com/app/estimates/494624336', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(8000);

let text = await page.locator('body').innerText();
console.log('Has Westmoreland:', text.includes('Westmoreland'));
console.log('Has 1388:', text.includes('1388'));
console.log('Has Remodel:', text.includes('Remodel'));
console.log('Has not found:', text.includes('not found'));

if (text.includes('not found')) {
  // Try the CSR ID  
  console.log('\nTrying /app/requests/467166953...');
  await page.goto('https://app.housecallpro.com/app/requests/467166953', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(8000);
  text = await page.locator('body').innerText();
  console.log('Has Westmoreland:', text.includes('Westmoreland'));
  console.log('Has 1388:', text.includes('1388'));
  console.log('Has not found:', text.includes('not found'));
}

if (text.includes('not found')) {
  // Try searching for the estimate from the main page
  console.log('\nTrying /app/jobs/494624336...');
  await page.goto('https://app.housecallpro.com/app/jobs/494624336', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(8000);
  text = await page.locator('body').innerText();
  console.log('Has Westmoreland:', text.includes('Westmoreland'));
  console.log('Has 1388:', text.includes('1388'));
  console.log('Has Remodel:', text.includes('Remodel'));
  console.log('Has not found:', text.includes('not found'));
}

if (!text.includes('not found')) {
  console.log('\nPAGE TEXT (first 2000 chars):');
  console.log(text.slice(0, 2000));
}

await browser.close();
