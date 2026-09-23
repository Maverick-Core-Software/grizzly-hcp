import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestrictedKeys } from './twilio-restricted-keys.js';
import { routeCanaryNumber } from './twilio-number-route.js';
import { assertOnlyVoiceUrlChanged, isEntryPoint, loadC0Env, printSafe, redact, safeFailureMessage, writeEvidence } from './lib.js';
import { assertExplicitTrunkIds, provisionLivekitSip, reconcileSip, type SipProvisionClient } from './livekit-sip.js';
import { SIPDispatchRule, SIPDispatchRuleIndividual, SIPDispatchRuleInfo, SIPInboundTrunkInfo, type CreateSipInboundTrunkOptions } from 'livekit-server-sdk';
import { fakeSid } from './fake-fixtures.js';

const DID = '+15551230001';
const SID = fakeSid('PN');

function number(overrides: Record<string, unknown> = {}) {
  return { sid: SID, phoneNumber: DID, voiceUrl: 'https://fallback.example/voice', voiceMethod: 'POST', voiceFallbackUrl: null, voiceFallbackMethod: 'POST', voiceApplicationSid: null, trunkSid: null, smsUrl: null, smsMethod: 'POST', smsFallbackUrl: null, smsFallbackMethod: 'POST', smsApplicationSid: null, ...overrides };
}

async function expectReject(action: () => Promise<unknown>, text: string) {
  await assert.rejects(action, new RegExp(text));
}

