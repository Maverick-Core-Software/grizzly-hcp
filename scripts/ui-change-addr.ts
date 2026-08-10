/**
 * Navigate to the HCP estimate page in Playwright, wait for the SPA to
 * fully render, then click the address selector and pick 500 Sycamore.
 * Intercept the resulting network request to learn the endpoint.
 */
import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();
const cookies: any[] = [];
for (const c of cookie.split('; ')) {
  const idx = c.indexOf('=');
  cookies.push({ 
    name: c.slice(0, idx), 
    value: c.slice(idx + 1), 
    domain: '.housecallpro.com', 
    path: '/' 
  });
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies(cookies);
const page = await context.newPage();

// Intercept ALL requests including GETs to find the estimate data endpoint
const apiRequests: string[] = [];
page.on('request', (req) => {
  const url = req.url();
  const method = req.method();
  // Log all alpha/api requests  
  if ((url.includes('/alpha/') || url.includes('/api/')) && !url.includes('sendbird') && !url.includes('analytics')) {
    apiRequests.push(`${method} ${url.replace('https://app.housecallpro.com', '').replace('https://pro.housecallpro.com', 'pro:')}`);
  }
});

// Also log mutations specifically
const mutations: any[] = [];
page.on('request', (req) => {
  if (['PATCH', 'POST', 'PUT', 'DELETE'].includes(req.method()) && 
      req.url().includes('housecallpro.com') &&
      !req.url().includes('segment') && 
      !req.url().includes('sendbird') && 
      !req.url().includes('google') &&
      !req.url().includes('analytics')) {
    mutations.push({
      method: req.method(),
      url: req.url().replace('https://app.housecallpro.com', '').replace('https://pro.housecallpro.com', 'pro:'),
      body: req.postData()?.slice(0, 500),
    });
  }
});

console.log('Navigating to estimate...');
await page.goto('https://app.housecallpro.com/app/estimates/467166953', { 
  waitUntil: 'domcontentloaded',
  timeout: 20000,
});

// Wait for the SPA to render the estimate detail
console.log('Waiting for SPA render...');
await page.waitForTimeout(8000);

// Take screenshot to see what's on screen
await page.screenshot({ path: '/tmp/hcp-estimate.png' });
console.log('Screenshot saved');

// Check for the address text
const bodyText = await page.locator('body').innerText();
const hasOldAddr = bodyText.includes('Westmoreland');
const hasNewAddr = bodyText.includes('Sycamore');
console.log('Has old address text:', hasOldAddr);
console.log('Has new address text:', hasNewAddr);

// Print all alpha/api GET requests to understand what data was loaded
console.log('\n=== All /alpha/ and /api/ requests ===');
for (const r of apiRequests.slice(0, 30)) {
  console.log(r);
}

// Now try to find and click the address dropdown
// HCP uses a custom dropdown component - let's look for clickable address elements
try {
  // Find all elements containing "Westmoreland"
  const elements = await page.locator('text=Westmoreland').all();
  console.log(`\nFound ${elements.length} elements with 'Westmoreland'`);
  for (let i = 0; i < Math.min(elements.length, 3); i++) {
    const el = elements[i];
    const tag = await el.evaluate(e => e.tagName);
    const parent = await el.evaluate(e => {
      let p = e.parentElement;
      let chain = e.tagName;
      let cur = e;
      for (let j = 0; j < 5 && cur.parentElement; j++) {
        cur = cur.parentElement;
        chain = cur.tagName + (cur.className ? '.' + String(cur.className).split(' ').slice(0,2).join('.') : '') + ' > ' + chain;
      }
      return chain;
    });
    console.log(`  [${i}] <${tag}> chain: ${parent.slice(0, 150)}`);
  }
  
  // Click on the first address element
  if (elements.length > 0) {
    console.log('\nClicking address element...');
    await elements[0].click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    
    // Check for dropdown with addresses
    const sycamoreOpt = page.locator('text=500 Sycamore');
    const sycCount = await sycamoreOpt.count();
    console.log('Sycamore options visible after click:', sycCount);
    
    if (sycCount > 0) {
      console.log('Clicking 500 Sycamore...');
      await sycamoreOpt.first().click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    }
  }
} catch (e: any) {
  console.log('Interaction error:', e.message.slice(0, 200));
}

console.log('\n=== Mutations after interactions ===');
for (const m of mutations) {
  console.log(`${m.method} ${m.url}`);
  if (m.body) console.log(`  body: ${m.body}`);
}

await browser.close();
