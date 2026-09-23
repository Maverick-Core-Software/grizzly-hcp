import { Duration } from '@bufbuild/protobuf';
import { SIPMediaEncryption } from '@livekit/protocol';
import {
  RoomAgentDispatch,
  RoomConfiguration,
  SIPDispatchRule,
  SIPDispatchRuleIndividual,
  SIPDispatchRuleInfo,
  SIPInboundTrunkInfo,
  SipClient,
  type CreateSipDispatchRuleOptions,
  type CreateSipInboundTrunkOptions,
  type SipDispatchRuleIndividual as SipDispatchRuleIndividualInput,
} from 'livekit-server-sdk';
import { assertApply, isApply, isEntryPoint, loadC0Env, mask, printSafe, required, safeFailureMessage, upsertC0EnvAtomically, valueOr, writeEvidence, type Env } from './lib.js';

export type SipProvisionClient = Pick<SipClient,
  'listSipInboundTrunk' | 'createSipInboundTrunk' | 'updateSipInboundTrunk'
  | 'listSipDispatchRule' | 'createSipDispatchRule' | 'updateSipDispatchRule'>;
export type SipReconcileResult =
  | { dryRun: true; requestedTrunk: Record<string, unknown>; requestedRule: Record<string, unknown> }
  | { dryRun: false; trunk: Record<string, unknown>; rule: Record<string, unknown>; trunkId: string; ruleId: string };

export const C0_TRUNK_NAME = 'grizzly-c0-canary-inbound';
export const C0_RULE_NAME = 'grizzly-c0-canary-dispatch';

export function assertExplicitTrunkIds(trunkIds: string[]): void {
  if (!Array.isArray(trunkIds) || trunkIds.length === 0 || trunkIds.some((id) => !id)) throw new Error('Refusing dispatch rule without explicit trunkIds');
}

const MEDIA_ENCRYPTION_BY_NAME = {
  SIP_MEDIA_ENCRYPT_ALLOW: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_ALLOW,
  SIP_MEDIA_ENCRYPT_REQUIRE: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_REQUIRE,
  SIP_MEDIA_ENCRYPT_DISABLE: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_DISABLE,
} as const;

type C0RuleSpec = Pick<SIPDispatchRuleInfo, 'name' | 'trunkIds' | 'hidePhoneNumber' | 'inboundNumbers' | 'roomConfig'>;

export function c0TrunkSpec(did: string, allowedNumbers: string[], authUsername: string, authPassword: string, mediaEncryption: string): SIPInboundTrunkInfo {
  const encryption = MEDIA_ENCRYPTION_BY_NAME[mediaEncryption as keyof typeof MEDIA_ENCRYPTION_BY_NAME];
  if (encryption === undefined) throw new Error('Invalid VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION');
  return new SIPInboundTrunkInfo({
    name: C0_TRUNK_NAME,
    numbers: [did],
    allowedNumbers,
    authUsername,
    authPassword,
    headersToAttributes: { 'X-C0-Call': 'c0.callSid' },
    ringingTimeout: new Duration({ seconds: 15n }),
    maxCallDuration: new Duration({ seconds: 480n }),
    media: { encryption },
  });
}

export function c0RuleSpec(trunkIds: string[], allowedNumbers: string[]): C0RuleSpec {
  assertExplicitTrunkIds(trunkIds);
  return {
    name: C0_RULE_NAME,
    trunkIds,
    hidePhoneNumber: true,
    inboundNumbers: allowedNumbers,
    roomConfig: new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: 'grizzly-c0-canary' })] }),
  };
}

function publicDuration(duration: Duration | undefined): { seconds: number; nanos: number } | undefined {
  return duration ? { seconds: Number(duration.seconds), nanos: duration.nanos } : undefined;
}

function publicTrunk(trunk: SIPInboundTrunkInfo): Record<string, unknown> {
  return {
    id: mask(trunk.sipTrunkId), name: trunk.name, numbers: trunk.numbers, allowedNumbers: trunk.allowedNumbers,
    ringingTimeout: publicDuration(trunk.ringingTimeout), maxCallDuration: publicDuration(trunk.maxCallDuration),
    media: trunk.media ? { encryption: trunk.media.encryption } : undefined, headersToAttributes: trunk.headersToAttributes,
  };
}

function publicRule(rule: SIPDispatchRuleInfo): Record<string, unknown> {
  const dispatch = rule.rule?.rule;
  return {
    id: mask(rule.sipDispatchRuleId), name: rule.name, trunkIds: rule.trunkIds.map(mask), hidePhoneNumber: rule.hidePhoneNumber,
    inboundNumbers: rule.inboundNumbers, roomConfig: rule.roomConfig ? { agents: rule.roomConfig.agents.map((agent) => ({ agentName: agent.agentName })) } : undefined,
    rule: dispatch?.case === 'dispatchRuleIndividual' ? { case: dispatch.case, roomPrefix: dispatch.value.roomPrefix } : { case: dispatch?.case },
  };
}

