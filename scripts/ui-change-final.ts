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

// Collect ALL mutation requests
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

console.log('Navigating to estimate...');
await page.goto('https://app.housecallpro.com/app/estimates/494624336', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(8000);

// Find and click the address "1505 South Westmoreland Road"
console.log('Looking for address element...');
const addrLocator = page.locator('text=1505 South Westmoreland Road');
const addrCount = await addrLocator.count();
console.log(`Found ${addrCount} elements with address text`);

if (addrCount > 0) {
  // Click on the address text to open the dropdown/editor
  console.log('Clicking address...');
  await addrLocator.first().click({ timeout: 5000 });
  await page.waitForTimeout(3000);
  
  // Check what appeared - look for address dropdown with all customer's addresses
  const bodyText = await page.locator('body').innerText();
  console.log('\nAfter click - has Sycamore:', bodyText.includes('Sycamore'));
  console.log('After click - has Cow Alley:', bodyText.includes('Cow Alley'));
  console.log('After click - has Davenport:', bodyText.includes('Davenport'));
  
  // Print all addresses visible in the dropdown
  const addressKeywords = ['Sycamore', 'Cow Alley', 'Davenport', 'Horne', 'Downey', 'Mercer', 'Stacks', 'Hickory', 'Newton', 'Las Colinas', 'Bailey', 'Jaes', 'Southwood', 'Clublake', 'Bellflower', 'Clark', 'Patterson', 'Hogan', 'Adam', 'Buckboard', 'Pete', 'Pigg', 'Horseshoe', 'Baldwin'];
  for (const kw of addressKeywords) {
    if (bodyText.includes(kw)) {
      console.log(`  Found address keyword: ${kw}`);
    }
  }
  
  // Look for "500 Sycamore" specifically
  const sycamoreEl = page.locator('text=500 Sycamore');
  const sycCount = await sycamoreEl.count();
  console.log(`\nSycamore options visible: ${sycCount}`);
  
  if (sycCount > 0) {
    console.log('Clicking 500 Sycamore...');
    await sycamoreEl.first().click({ timeout: 5000 });
    await page.waitForTimeout(5000);
    
    // Verify the address changed
    const finalText = await page.locator('body').innerText();
    console.log('\nAfter selection - has Sycamore:', finalText.includes('Sycamore'));
    console.log('After selection - has Westmoreland:', finalText.includes('Westmoreland'));
  } else {
    // Maybe need to look for it differently
    console.log('\nNo Sycamore option visible. Dumping all text after click...');
    console.log(bodyText.slice(0, 4000));
  }
}

console.log('\n=== All intercepted mutations ===');
for (const m of mutations) {
  console.log(`${m.method} ${m.url}`);
  if (m.body) console.log(`  body: ${m.body}`);
}

await browser.close();
