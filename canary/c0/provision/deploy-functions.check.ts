import assert from 'node:assert/strict';
import { deployFunctions, functionContext } from './deploy-functions.js';
import { printSafe } from './lib.js';
import { fakeHexToken, fakeSid } from './fake-fixtures.js';

const env = {
  VOICE_C0_TWILIO_ACCOUNT_SID: fakeSid('AC'), VOICE_C0_TWILIO_AUTH_TOKEN: fakeHexToken(),
  VOICE_C0_CANARY_DID: '+15551230001', VOICE_C0_LIVEKIT_SIP_HOST: 'c0.sip.livekit.cloud', VOICE_C0_SIP_USERNAME: 'c0-0123456789abcdef01234567', VOICE_C0_SIP_PASSWORD: 'a'.repeat(48),
  VOICE_C0_ALLOWED_CALLERS: '+15551230002', VOICE_C0_SYNC_SERVICE_SID: fakeSid('IS'), VOICE_C0_OFFICE_NUMBER: '+15551230003', VOICE_C0_BACKUP_NUMBER: '+15551230004', VOICE_C0_NTFY_TOPIC: 'grizzly-c0',
};

async function run(): Promise<void> {
  let calls = 0; let writes = 0; let received: any;
  const deployer = { deployLocalProject: async (config: any) => { calls += 1; received = config; return { serviceSid: 'ZS1234567890', environmentSid: 'ZE1234567890', domain: 'grizzly-c0-1234.twil.io' }; } };
  const dry = await deployFunctions(deployer, env, false, async () => { writes += 1; });
  assert.equal(dry.dryRun, true); assert.equal(calls, 0); assert.equal(writes, 0, 'dry-run makes no deployment or env mutation');
  assert.equal(functionContext({ ...env, VOICE_C0_SIP_TRANSPORT: 'tls' }).C0_SIP_SECURE, 'true');
  const applied = await deployFunctions(deployer, env, true, async (values) => { writes += 1; assert.deepEqual(values, { VOICE_C0_INGRESS_URL: 'https://grizzly-c0-1234.twil.io/ingress', VOICE_C0_FALLBACK_URL: 'https://grizzly-c0-1234.twil.io/fallback' }); });
  assert.equal(applied.dryRun, false); assert.equal(calls, 1); assert.equal(writes, 1);
  assert.equal(received.serviceName, 'grizzly-c0-canary'); assert.equal(received.functionsEnv, 'production'); assert.equal(received.env.C0_DIAL_TIMEOUT_S, '20'); assert.equal(received.env.C0_TIME_LIMIT_S, '480');
  const secret = env.VOICE_C0_SIP_PASSWORD; const log = console.log; let stdout = ''; console.log = (...items: unknown[]) => { stdout += items.join(' '); };
  try { printSafe({ secret, result: applied }); } finally { console.log = log; }
  assert.ok(!stdout.includes(secret), 'secret never reaches stdout');
}

run().then(() => console.log('deploy-functions.check OK')).catch((error) => { console.error(error); process.exitCode = 1; });
