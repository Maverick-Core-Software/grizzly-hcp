export const CALL_SID_RE = /^CA[0-9a-f]{32}$/;

export interface SipParticipantLike {
  readonly kind: string | number;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface CanaryGateConfig {
  readonly enabled: boolean;
  readonly trunkId?: string;
  readonly ruleId?: string;
  readonly sipKind: string | number;
}

export type GateRefusal =
  | 'not_sip'
  | 'wrong_trunk'
  | 'wrong_rule'
  | 'call_sid_missing'
  | 'call_sid_malformed'
  | 'disabled';

export type GateResult = { readonly ok: true; readonly callSid: string } |
  { readonly ok: false; readonly reason: GateRefusal; readonly callSid?: string };

export function evaluateGate(participant: SipParticipantLike, config: CanaryGateConfig): GateResult {
  if (participant.kind !== config.sipKind) return { ok: false, reason: 'not_sip' };
  if (!config.trunkId || participant.attributes['sip.trunkID'] !== config.trunkId) {
    return { ok: false, reason: 'wrong_trunk' };
  }
  if (!config.ruleId || participant.attributes['sip.ruleID'] !== config.ruleId) {
    return { ok: false, reason: 'wrong_rule' };
  }
  const callSid = participant.attributes['c0.callSid'];
  if (!callSid) return { ok: false, reason: 'call_sid_missing' };
  if (!CALL_SID_RE.test(callSid)) return { ok: false, reason: 'call_sid_malformed' };
  if (!config.enabled) return { ok: false, reason: 'disabled', callSid };
  return { ok: true, callSid };
}

export async function waitForCallSid(
  participant: SipParticipantLike,
  config: CanaryGateConfig,
  waitForAttributeChange: () => Promise<void>,
): Promise<GateResult> {
  const initial = evaluateGate(participant, config);
  if (initial.ok || initial.reason !== 'call_sid_missing') return initial;
  await Promise.race([
    waitForAttributeChange(),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  return evaluateGate(participant, config);
}
