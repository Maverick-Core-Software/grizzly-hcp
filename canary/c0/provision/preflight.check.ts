import assert from 'node:assert/strict';
import { preflight, validateCanonical } from './preflight.js';
import { printSafe } from './lib.js';
import { fakeHexToken, fakeLiveKitKey, fakeOpenAiKey, fakeSid } from './fake-fixtures.js';

const liveKitTrunkId = `ST_${['R', 'u', 'n', 't', 'i', 'm', 'e', '9', 'K', '2', 'x', 'L'].join('')}`;
const liveKitRuleId = `SDR_${['R', 'u', 'n', 't', 'i', 'm', 'e', '7', 'Q', '4', 'z', 'P'].join('')}`;

const env = {
  VOICE_C0_TWILIO_ACCOUNT_SID: fakeSid('AC'), VOICE_C0_TWILIO_AUTH_TOKEN: fakeHexToken(), VOICE_C0_TWILIO_API_KEY_SID: fakeSid('SK'), VOICE_C0_TWILIO_API_KEY_SECRET: 'a'.repeat(32), VOICE_C0_SYNC_SERVICE_SID: fakeSid('IS'),
  VOICE_C0_CANARY_DID: '+15551230001', VOICE_C0_CANARY_NUMBER_SID: fakeSid('PN'), VOICE_C0_INGRESS_URL: 'https://grizzly-c0.twil.io/ingress', VOICE_C0_FALLBACK_URL: 'https://grizzly-c0.twil.io/fallback',
  VOICE_C0_LIVEKIT_URL: 'wss://c0.livekit.cloud', VOICE_C0_LIVEKIT_API_KEY: fakeLiveKitKey(), VOICE_C0_LIVEKIT_API_SECRET: 'b'.repeat(32), VOICE_C0_LIVEKIT_SIP_HOST: 'c0.sip.livekit.cloud', VOICE_C0_LIVEKIT_TRUNK_ID: liveKitTrunkId, VOICE_C0_LIVEKIT_RULE_ID: liveKitRuleId, VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION: 'SIP_MEDIA_ENCRYPT_ALLOW',
  VOICE_C0_SIP_USERNAME: `c0-${'0'.repeat(24)}`, VOICE_C0_SIP_PASSWORD: 'c'.repeat(48), VOICE_C0_SIP_TRANSPORT: 'tcp', VOICE_C0_OPENAI_API_KEY: fakeOpenAiKey(), VOICE_C0_ALLOWED_CALLERS: '+15551230002', VOICE_C0_OFFICE_NUMBER: '+15551230003', VOICE_C0_BACKUP_NUMBER: '+15551230004', VOICE_C0_NTFY_TOPIC: 'grizzly-c0', VOICE_C0_ENABLED: 'false', VOICE_C0_ALLOWLIST: '+15551230002',
};

async function run(): Promise<void> {
  const runtime = { nodeVersion: '24.19.0', pm2OnPath: () => true, envIgnored: () => true };
  const result = preflight(env, 'enable', runtime);
  assert.equal(result.pass, true); assert.equal(result.variables.VOICE_C0_TWILIO_AUTH_TOKEN.present, true); assert.equal(result.variables.VOICE_C0_TWILIO_AUTH_TOKEN.formatValid, true);
  const missing = preflight({ ...env, VOICE_C0_SIP_PASSWORD: undefined }, 'functions', runtime);
  assert.equal(missing.pass, false); assert.ok(missing.missingOrInvalid.includes('VOICE_C0_SIP_PASSWORD'));
  const missingNumberSid = preflight({ ...env, VOICE_C0_CANARY_NUMBER_SID: undefined }, 'enable', runtime);
  assert.equal(missingNumberSid.pass, false); assert.ok(missingNumberSid.missingOrInvalid.includes('VOICE_C0_CANARY_NUMBER_SID'));
  assert.equal(validateCanonical('VOICE_C0_CANARY_NUMBER_SID', `PN${'A'.repeat(32)}`), true);
  assert.equal(validateCanonical('VOICE_C0_LIVEKIT_TRUNK_ID', liveKitTrunkId), true);
  assert.equal(validateCanonical('VOICE_C0_LIVEKIT_RULE_ID', liveKitRuleId), true);
  assert.equal(validateCanonical('VOICE_C0_LIVEKIT_TRUNK_ID', `ST${'a'.repeat(32)}`), false, 'legacy 32-hex IDs without the runtime underscore are rejected');
  assert.equal(validateCanonical('VOICE_C0_LIVEKIT_RULE_ID', `SD${'b'.repeat(32)}`), false, 'legacy dispatch-rule IDs are rejected');
  assert.equal(validateCanonical('VOICE_C0_CANARY_DID', 'not-a-number'), false); assert.equal(validateCanonical('VOICE_C0_LIVEKIT_URL', 'https://not-wss.example'), false);
  const secret = env.VOICE_C0_TWILIO_AUTH_TOKEN; const log = console.log; let stdout = ''; console.log = (...items: unknown[]) => { stdout += items.join(' '); };
  try { printSafe(result); } finally { console.log = log; }
  assert.ok(!stdout.includes(secret), 'preflight never prints secret values');
}

run().then(() => console.log('preflight.check OK')).catch((error) => { console.error(error); process.exitCode = 1; });