function dispatchRuleIndividual(): SIPDispatchRule {
  return new SIPDispatchRule({ rule: { case: 'dispatchRuleIndividual', value: new SIPDispatchRuleIndividual({ roomPrefix: 'c0-' }) } });
}

function replacementTrunk(existing: SIPInboundTrunkInfo, spec: SIPInboundTrunkInfo): SIPInboundTrunkInfo {
  return new SIPInboundTrunkInfo({ ...existing, ...spec });
}

function replacementRule(existing: SIPDispatchRuleInfo, spec: C0RuleSpec): SIPDispatchRuleInfo {
  return new SIPDispatchRuleInfo({
    ...existing,
    name: spec.name,
    trunkIds: spec.trunkIds,
    hidePhoneNumber: spec.hidePhoneNumber,
    inboundNumbers: spec.inboundNumbers,
    roomConfig: spec.roomConfig,
    rule: existing.rule ?? dispatchRuleIndividual(),
  });
}

export async function reconcileSip(client: SipProvisionClient, input: { did: string; allowedNumbers: string[]; authUsername: string; authPassword: string; mediaEncryption: string }, apply: boolean): Promise<SipReconcileResult> {
  const trunkSpec = c0TrunkSpec(input.did, input.allowedNumbers, input.authUsername, input.authPassword, input.mediaEncryption);
  const existingTrunk = (await client.listSipInboundTrunk()).find((trunk) => trunk.name === C0_TRUNK_NAME);
  if (!apply) {
    const ruleSpec = c0RuleSpec([existingTrunk?.sipTrunkId ?? '<created-trunk-id>'], input.allowedNumbers);
    return { dryRun: true, requestedTrunk: publicTrunk(trunkSpec), requestedRule: publicRule(new SIPDispatchRuleInfo({ ...ruleSpec, rule: dispatchRuleIndividual() })) };
  }
  let trunk: SIPInboundTrunkInfo;
  if (existingTrunk) trunk = await client.updateSipInboundTrunk(existingTrunk.sipTrunkId, replacementTrunk(existingTrunk, trunkSpec));
  else {
    // createSipInboundTrunk exposes ringingTimeout but not maxCallDuration in
    // its 2.19.1 option type, so finish the creation with a full replacement.
    const createSpec: CreateSipInboundTrunkOptions = {
      allowedNumbers: trunkSpec.allowedNumbers,
      authUsername: trunkSpec.authUsername,
      authPassword: trunkSpec.authPassword,
      headersToAttributes: trunkSpec.headersToAttributes,
      media: trunkSpec.media,
      ringingTimeout: Number(trunkSpec.ringingTimeout?.seconds),
    };
    const created = await client.createSipInboundTrunk(C0_TRUNK_NAME, [input.did], {
      ...createSpec,
    });
    trunk = await client.updateSipInboundTrunk(created.sipTrunkId, replacementTrunk(created, trunkSpec));
  }
  const trunkId = trunk.sipTrunkId;
  assertExplicitTrunkIds([trunkId]);
  const ruleSpec = c0RuleSpec([trunkId], input.allowedNumbers);
  const existingRule = (await client.listSipDispatchRule()).find((rule) => rule.name === C0_RULE_NAME);
  let rule: SIPDispatchRuleInfo;
  if (existingRule) rule = await client.updateSipDispatchRule(existingRule.sipDispatchRuleId, replacementRule(existingRule, ruleSpec));
  else {
    // SDK 2.19.1 creates with trunk IDs but does not expose inboundNumbers in
    // create options. Immediately replace the returned rule so the allow-list
    // is present before this reconciliation reports success.
    const createRule: SipDispatchRuleIndividualInput = { type: 'individual', roomPrefix: 'c0-' };
    const createOptions: CreateSipDispatchRuleOptions = { name: C0_RULE_NAME, trunkIds: [trunkId], hidePhoneNumber: true, roomConfig: ruleSpec.roomConfig };
    const created = await client.createSipDispatchRule(createRule, createOptions);
    rule = await client.updateSipDispatchRule(created.sipDispatchRuleId, replacementRule(created, ruleSpec));
  }
  assertExplicitTrunkIds(rule.trunkIds ?? []);
  if (!rule.inboundNumbers.every((value) => input.allowedNumbers.includes(value)) || rule.inboundNumbers.length !== input.allowedNumbers.length) throw new Error('LiveKit dispatch rule did not retain the caller allow-list');
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
