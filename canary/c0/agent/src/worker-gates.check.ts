import assert from 'node:assert/strict';
import { routePreSessionRefusal } from './worker.js';

const sid = `CA${'a'.repeat(32)}`;
const noModelSessions = () => 0;
async function refusal(name: string, parentCallSid: string | undefined, expected: 'transferred' | 'ended') {
  const events: string[] = [];
  const result = await routePreSessionRefusal(parentCallSid, async (value, role) => { events.push(`flag:${value}:${role}`, 'end'); return { ok: true }; }, async () => { events.push('end'); });
  assert.equal(result, expected, name);
  assert.equal(noModelSessions(), 0, `${name} never constructs a model or session`);
  assert.deepEqual(events, expected === 'transferred' ? [`flag:${sid}:office`, 'end'] : ['end']);
}
await refusal('disabled valid SID', sid, 'transferred');
await refusal('bad trunk valid SID', sid, 'transferred');
await refusal('bad rule valid SID', sid, 'transferred');
await refusal('missing SID', undefined, 'ended');
await refusal('malformed SID', 'bad', 'ended');
await refusal('caller not allowlisted', sid, 'transferred');
await refusal('caller fetch error', sid, 'transferred');
await refusal('mapping conflict', sid, 'transferred');
await refusal('admission deny', sid, 'transferred');
await refusal('admitted-document write failure', sid, 'transferred');
console.log('worker-gates.check OK');
