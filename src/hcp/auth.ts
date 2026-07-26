/**
 * HCP auth compatibility shim — re-exports all names so existing importers keep working.
 *
 * The implementation has been split into two modules:
 *   - ./auth-cookies.js : Playwright-free runtime (getCookieHeader, COOKIES_FILE)
 *   - ./auth-login.js   : Interactive login flow (loginAndSave, SESSION_DIR)
 *
 * This file keeps the CLI self-invoke block so `npm run login` (tsx src/hcp/auth.ts)
 * continues to work without touching package.json.
 */

export { COOKIES_FILE } from './auth-cookies.js';
export { getCookieHeader } from './auth-cookies.js';
export { SESSION_DIR } from './auth-login.js';
export { loginAndSave } from './auth-login.js';

// Run as CLI: npm run login
const isMain = /[/\\]hcp[/\\]auth\.(ts|js)$/.test(process.argv[1] ?? '');
if (isMain) loginAndSave().catch(console.error);
