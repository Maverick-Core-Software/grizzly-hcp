/**
 * Use the HCP-MCP Playwright browser to navigate to the estimate page,
 * intercept network requests, and click the address dropdown to see
 * what XHR the HCP web app actually fires.
 * 
 * We call this via the LXC MCP server's raw page.evaluate since the MCP
 * server's Playwright session is already authenticated.
 */
import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();

// Parse cookies for Playwright
const cookies: any[] = [];
for (const c of cookie.split('; ')) {
  const idx = c.indexOf('=');
  const name = c.slice(0, idx);
  const value = c.slice(idx + 1);
  cookies.push({ name, value, domain: '.housecallpro.com', path: '/' });
}

const { chromium } = await import('playwright');

const browser = await chromium.launch({ 
  channel: 'chrome',
  headless: true,
});
const context = await browser.newContext();
await context.addCookies(cookies);

const page = await context.newPage();

// Collect all XHR/fetch requests
const allRequests: any[] = [];
page.on('request', (req) => {
  const method = req.method();
  if (method !== 'GET' && req.url().includes('housecallpro.com')) {
    allRequests.push({
      method,
      url: req.url().replace('https://app.housecallpro.com', '').replace('https://pro.housecallpro.com', 'pro:'),
      body: req.postData()?.slice(0, 300),
    });
  }
});

console.log('Navigating to estimate...');
try {
  await page.goto('https://app.housecallpro.com/app/estimates/467166953', { 
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
} catch (e: any) {
  console.log('Navigation timeout/error:', e.message.slice(0, 100));
}

// Give it time to load
await page.waitForTimeout(5000);

console.log('Page URL:', page.url());

// Look for address-related UI elements  
try {
  // The HCP Ember app has a service address dropdown
  // Look for elements containing "1505 South Westmoreland"
  const addrElement = page.locator('text=1505 South Westmoreland').first();
  const addrVisible = await addrElement.isVisible().catch(() => false);
  console.log('Address text visible:', addrVisible);
  
  if (addrVisible) {
    // Click on the address to open the dropdown/editor
    await addrElement.click();
    await page.waitForTimeout(2000);
    
    // Look for "500 Sycamore" in the dropdown
    const sycamore = page.locator('text=500 Sycamore').first();
    const sycVisible = await sycamore.isVisible().catch(() => false);
    console.log('Sycamore option visible:', sycVisible);
    
    if (sycVisible) {
      await sycamore.click();
      await page.waitForTimeout(3000);
      console.log('Clicked Sycamore!');
    }
  }
} catch (e: any) {
  console.log('UI interaction error:', e.message.slice(0, 200));
}

console.log('\n=== Intercepted non-GET requests ===');
for (const r of allRequests) {
  console.log(`${r.method} ${r.url}`);
  if (r.body) console.log(`  body: ${r.body}`);
}

await browser.close();