async function run(): Promise<void> {
  assert.equal(isEntryPoint(import.meta.url), true, 'Windows entry-point detection is path-safe');
  let keyCreates = 0; let envWrites = 0;
  const keys = { api: { v2010: { accounts: () => ({ newKeys: { create: async () => { keyCreates += 1; return { sid: 'SKsecret-key-sid', secret: 'super-secret-key-value' }; } } }) } } };
  const dryKeys = await createRestrictedKeys(keys, 'AC1234', false, async () => { envWrites += 1; });
  assert.equal(dryKeys.dryRun, true); assert.equal(keyCreates, 0); assert.equal(envWrites, 0, 'dry-run creates no keys and writes no env');
  const appliedKeys = await createRestrictedKeys(keys, 'AC1234', true, async (values) => { envWrites += 1; assert.deepEqual(values, { VOICE_C0_TWILIO_API_KEY_SID: 'SKsecret-key-sid', VOICE_C0_TWILIO_API_KEY_SECRET: 'super-secret-key-value' }); });
  assert.equal(appliedKeys.dryRun, false); assert.equal(appliedKeys.keyType, 'standard'); assert.equal(keyCreates, 1); assert.equal(envWrites, 1, 'applied key creation writes only canonical key names');

  let updates = 0;
  const routeClient = (current: Record<string, any>) => ({ api: { v2010: { accounts: () => ({ incomingPhoneNumbers: () => ({ fetch: async () => current, update: async (input: any) => { updates += 1; return { ...current, voiceUrl: input.voiceUrl, voiceMethod: input.voiceMethod }; } }) }) } } });
  const dryRoute = await routeCanaryNumber(routeClient(number()), 'AC1234', SID, DID, 'https://ingress.example/voice', false);
  assert.equal(dryRoute.dryRun, true); assert.equal(updates, 0, 'route dry-run makes no mutation');
  await expectReject(() => routeCanaryNumber(routeClient(number({ trunkSid: 'TK12345678' })), 'AC1234', SID, DID, 'https://ingress.example/voice', false), 'trunk');
  await expectReject(() => routeCanaryNumber(routeClient(number({ voiceApplicationSid: 'AP12345678' })), 'AC1234', SID, DID, 'https://ingress.example/voice', false), 'application');
  await expectReject(() => routeCanaryNumber(routeClient(number({ phoneNumber: '+15551239999' })), 'AC1234', SID, DID, 'https://ingress.example/voice', false), 'other than');
  updates = 0;
  const appliedRoute = await routeCanaryNumber(routeClient(number()), 'AC1234', SID, DID, 'https://ingress.example/voice', true);
  assert.equal(appliedRoute.dryRun, false); assert.equal(updates, 1); assert.deepEqual(Object.keys(appliedRoute.after!).filter((key) => appliedRoute.before![key] !== appliedRoute.after![key]), ['voice_url']);
  assert.throws(() => assertOnlyVoiceUrlChanged({ voice_url: 'a', sms_url: 'b' }, { voice_url: 'c', sms_url: 'changed' }), /only voice_url/);

  assert.throws(() => assertExplicitTrunkIds([]), /explicit trunkIds/);
  let sipMutations = 0;
  let createOptions: CreateSipInboundTrunkOptions | undefined;
  let replacement: SIPInboundTrunkInfo | undefined;
  let ruleReplacement: SIPDispatchRuleInfo | undefined;
  const sip: SipProvisionClient = {
    listSipInboundTrunk: async () => [], listSipDispatchRule: async () => [],
    createSipInboundTrunk: async (_name, _numbers, options) => { sipMutations += 1; createOptions = options; return new SIPInboundTrunkInfo({ sipTrunkId: 'ST1234567890', name: 'grizzly-c0-canary-inbound' }); },
    updateSipInboundTrunk: async (_id: string, trunk: SIPInboundTrunkInfo) => { sipMutations += 1; replacement = trunk; return new SIPInboundTrunkInfo({ ...trunk, sipTrunkId: 'ST1234567890' }); },
    createSipDispatchRule: async () => { sipMutations += 1; return new SIPDispatchRuleInfo({ sipDispatchRuleId: 'SD1234567890', name: 'grizzly-c0-canary-dispatch', trunkIds: ['ST1234567890'], rule: new SIPDispatchRule({ rule: { case: 'dispatchRuleIndividual', value: new SIPDispatchRuleIndividual({ roomPrefix: 'c0-' }) } }) }); },
    updateSipDispatchRule: async (_id: string, rule: SIPDispatchRuleInfo) => { sipMutations += 1; ruleReplacement = rule; return new SIPDispatchRuleInfo({ ...rule, sipDispatchRuleId: 'SD1234567890' }); },
  };
  const drySip = await reconcileSip(sip, { did: DID, allowedNumbers: ['+15551230002'], authUsername: 'sip-user', authPassword: 'sip-password', mediaEncryption: 'SIP_MEDIA_ENCRYPT_ALLOW' }, false);
  assert.equal(drySip.dryRun, true); assert.equal(sipMutations, 0, 'LiveKit dry-run makes no mutation');
  let livekitEnvWrites = 0;
  const appliedSip = await provisionLivekitSip(sip, { did: DID, allowedNumbers: ['+15551230002'], authUsername: 'sip-user', authPassword: 'sip-password', mediaEncryption: 'SIP_MEDIA_ENCRYPT_ALLOW' }, true, async (values) => { livekitEnvWrites += 1; assert.deepEqual(values, { VOICE_C0_LIVEKIT_TRUNK_ID: 'ST1234567890', VOICE_C0_LIVEKIT_RULE_ID: 'SD1234567890' }); });
  assert.equal(appliedSip.dryRun, false); assert.equal(sipMutations, 4, 'creation applies trunk limits, rule, and allow-list replacement');
  assert.equal(livekitEnvWrites, 1, 'applied LiveKit reconciliation writes canonical trunk and rule IDs');
  assert.equal(createOptions?.ringingTimeout, 15, 'SDK create options receive numeric ringing-timeout seconds');
  assert.equal(replacement?.maxCallDuration?.seconds, 480n, 'full replacement retains protobuf max-call duration');
  assert.equal(ruleReplacement?.rule?.rule.case, 'dispatchRuleIndividual', 'replacement retains the protobuf dispatch-rule oneof');
  assert.equal(ruleReplacement?.rule?.rule.value?.roomPrefix, 'c0-');
  assert.equal(ruleReplacement?.roomConfig?.agents[0]?.agentName, 'grizzly-c0-canary', 'replacement uses RoomConfiguration agent messages');
  if (!appliedSip.dryRun) {
    assert.deepEqual(appliedSip.trunk.ringingTimeout, { seconds: 15, nanos: 0 }, 'public evidence converts fake-SDK bigint Duration seconds to numbers');
    assert.deepEqual(appliedSip.trunk.maxCallDuration, { seconds: 480, nanos: 0 });
  }

  const evidenceRoot = await mkdtemp(join(tmpdir(), 'c0-provision-check-'));
  const secret = 'not-for-stdout-or-evidence';
  const originalLog = console.log; let stdout = '';
  console.log = (...values: unknown[]) => { stdout += values.join(' '); };
  try { printSafe({ authPassword: secret, nested: { secret }, livekit: appliedSip, duration: { seconds: 15n } }); } finally { console.log = originalLog; }
  assert.ok(!stdout.includes(secret), 'secret never appears in stdout');
  assert.ok(stdout.includes('15'), 'printSafe serializes bigint values');
  assert.ok(!safeFailureMessage(new Error(secret), 'test').includes(secret), 'provider errors never leak to stdout');
  const evidencePath = await writeEvidence('redaction', { authPassword: secret, nested: { secret }, sid: 'AC12345678', livekit: appliedSip, duration: { seconds: 480n } }, evidenceRoot);
  const evidence = await readFile(evidencePath, 'utf8');
  assert.ok(!evidence.includes(secret), 'secret never appears in evidence');
  assert.ok(evidence.includes('480'), 'writeEvidence serializes bigint values');
  assert.equal((redact({ authPassword: secret }) as any).authPassword, '[REDACTED]');
  const configPath = join(evidenceRoot, 'c0-config');
  await writeFile(configPath, 'VOICE_C0_ENABLED=false\nVOICE_OUTBOX_STALE_MS=123\nUNRELATED=value\n', 'utf8');
  const config = loadC0Env(configPath, { VOICE_C0_ENABLED: 'false', VOICE_OUTBOX_STALE_MS: '123', UNRELATED: 'inherited' });
  assert.deepEqual(config, { VOICE_C0_ENABLED: 'false', VOICE_OUTBOX_STALE_MS: '123' }, 'only the C0 file supplies isolated runtime configuration');
  assert.throws(() => loadC0Env(configPath, { VOICE_C0_ENABLED: 'true' }), /VOICE_C0_ENABLED/, 'conflicting inherited C0 values refuse without revealing a value');
  await rm(evidenceRoot, { recursive: true, force: true });
}

run().then(() => console.log('provision.check OK')).catch((error) => { console.error(error); process.exitCode = 1; });
