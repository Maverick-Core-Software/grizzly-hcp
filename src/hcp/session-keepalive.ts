/**
 * HCP session keepalive — rolls the saved cookie jar forward without a browser.
 *
 * HCP's Rails session cookie (_housecall-web_session_with_domain) carries a
 * ~14-day expiry, and the server re-issues it with a fresh 14-day window on
 * every authenticated request. So one cheap authenticated GET is enough to keep
 * the direct-client session alive indefinitely — no Playwright, no Google
 * OAuth, no password. Verified 2026-08-29: a GET on the probe path returned
 * `Set-Cookie: _housecall-web_session_with_domain … expires=12 Sep 2026` against
 * a jar whose saved copy expired 31 Aug.
 *
 * This exists because `npm run relogin` no longer works. HCP replaced its
 * "Sign in with Google" text button with a Google Identity Services <iframe>
 * (accounts.google.com/gsi/button), so the `text=Sign in with Google` selector
 * in scripts/hcp-relogin.ts matches nothing and the run dies waiting for an
 * OAuth popup that never opens — see logs/relogin.log, 2026-08-24.
 *
 * A 401 here is the real "session is dead" signal. The expiry check in
 * scripts/check-hcp-cookies.ts cannot tell the difference: a logged-out browser
 * gets a fresh 14-day session cookie from the login page too, so expiry alone
 * still looks healthy while every authenticated call 401s.
 *
 * ponytail: parse/merge are pure and separately checked; only keepAlive() does
 * I/O. It writes through a temp file + rename so a crash mid-write cannot leave
 * a truncated cookie jar — that jar is the only thing standing between the
 * voice booking path and another silent 401 outage.
 */
import fs from 'fs/promises';
import { COOKIES_FILE } from './auth-cookies.js';

const BASE = 'https://pro.housecallpro.com';

/** Cheapest authenticated read on the HCP allowlist — the same probe preflight uses. */
export const KEEPALIVE_PATH = '/alpha/pricebook/industries';

/** The cookie whose expiry gates the whole direct-client session. */
export const SESSION_COOKIE = '_housecall-web_session_with_domain';

/** A cookie as stored by Playwright in auth/hcp-cookies.json. */
export interface SavedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  /** Unix seconds, or -1 for a session cookie (no Expires/Max-Age). */
  expires: number;
  domain?: string;
  path?: string;
  secure: boolean;
  httpOnly: boolean;
}

/**
 * Parse one raw Set-Cookie header value. Returns null for anything without a
 * usable `name=value` pair. Max-Age wins over Expires, per RFC 6265 section 5.3.
 */
export function parseSetCookie(raw: string, now = Date.now()): ParsedSetCookie | null {
  const parts = raw.split(';');
  const pair = parts[0] ?? '';
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;

  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  const out: ParsedSetCookie = { name, value, expires: -1, secure: false, httpOnly: false };

  let maxAge: number | null = null;
  let expiresAt: number | null = null;

  for (const attr of parts.slice(1)) {
    const i = attr.indexOf('=');
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : attr.slice(i + 1).trim();

    if (key === 'max-age') {
      const n = Number(val);
      if (Number.isFinite(n)) maxAge = n;
    } else if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expiresAt = t / 1000;
    } else if (key === 'domain') {
      out.domain = val;
    } else if (key === 'path') {
      out.path = val;
    } else if (key === 'secure') {
      out.secure = true;
    } else if (key === 'httponly') {
      out.httpOnly = true;
    }
  }

  if (maxAge !== null) out.expires = now / 1000 + maxAge;
  else if (expiresAt !== null) out.expires = expiresAt;

  return out;
}

export interface MergeResult {
  cookies: SavedCookie[];
  /** Names whose value or expiry the server changed. */
  rotated: string[];
}

/**
 * Fold Set-Cookie headers into the saved jar. Existing entries keep their
 * stored domain/path/sameSite (Playwright's normalised form) and take the
 * server's new value + expiry; unknown cookies are appended.
 */
