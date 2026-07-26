/**
 * Use Playwright directly to navigate the HCP estimate page and 
 * intercept the actual XHR/fetch calls when changing service address.
 * We'll inject a fetch interceptor, navigate to the estimate, 
 * and simulate the address change.
 */
import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();

// Parse cookies into name=value pairs for Playwright
const cookies = cookie.split('; ').map(c => {
  const [name, ...rest] = c.split('=');
  return { name, value: rest.join('='), domain: '.housecallpro.com', path: '/' };
});

const { chromium } = await import('playwright');

const browser = await chromium.launch({ 
  channel: 'chrome',
  headless: true 
});
const context = await browser.newContext();
await context.addCookies(cookies);

const page = await context.newPage();

// Intercept all requests
const requests: string[] = [];
page.on('request', (req) => {
  const method = req.method();
  if (['PATCH', 'POST', 'PUT'].includes(method)) {
    const url = req.url();
    if (url.includes('housecallpro.com') && !url.includes('.js') && !url.includes('analytics')) {
      requests.push(`${method} ${url.replace('https://', '')}`);
      // Log the request body for mutation calls
      const body = req.postData();
      if (body) {
        requests.push(`  body: ${body.slice(0, 200)}`);
      }
    }
  }
});

// Navigate to the estimate page
console.log('Navigating to estimate page...');
await page.goto('https://app.housecallpro.com/app/estimates/467166953', { 
  waitUntil: 'networkidle',
  timeout: 30000 
});

console.log('Page title:', await page.title());
console.log('Page URL:', page.url());

// Wait for the page to fully load
await page.waitForTimeout(3000);

// Look for the service address element  
const addressText = await page.locator('text=1505 South Westmoreland').count();
console.log('Old address elements found:', addressText);

// Look for a dropdown/select for service address
const selectCount = await page.locator('select, [role="combobox"], [role="listbox"]').count();
console.log('Dropdown/combobox elements:', selectCount);

// Look for the address dropdown specifically
const addrDropdowns = await page.locator('[data-test*="address"], [class*="address"], [aria-label*="address"]').count();
console.log('Address-related elements:', addrDropdowns);

// Dump a portion of the page content to understand the layout
const pageText = await page.locator('body').innerText();
// Find address-related section
const lines = pageText.split('\n').filter(l => 
  l.toLowerCase().includes('address') || 
  l.toLowerCase().includes('westmoreland') ||
  l.toLowerCase().includes('sycamore')
);
console.log('\nAddress-related text on page:');
for (const line of lines.slice(0, 10)) {
  console.log('  ', line.slice(0, 100));
}

console.log('\n\nAll intercepted mutation requests:');
for (const r of requests) {
  console.log(r);
}

await browser.close();
