import assert from 'node:assert/strict';
import { bindOrTransfer } from './mapping.js';
import { fakeSid } from './fake-fixtures.js';

const sid = fakeSid('CA');
const input = { parentCallSid: sid, trunkId: 'trunk', ruleId: 'rule', roomName: 'c0-room', participantIdentity: 'sip' };
const transfers: string[] = [];
assert.equal(await bindOrTransfer({ bind: () => ({ accepted: false }), record: async () => ({ accepted: false }), transferIntent: async () => ({ accepted: false }) }, input, async (callSid) => { transfers.push(callSid); return { ok: true }; }), false);
assert.deepEqual(transfers, [sid], 'mapping conflict transfers instead of proceeding');
assert.equal(await bindOrTransfer({ bind: () => { throw new Error('store unavailable'); }, record: async () => ({ accepted: false }), transferIntent: async () => ({ accepted: false }) }, input, async (callSid) => { transfers.push(callSid); return { ok: true }; }), false);
assert.deepEqual(transfers, [sid, sid], 'mapping storage error transfers instead of stranding caller');
console.log('mapping.check OK');
