import 'dotenv/config';
import { getContext, saveSession, closeBrowser } from '../browser.js';

const HCP_URL = 'https://pro.housecallpro.com/app/log_in';

export async function login(): Promise<void> {
  const email = process.env.HCP_EMAIL;
  const password = process.env.HCP_PASSWORD;
  if (!email || !password) throw new Error('HCP_EMAIL and HCP_PASSWORD must be set in .env');

  const ctx = await getContext();
  const page = await ctx.newPage();

  console.log('Navigating to HCP login...');
  await page.goto(HCP_URL, { waitUntil: 'networkidle' });

  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', password);
  await page.click('button[type="submit"], input[type="submit"]');

  await page.waitForURL('https://pro.housecallpro.com/app/**', { timeout: 15_000 });
  console.log('Logged in successfully.');

  await saveSession();
  await page.close();
}

// Run directly: npm run login
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  login().finally(closeBrowser);
}

function fileURLToPath(url: string) {
  return new URL(url).pathname.replace(/^\/([A-Z]:)/, '$1');
}
