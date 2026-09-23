import assert from 'node:assert/strict';
import { CALL_SID_RE, evaluateGate, waitForCallSid } from './gate.js';
import { routePreSessionRefusal, startPostAdmission } from './worker.js';
import { transferWithSync } from './transfer.js';
import { fakeSid } from './fake-fixtures.js';

const sid = fakeSid('CA');
const base = { kind: 2, attributes: { 'sip.trunkID': 'trunk', 'sip.ruleID': 'rule', 'c0.callSid': sid } };
const config = { enabled: true, trunkId: 'trunk', ruleId: 'rule', sipKind: 2 };
assert.equal(CALL_SID_RE.test(sid), true);
assert.deepEqual(evaluateGate({ ...base, attributes: { ...base.attributes, 'sip.trunkID': 'wrong' } }, config), { ok: false, reason: 'wrong_trunk' });
assert.deepEqual(evaluateGate({ ...base, attributes: { ...base.attributes, 'sip.ruleID': 'wrong' } }, config), { ok: false, reason: 'wrong_rule' });
assert.deepEqual(evaluateGate({ ...base, attributes: { ...base.attributes, 'c0.callSid': 'bad' } }, config), { ok: false, reason: 'call_sid_malformed' });
assert.deepEqual(evaluateGate({ ...base, attributes: { ...base.attributes, 'c0.callSid': '' } }, config), { ok: false, reason: 'call_sid_missing' });
assert.deepEqual(evaluateGate(base, { ...config, enabled: false }), { ok: false, reason: 'disabled', callSid: sid });
let changed = false;
const delayed: { kind: number; attributes: Record<string, string> } = { kind: 2, attributes: { 'sip.trunkID': 'trunk', 'sip.ruleID': 'rule' } };
const result = await waitForCallSid(delayed, config, async () => { delayed.attributes['c0.callSid'] = sid; changed = true; });
assert.equal(changed, true);
assert.deepEqual(result, { ok: true, callSid: sid });
const delayedDisabled: { kind: number; attributes: Record<string, string> } = { kind: 2, attributes: { 'sip.trunkID': 'trunk', 'sip.ruleID': 'rule' } };
const disabledGate = await waitForCallSid(delayedDisabled, { ...config, enabled: false }, async () => { delayedDisabled.attributes['c0.callSid'] = sid; });
assert.deepEqual(disabledGate, { ok: false, reason: 'disabled', callSid: sid });
const routed: string[] = [];
await routePreSessionRefusal(disabledGate.callSid, async (value) => { routed.push(`flag:${value}`); return { ok: true }; }, async () => { routed.push('end'); });
assert.deepEqual(routed, [`flag:${sid}`], 'delayed valid SID routes office instead of ending only');

const postAdmissionStages = [
  'answered-marker write',
  'usage append',
  'GPTLiveModel construction',
  'Agent construction',
  'AgentSession construction',
  'session.start rejection',
] as const;

for (const failedStage of postAdmissionStages) {
  const operations: string[] = [];
  const sync = {
    create: async ({ uniqueName }: { uniqueName: string }) => { operations.push(`flag:${uniqueName}`); },
    remove: async (uniqueName: string) => { operations.push(`remove:${uniqueName}`); },
  };
  const calls = { calls: (callSid: string) => ({ update: async ({ url }: { url: string }) => { operations.push(`redirect:${callSid}:${url}`); } }) };
  const transfer = (callSid: string, role: 'office' | 'backup') => transferWithSync(
    sync,
    calls,
    { endAiLeg: async () => { operations.push('end-ai-leg'); } },
    callSid,
    role,
    'https://fallback.example/path',
  );
  const result = await startPostAdmission(sync, sid, transfer, async () => {
    for (const stage of postAdmissionStages) {
      operations.push(`run:${stage}`);
      if (stage === failedStage) throw new Error(`injected:${stage}`);
    }
    return 'started';
  });
  assert.deepEqual(result, { ok: false }, `${failedStage} is recovered rather than escaping`);
  assert.ok(operations.includes(`remove:c0-admitted-${sid}`), `${failedStage} attempts to delete the admission document`);
  assert.ok(operations.includes(`flag:c0-transfer-${sid}`), `${failedStage} writes the office transfer flag`);
  assert.ok(operations.includes('end-ai-leg'), `${failedStage} ends the AI leg after writing the transfer flag`);
}

const recoveryEvents: string[] = [];
const syncFlagFailure = {
  create: async () => { throw new Error('sync offline'); },
  remove: async (uniqueName: string) => { recoveryEvents.push(`remove:${uniqueName}`); },
};
const redirectCalls = { calls: (callSid: string) => ({ update: async ({ url }: { url: string }) => { recoveryEvents.push(`redirect:${callSid}:${url}`); } }) };
const syncFailureTransfer = (callSid: string, role: 'office' | 'backup') => transferWithSync(
  syncFlagFailure,
  redirectCalls,
  { endAiLeg: async () => { recoveryEvents.push('end-ai-leg'); } },
  callSid,
  role,
  'https://fallback.example/path',
);
await startPostAdmission(syncFlagFailure, sid, syncFailureTransfer, () => { throw new Error('post-admission failure'); });
assert.ok(recoveryEvents.includes(`remove:c0-admitted-${sid}`), 'admission removal is attempted before the failed transfer flag write');
assert.ok(recoveryEvents.includes(`redirect:${sid}:https://fallback.example/path?role=office`), 'a transfer flag failure redirects the parent call to fallback');
assert.equal(recoveryEvents.includes('end-ai-leg'), false, 'the room is not deleted when Sync failed and the parent redirect takes over');
console.log('worker.check OK');
