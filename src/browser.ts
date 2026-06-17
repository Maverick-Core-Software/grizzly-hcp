import { chromium, type Browser, type BrowserContext } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, '../auth/session');

let browser: Browser | null = null;
let context: BrowserContext | null = null;

export async function getContext(): Promise<BrowserContext> {
  if (context) return context;

  browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    slowMo: Number(process.env.SLOW_MO ?? 0),
  });

  context = await browser.newContext({
    storageState: await hasSession() ? SESSION_DIR : undefined,
    viewport: { width: 1280, height: 900 },
  });

  return context;
}

export async function saveSession(): Promise<void> {
  if (!context) throw new Error('No browser context to save');
  await context.storageState({ path: SESSION_DIR });
  console.log('Session saved.');
}

export async function closeBrowser(): Promise<void> {
  await context?.close();
  await browser?.close();
  context = null;
  browser = null;
}

async function hasSession(): Promise<boolean> {
  try {
    const fs = await import('fs/promises');
    await fs.access(SESSION_DIR);
    return true;
  } catch {
    return false;
  }
}
