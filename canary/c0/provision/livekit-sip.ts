import { SipClient } from 'livekit-server-sdk';
import { assertApply, isApply, isEntryPoint, loadC0Env, mask, printSafe, required, safeFailureMessage, upsertC0EnvAtomically, valueOr, writeEvidence, type Env } from './lib.js';

type Trunk = Record<string, any>;
type Rule = Record<string, any>;
export type SipProvisionClient = {
  listSipInboundTrunk: () => Promise<Trunk[]>;
  createSipInboundTrunk: (name: string, numbers: string[], options: Record<string, unknown>) => Promise<Trunk>;
  updateSipInboundTrunk: (id: string, trunk: Trunk) => Promise<Trunk>;
  listSipDispatchRule: () => Promise<Rule[]>;
  createSipDispatchRule: (rule: { type: 'individual'; roomPrefix: string }, options: Record<string, unknown>) => Promise<Rule>;
  updateSipDispatchRule: (id: string, rule: Rule) => Promise<Rule>;
};

export const C0_TRUNK_NAME = 'grizzly-c0-canary-inbound';
export const C0_RULE_NAME = 'grizzly-c0-canary-dispatch';

export function assertExplicitTrunkIds(trunkIds: string[]): void {
  if (!Array.isArray(trunkIds) || trunkIds.length === 0 || trunkIds.some((id) => !id)) throw new Error('Refusing dispatch rule without explicit trunkIds');
}

export function c0TrunkSpec(did: string, allowedNumbers: string[], authUsername: string, authPassword: string, mediaEncryption: string): Trunk {
  if (!['SIP_MEDIA_ENCRYPT_ALLOW', 'SIP_MEDIA_ENCRYPT_REQUIRE', 'SIP_MEDIA_ENCRYPT_DISABLE'].includes(mediaEncryption)) throw new Error('Invalid VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION');
  return { name: C0_TRUNK_NAME, numbers: [did], allowedNumbers, authUsername, authPassword, headersToAttributes: { 'X-C0-Call': 'c0.callSid' }, ringingTimeout: { seconds: BigInt(15), nanos: 0 }, maxCallDuration: { seconds: BigInt(480), nanos: 0 }, media: { encryption: mediaEncryption } };
}

export function c0RuleSpec(trunkIds: string[], allowedNumbers: string[]): Rule {
  assertExplicitTrunkIds(trunkIds);
  return { name: C0_RULE_NAME, trunkIds, hidePhoneNumber: true, inboundNumbers: allowedNumbers, rule: { type: 'individual', roomPrefix: 'c0-' }, roomConfig: { agents: [{ agentName: 'grizzly-c0-canary' }] } };
}

function publicTrunk(trunk: Trunk): Record<string, unknown> {
  return { id: mask(trunk.sipTrunkId), name: trunk.name, numbers: trunk.numbers, allowedNumbers: trunk.allowedNumbers, ringingTimeout: trunk.ringingTimeout, maxCallDuration: trunk.maxCallDuration, media: trunk.media, headersToAttributes: trunk.headersToAttributes };
}

function publicRule(rule: Rule): Record<string, unknown> {
  return { id: mask(rule.sipDispatchRuleId), name: rule.name, trunkIds: (rule.trunkIds ?? []).map(mask), hidePhoneNumber: rule.hidePhoneNumber, inboundNumbers: rule.inboundNumbers, roomConfig: rule.roomConfig, rule: rule.rule };
}

