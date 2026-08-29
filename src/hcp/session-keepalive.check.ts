/**
 * Logic check for the HCP session keepalive.
 *
 * Covers the pure halves (parseSetCookie, mergeSetCookies) exhaustively and
 * drives keepAlive() through an injected fetch so no live HCP call is made and
 * no real cookie jar is touched — every case writes to a temp file.
 *
 * The invariant that matters: a keepalive run must never leave the jar worse
 * than it found it. On any failure path the file is untouched; on success the
 * session cookie's expiry has moved forward and csrf_token is still present.
 *
 * Run: npx tsx src/hcp/session-keepalive.check.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  KEEPALIVE_PATH,
  SESSION_COOKIE,
  keepAlive,
  mergeSetCookies,
  parseSetCookie,
  type SavedCookie,
} from './session-keepalive.js';

const NOW = Date.parse('2026-08-29T12:00:00.000Z');

function jar(): SavedCookie[] {
  return [
    {
      name: SESSION_COOKIE,
      value: 'old-session-value',
      domain: '.pro.housecallpro.com',
      path: '/',
      expires: Date.parse('2026-08-31T13:00:13.000Z') / 1000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: 'csrf_token',
      value: 'csrf-abc',
      domain: 'pro.housecallpro.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    },
  ];
}

async function withTempJar<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hcp-keepalive-'));
  const file = path.join(dir, 'hcp-cookies.json');
  try {
    await fs.writeFile(file, JSON.stringify(jar(), null, 2));
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A fetch stand-in that answers the keepalive probe with a fixed response. */
function fakeFetch(status: number, setCookies: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    assert.ok(String(url).endsWith(KEEPALIVE_PATH), 'keepalive hits the probe path');
    const headers = new Headers();
    for (const sc of setCookies) headers.append('set-cookie', sc);
    return new Response(status === 204 ? null : '[]', { status, headers });
  }) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  // ─── 1. parseSetCookie ───────────────────────────────────────────────────
  const expires = parseSetCookie(
    `${SESSION_COOKIE}=abc123; path=/; expires=Sat, 12 Sep 2026 06:22:36 GMT; secure; HttpOnly; SameSite=Lax`,
    NOW,
  );
  assert.ok(expires, 'parses a well-formed Set-Cookie');
  assert.equal(expires.name, SESSION_COOKIE);
  assert.equal(expires.value, 'abc123');
  assert.equal(expires.expires, Date.parse('2026-09-12T06:22:36.000Z') / 1000);
  assert.equal(expires.secure, true);
  assert.equal(expires.httpOnly, true);
  assert.equal(expires.path, '/');

  const maxAge = parseSetCookie(`a=b; Max-Age=3600; Expires=Sat, 12 Sep 2026 06:22:36 GMT`, NOW);
  assert.equal(maxAge?.expires, NOW / 1000 + 3600, 'Max-Age wins over Expires (RFC 6265)');

  const sessionOnly = parseSetCookie('a=b; path=/', NOW);
  assert.equal(sessionOnly?.expires, -1, 'no Expires/Max-Age means a session cookie (-1)');

  assert.equal(parseSetCookie('', NOW), null, 'empty header is rejected');
  assert.equal(parseSetCookie('novalue', NOW), null, 'a bare token with no = is rejected');
  assert.equal(parseSetCookie('=novalue; path=/', NOW), null, 'an empty cookie name is rejected');

  const emptyValue = parseSetCookie('a=; path=/', NOW);
  assert.equal(emptyValue?.value, '', 'an empty value is legal and preserved');

  const withEquals = parseSetCookie('a=b=c=d; path=/', NOW);
  assert.equal(withEquals?.value, 'b=c=d', 'only the first = splits name from value');

  // ─── 2. mergeSetCookies ──────────────────────────────────────────────────
  const rolled = `${SESSION_COOKIE}=new-session-value; path=/; expires=Sat, 12 Sep 2026 06:22:36 GMT; secure; HttpOnly`;
  const merged = mergeSetCookies(jar(), [rolled], NOW);

  assert.equal(merged.cookies.length, 2, 'rotating an existing cookie does not add an entry');
  assert.deepEqual(merged.rotated, [SESSION_COOKIE], 'only the changed cookie is reported rotated');

  const session = merged.cookies.find((c) => c.name === SESSION_COOKIE);
  assert.equal(session?.value, 'new-session-value', 'the server value replaces the stored one');
  assert.equal(session?.expires, Date.parse('2026-09-12T06:22:36.000Z') / 1000, 'expiry moves forward');
  assert.equal(session?.domain, '.pro.housecallpro.com', "Playwright's stored domain survives the merge");

  const csrf = merged.cookies.find((c) => c.name === 'csrf_token');
  assert.equal(csrf?.value, 'csrf-abc', 'a cookie the server did not re-issue is left alone');
  assert.equal(csrf?.expires, -1, 'and keeps its session-cookie expiry');

  const unchanged = mergeSetCookies(jar(), ['csrf_token=csrf-abc; path=/; secure'], NOW);
  assert.deepEqual(
    unchanged.rotated,
    [],
    're-issuing a cookie byte-identical to the stored one is not reported as rotated',
  );
  assert.deepEqual(unchanged.cookies, jar(), 'and it leaves the jar untouched');

  const added = mergeSetCookies(jar(), ['brand_new=1; path=/; secure'], NOW);
  assert.equal(added.cookies.length, 3, 'an unknown cookie is appended');
  assert.equal(added.cookies[2]?.name, 'brand_new');
  assert.equal(added.cookies[2]?.domain, 'pro.housecallpro.com', 'appended cookies get the HCP host');

  const noHeaders = mergeSetCookies(jar(), [], NOW);
  assert.deepEqual(noHeaders.rotated, [], 'no Set-Cookie means nothing rotated');
  assert.deepEqual(noHeaders.cookies, jar(), 'and the jar is returned unchanged');

  assert.notEqual(mergeSetCookies(jar(), [rolled], NOW).cookies[0], jar()[0], 'merge does not mutate its input');

  // ─── 3. keepAlive — success path ─────────────────────────────────────────
  await withTempJar(async (file) => {
    const before = JSON.parse(await fs.readFile(file, 'utf-8')) as SavedCookie[];
    const r = await keepAlive({ cookiesFile: file, fetchImpl: fakeFetch(200, [rolled]) });

    assert.equal(r.ok, true, 'a 200 is a healthy keepalive');
    assert.equal(r.status, 200);
    assert.deepEqual(r.rotated, [SESSION_COOKIE]);
    assert.ok(r.daysLeft !== null && r.daysLeft > 13, 'the session is pushed ~14 days out');

    const after = JSON.parse(await fs.readFile(file, 'utf-8')) as SavedCookie[];
    const afterSession = after.find((c) => c.name === SESSION_COOKIE)!;
    const beforeSession = before.find((c) => c.name === SESSION_COOKIE)!;
    assert.ok(afterSession.expires! > beforeSession.expires!, 'the written jar has a later expiry');
    assert.ok(after.some((c) => c.name === 'csrf_token'), 'csrf_token survives the write');
    assert.equal(after.length, before.length, 'no entries are lost');

    const leftovers = await fs.readdir(path.dirname(file));
    assert.deepEqual(leftovers, ['hcp-cookies.json'], 'the temp file is renamed away, not left behind');

    // storedExpiresAt must report the pre-request value, not the fresh one —
    // it is the only field that reveals whether the daily task has been running.
    assert.ok(r.storedExpiresAt, 'the stored expiry is reported');
    assert.equal(
      r.storedExpiresAt.getTime() / 1000,
      beforeSession.expires,
      'storedExpiresAt is the on-disk expiry from before the request',
    );
    assert.ok(
      r.expiresAt!.getTime() > r.storedExpiresAt.getTime(),
      'and it is older than the post-request expiry, so the two cannot be confused',
    );
  });

  // ─── 3b. keepAlive — dryRun probes for real but keeps nothing ────────────
  await withTempJar(async (file) => {
    const before = await fs.readFile(file, 'utf-8');
    const r = await keepAlive({ cookiesFile: file, fetchImpl: fakeFetch(200, [rolled]), dryRun: true });

    assert.equal(r.ok, true, 'dryRun still makes the real authenticated request');
    assert.deepEqual(r.rotated, [SESSION_COOKIE], 'and still reports what the server re-issued');
    assert.equal(await fs.readFile(file, 'utf-8'), before, 'but writes nothing to the jar');
    assert.ok(
      r.storedDaysLeft !== null && r.storedDaysLeft < 3,
      'dryRun reports the stale on-disk expiry (~2 days), not the fresh 14-day one — ' +
        'a verifier that reported the fresh value would call a dead schedule healthy',
    );
    assert.ok(r.daysLeft !== null && r.daysLeft > 13, 'while daysLeft still shows what the server offered');
  });

  // ─── 4. keepAlive — failure paths leave the jar untouched ────────────────
  for (const [label, status] of [['401', 401], ['403', 403], ['500', 500]] as const) {
    await withTempJar(async (file) => {
      const before = await fs.readFile(file, 'utf-8');
      const r = await keepAlive({ cookiesFile: file, fetchImpl: fakeFetch(status, [rolled]) });
      assert.equal(r.ok, false, `${label} is a failure`);
      assert.equal(r.status, status);
      assert.equal(await fs.readFile(file, 'utf-8'), before, `${label} leaves the cookie jar untouched`);
      assert.ok(
        r.storedExpiresAt,
        `${label} still reports the stored expiry — the verifier needs it to explain the failure`,
      );
    });
  }

  await withTempJar(async (file) => {
    const before = await fs.readFile(file, 'utf-8');
    const throwing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await keepAlive({ cookiesFile: file, fetchImpl: throwing });
    assert.equal(r.ok, false, 'a network error is a failure, not a throw');
    assert.match(r.detail, /ECONNREFUSED/, 'the underlying error reaches the detail');
    assert.equal(await fs.readFile(file, 'utf-8'), before, 'and the jar is untouched');
  });

  const missing = await keepAlive({
    cookiesFile: path.join(os.tmpdir(), 'hcp-keepalive-does-not-exist', 'nope.json'),
    fetchImpl: fakeFetch(200, [rolled]),
  });
  assert.equal(missing.ok, false, 'a missing cookie file is a failure');
  assert.match(missing.detail, /No readable cookie file/);

  await withTempJar(async (file) => {
    await fs.writeFile(file, '[]');
    const r = await keepAlive({ cookiesFile: file, fetchImpl: fakeFetch(200, [rolled]) });
    assert.equal(r.ok, false, 'an empty jar is a failure');
    assert.match(r.detail, /empty/i);
  });

  await withTempJar(async (file) => {
    const stale = jar().map((c) => ({ ...c, expires: Date.parse('2020-01-01') / 1000 }));
    await fs.writeFile(file, JSON.stringify(stale));
    const r = await keepAlive({ cookiesFile: file, fetchImpl: fakeFetch(200, [rolled]) });
    assert.equal(r.ok, false, 'a fully expired jar is a failure — there is nothing to send');
    assert.match(r.detail, /past its expiry/);
  });

  console.log('session-keepalive.check.ts — all assertions passed');
}

await main();