export function mergeSetCookies(
  saved: SavedCookie[],
  rawSetCookies: string[],
  now = Date.now(),
): MergeResult {
  const cookies = saved.map((c) => ({ ...c }));
  const rotated: string[] = [];

  for (const raw of rawSetCookies) {
    const parsed = parseSetCookie(raw, now);
    if (!parsed) continue;

    const existing = cookies.find((c) => c.name === parsed.name);
    if (existing) {
      if (existing.value !== parsed.value || existing.expires !== parsed.expires) {
        rotated.push(parsed.name);
      }
      existing.value = parsed.value;
      existing.expires = parsed.expires;
    } else {
      rotated.push(parsed.name);
      cookies.push({
        name: parsed.name,
        value: parsed.value,
        domain: parsed.domain ?? new URL(BASE).hostname,
        path: parsed.path ?? '/',
        expires: parsed.expires,
        httpOnly: parsed.httpOnly,
        secure: parsed.secure,
        sameSite: 'Lax',
      });
    }
  }

  return { cookies, rotated };
}

export interface KeepaliveResult {
  ok: boolean;
  status: number;
  rotated: string[];
  /** Session-cookie expiry after the merge, or null if it is absent. */
  expiresAt: Date | null;
  daysLeft: number | null;
  /**
   * Session-cookie expiry as found on disk, *before* this request.
   *
   * This is the only field that shows whether the scheduled keepalive has
   * actually been running. `expiresAt` is always ~14 days out because the
   * server just re-issued it — so a verification run that reports `expiresAt`
   * would look healthy even if nothing had touched the jar in a fortnight.
   */
  storedExpiresAt: Date | null;
  storedDaysLeft: number | null;
  detail: string;
}

function requestHeaders(cookieHeader: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Origin: BASE,
    Referer: `${BASE}/app`,
    'X-Requested-With': 'XMLHttpRequest',
    Cookie: cookieHeader,
  };
}

function fail(
  status: number,
  detail: string,
  stored: { at: Date | null; days: number | null } = { at: null, days: null },
): KeepaliveResult {
  return {
    ok: false,
    status,
    rotated: [],
    expiresAt: null,
    daysLeft: null,
    storedExpiresAt: stored.at,
    storedDaysLeft: stored.days,
    detail,
  };
}

/**
 * One authenticated GET, then write back whatever the server re-issued.
 * Never throws — every failure comes back as { ok: false, detail }, so the
 * caller decides whether it is alert-worthy.
 */
export async function keepAlive(
  opts: { cookiesFile?: string; fetchImpl?: typeof fetch; dryRun?: boolean } = {},
): Promise<KeepaliveResult> {
  const file = opts.cookiesFile ?? COOKIES_FILE;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let saved: SavedCookie[];
  try {
    saved = JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return fail(0, `No readable cookie file at ${file}`);
  }
  if (!Array.isArray(saved) || !saved.length) return fail(0, `Cookie file is empty: ${file}`);

  const now = Date.now();

  const storedSession = saved.find((c) => c.name === SESSION_COOKIE);
  const storedAt =
    storedSession?.expires && storedSession.expires > 0 ? new Date(storedSession.expires * 1000) : null;
  const stored = {
    at: storedAt,
    days: storedAt ? (storedAt.getTime() - now) / 86_400_000 : null,
  };

  const cookieHeader = saved
    .filter((c) => !c.expires || c.expires === -1 || c.expires > now / 1000)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (!cookieHeader) return fail(0, 'Every saved cookie is past its expiry', stored);

  let res: globalThis.Response;
  try {
    res = await fetchImpl(`${BASE}${KEEPALIVE_PATH}`, { headers: requestHeaders(cookieHeader) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(0, `GET ${KEEPALIVE_PATH} failed: ${message}`, stored);
  }

  if (res.status === 401 || res.status === 403) {
    return fail(
      res.status,
      `GET ${KEEPALIVE_PATH} → ${res.status}. The HCP session is dead; a human sign-in is required.`,
      stored,
    );
  }
  if (!res.ok) return fail(res.status, `GET ${KEEPALIVE_PATH} → ${res.status}`, stored);

  const rawSetCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const { cookies, rotated } = mergeSetCookies(saved, rawSetCookies, now);

  // dryRun still makes the real authenticated request — that is the whole point
  // of a verification run — it just declines to keep what the server handed back.
  if (!opts.dryRun) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cookies, null, 2));
    await fs.rename(tmp, file);
  }

  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  const expiresAt = session?.expires && session.expires > 0 ? new Date(session.expires * 1000) : null;
  const daysLeft = expiresAt ? (expiresAt.getTime() - now) / 86_400_000 : null;

  return {
    ok: true,
    status: res.status,
    rotated,
    expiresAt,
    daysLeft,
    storedExpiresAt: stored.at,
    storedDaysLeft: stored.days,
    detail: rotated.length
      ? `server re-issued ${rotated.join(', ')}`
      : 'session still valid; server re-issued nothing',
  };
}