export async function reconcileSip(client: SipProvisionClient, input: { did: string; allowedNumbers: string[]; authUsername: string; authPassword: string; mediaEncryption: string }, apply: boolean) {
  const trunkSpec = c0TrunkSpec(input.did, input.allowedNumbers, input.authUsername, input.authPassword, input.mediaEncryption);
  const existingTrunk = (await client.listSipInboundTrunk()).find((trunk) => trunk.name === C0_TRUNK_NAME);
  if (!apply) return { dryRun: true, requestedTrunk: publicTrunk(trunkSpec), requestedRule: publicRule(c0RuleSpec([existingTrunk?.sipTrunkId ?? '<created-trunk-id>'], input.allowedNumbers)) };
  let trunk: Trunk;
  if (existingTrunk) trunk = await client.updateSipInboundTrunk(existingTrunk.sipTrunkId, { ...existingTrunk, ...trunkSpec });
  else {
    // createSipInboundTrunk exposes ringingTimeout but not maxCallDuration in
    // its 2.19.1 option type, so finish the creation with a full replacement.
    const { maxCallDuration, ringingTimeout, ...createSpec } = trunkSpec;
    const created = await client.createSipInboundTrunk(C0_TRUNK_NAME, [input.did], {
      ...createSpec,
      // SDK 2.19.1 creates Duration itself from numeric seconds; the update
      // below receives the protobuf-shaped duration required for replacement.
      ringingTimeout: Number(ringingTimeout.seconds),
    });
    trunk = await client.updateSipInboundTrunk(created.sipTrunkId, { ...created, ...trunkSpec });
  }
  const trunkId = trunk.sipTrunkId;
  assertExplicitTrunkIds([trunkId]);
  const ruleSpec = c0RuleSpec([trunkId], input.allowedNumbers);
  const existingRule = (await client.listSipDispatchRule()).find((rule) => rule.name === C0_RULE_NAME);
  let rule: Rule;
  if (existingRule) rule = await client.updateSipDispatchRule(existingRule.sipDispatchRuleId, { ...existingRule, ...ruleSpec });
  else {
    // SDK 2.19.1 creates with trunk IDs but does not expose inboundNumbers in
    // create options. Immediately replace the returned rule so the allow-list
    // is present before this reconciliation reports success.
    const created = await client.createSipDispatchRule({ type: 'individual', roomPrefix: 'c0-' }, { name: C0_RULE_NAME, trunkIds: [trunkId], hidePhoneNumber: true, roomConfig: ruleSpec.roomConfig });
    rule = await client.updateSipDispatchRule(created.sipDispatchRuleId, { ...created, ...ruleSpec });
  }
  assertExplicitTrunkIds(rule.trunkIds ?? []);
  if (!(rule.inboundNumbers ?? []).every((value: string) => input.allowedNumbers.includes(value)) || rule.inboundNumbers?.length !== input.allowedNumbers.length) throw new Error('LiveKit dispatch rule did not retain the caller allow-list');
  return { dryRun: false, trunk: publicTrunk(trunk), rule: publicRule(rule), trunkId, ruleId: rule.sipDispatchRuleId };
}

export async function listSip(client: SipProvisionClient) {
  const [trunks, rules] = await Promise.all([client.listSipInboundTrunk(), client.listSipDispatchRule()]);
  return { trunks: trunks.map(publicTrunk), rules: rules.map(publicRule) };
}

export async function provisionLivekitSip(client: SipProvisionClient, input: { did: string; allowedNumbers: string[]; authUsername: string; authPassword: string; mediaEncryption: string }, apply: boolean, writeEnv: (values: Record<string, string>) => Promise<void>) {
  const result = await reconcileSip(client, input, apply);
  if (!result.dryRun) await writeEnv({ VOICE_C0_LIVEKIT_TRUNK_ID: result.trunkId, VOICE_C0_LIVEKIT_RULE_ID: result.ruleId });
  return result;
}

function callers(env: Env): string[] {
  const value = required(env, 'VOICE_C0_ALLOWED_CALLERS');
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!parsed.length) throw new Error('VOICE_C0_ALLOWED_CALLERS must be non-empty');
  return parsed;
}

async function main(env: Env): Promise<void> {
  // The canonical runtime URL is wss:// for the agent. SipClient uses Twirp
  // over HTTPS, so retain the same host but convert its transport here.
  const livekitApiUrl = required(env, 'VOICE_C0_LIVEKIT_URL').replace(/^wss:/i, 'https:');
  const client = new SipClient(livekitApiUrl, required(env, 'VOICE_C0_LIVEKIT_API_KEY'), required(env, 'VOICE_C0_LIVEKIT_API_SECRET')) as unknown as SipProvisionClient;
  if (process.argv.includes('--list')) {
    const result = await listSip(client); await writeEvidence('livekit-sip', result); printSafe(result); return;
  }
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const result = await provisionLivekitSip(client, { did: required(env, 'VOICE_C0_CANARY_DID'), allowedNumbers: callers(env), authUsername: required(env, 'VOICE_C0_SIP_USERNAME'), authPassword: required(env, 'VOICE_C0_SIP_PASSWORD'), mediaEncryption: valueOr(env, 'VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION', 'SIP_MEDIA_ENCRYPT_ALLOW') }, apply, upsertC0EnvAtomically);
  await writeEvidence('livekit-sip', result); printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'LiveKit SIP provisioning')); process.exitCode = 1; });
