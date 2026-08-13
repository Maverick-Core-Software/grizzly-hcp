/**
 * Offline checks for ops alerts (ntfy + Twilio pc-sms).
 *   npx tsx src/ops/alert.check.ts
 */
import assert from 'node:assert/strict';
import { formatOpsSms, OPS_SMS_MAX_CHARS, resolveOpsSmsConfig, sendOpsSms } from './alert.js';

{
  const cfg = resolveOpsSmsConfig({
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'secret',
    OPS_SMS_FROM: '+15551112222',
    OPS_SMS_TO: '+15553334444',
  });
  assert.ok(cfg);
  assert.equal(cfg.from, '+15551112222');
  assert.equal(cfg.to, '+15553334444');
}

{
  const cfg = resolveOpsSmsConfig({
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'secret',
    TWILIO_PHONE_NUMBER: '+15559990000',
    OPS_SMS_TO: '+15553334444',
  });
  assert.equal(cfg, null, 'must not fall back to the customer Twilio number');
}

{
  assert.equal(resolveOpsSmsConfig({}), null);
}

{
  const text = formatOpsSms('Maverick booking — Jane', 'Callback: +1555\nIssue: outlet');
  assert.match(text, /Maverick booking/);
  assert.match(text, /outlet/);
}

{
  const long = formatOpsSms('T', 'x'.repeat(500));
  assert.equal(long.length, OPS_SMS_MAX_CHARS);
  assert.equal(long.endsWith('…'), true);
}

{
  const calls: Array<{ url: string; body: string }> = [];
  const result = await sendOpsSms('hello from tests', {
    env: {
      OPS_TWILIO_ACCOUNT_SID: 'ACtest',
      OPS_TWILIO_AUTH_TOKEN: 'tok',
      OPS_SMS_FROM: '+15551112222',
      OPS_SMS_TO: '+15553334444',
    },
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return { ok: true, status: 201 } as Response;
    }) as typeof fetch,
  });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /Accounts\/ACtest\/Messages\.json/);
  assert.match(calls[0].body, /From=%2B15551112222/);
  assert.match(calls[0].body, /To=%2B15553334444/);
  assert.match(calls[0].body, /hello\+from\+tests/);
}

{
  const result = await sendOpsSms('nope', {
    env: {},
    fetchImpl: (async () => {
      throw new Error('should not fetch');
    }) as typeof fetch,
  });
  assert.deepEqual(result, { sent: false, reason: 'not-configured' });
}

console.log('✓ ops alert self-check passed');
