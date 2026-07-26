/**
 * HCP cookie runtime — Playwright-free.
 * Called by client.ts and any HCP API consumer at runtime.
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_COOKIES_FILE = path.resolve(__dirname, '../../auth/hcp-cookies.json');
export const COOKIES_FILE = process.env.HCP_COOKIES_FILE || DEFAULT_COOKIES_FILE;

/** Read saved cookies and return as a Cookie header string. */
export async function getCookieHeader(): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(COOKIES_FILE, 'utf-8');
  } catch {
    throw new Error('No HCP session found. Run: npm run login');
  }

  const cookies: Array<{ name: string; value: string; expires?: number }> = JSON.parse(raw);
  if (!cookies.length) throw new Error('HCP cookie file is empty. Run: npm run login');

  // expires -1 = session cookie (keep); positive = Unix timestamp
  const now = Date.now() / 1000;
  const valid = cookies.filter(c => !c.expires || c.expires === -1 || c.expires > now);
  if (!valid.length) throw new Error('HCP session has expired. Run: npm run login');

  const hasCsrf = valid.some(c => c.name === 'csrf_token');
  if (!hasCsrf) {
    console.warn('[HCP] csrf_token missing from saved cookies — POST requests will fail. Run: npm run login');
  }

  return valid.map(c => `${c.name}=${c.value}`).join('; ');
}
