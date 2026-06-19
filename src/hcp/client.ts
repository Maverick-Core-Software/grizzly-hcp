/**
 * Base HTTP client for HCP's internal API.
 * Uses native fetch with cookies saved by auth.ts (npm run login).
 * No headless browser required for API calls.
 */
import { getCookieHeader } from './auth.js';

const BASE = 'https://pro.housecallpro.com';

let _cookieHeader: string | null = null;
let _csrfToken: string | null = null;

async function cookieHeader(): Promise<string> {
  if (!_cookieHeader) _cookieHeader = await getCookieHeader();
  return _cookieHeader;
}

/**
 * Fetch the CSRF token from HCP's app shell.
 * Rails requires X-CSRF-Token on all mutations (POST/PUT/PATCH/DELETE).
 * GET requests work without it — that's why searchCustomer succeeds but createEstimate gets 401.
 */
async function csrfToken(): Promise<string> {
  if (_csrfToken) return _csrfToken;

  const cookie = await cookieHeader();

  // HCP's JS sets a client-side cookie named 'csrf_token' after the app boots.
  // The bundle reads it via cookies.get("csrf_token") and sends it as X-CSRF-Token.
  const match = cookie.split('; ').find(c => c.startsWith('csrf_token='));
  if (match) {
    _csrfToken = decodeURIComponent(match.split('=').slice(1).join('='));
    return _csrfToken;
  }

  console.warn('[HCP] csrf_token cookie not found — run: npm run login');
  return '';
}

function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': BASE,
    'Referer': `${BASE}/app`,
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
}

async function request(method: string, path: string, body?: unknown): Promise<globalThis.Response> {
  const cookie = await cookieHeader();
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const csrf = isMutation ? await csrfToken() : '';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...baseHeaders(),
      Cookie: cookie,
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    _cookieHeader = null;
    _csrfToken = null;
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`HCP 401 on ${method} ${path}\nCSRF token used: ${csrf || '(none)'}\nResponse: ${body.slice(0, 300)}\n\nIf session is expired, run: npm run login`);
  }

  return res;
}

export async function hcpGet<T>(path: string): Promise<T> {
  const res = await request('GET', path);
  if (!res.ok) throw new Error(`HCP GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function hcpPost<T>(path: string, body: unknown): Promise<T> {
  const res = await request('POST', path, body);
  if (!res.ok) throw new Error(`HCP POST ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** POST with application/x-www-form-urlencoded body (required by /pro/ endpoints). */
export async function hcpPostForm<T>(path: string, params: Record<string, string | boolean | number>): Promise<T> {
  const cookie = await cookieHeader();
  const csrf = await csrfToken();
  const body = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': BASE,
      'Referer': `${BASE}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-Token': csrf,
      Cookie: cookie,
    },
    body,
  });

  if (res.status === 401) {
    _cookieHeader = null;
    _csrfToken = null;
    throw new Error(`HCP 401 on POST ${path} — run: npm run login`);
  }
  if (!res.ok) throw new Error(`HCP POST ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function hcpPut<T>(path: string, body: unknown): Promise<T> {
  const res = await request('PUT', path, body);
  if (!res.ok) throw new Error(`HCP PUT ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function hcpPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await request('PATCH', path, body);
  if (!res.ok) throw new Error(`HCP PATCH ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function hcpDelete(path: string): Promise<void> {
  const res = await request('DELETE', path);
  if (!res.ok) throw new Error(`HCP DELETE ${path} → ${res.status}: ${await res.text()}`);
}

export function closeClient(): void {
  _cookieHeader = null;
}
