import assert from 'node:assert/strict';
import { ParticipantKind } from '@livekit/rtc-node';
import { activeSipCanaryCalls, evaluateCanaryAdmission } from './admission.js';

const rooms = {
  listRooms: async () => [{ name: 'c0-current' }, { name: 'other' }, { name: 'c0-two' }],
  listParticipants: async (name: string) => name === 'c0-two' || name === 'c0-current' ? [{ kind: ParticipantKind.SIP }] : [{ kind: ParticipantKind.STANDARD }],
};
assert.equal(await activeSipCanaryCalls(rooms, 'c0-current'), 1);
assert.deepEqual(await evaluateCanaryAdmission(rooms, 'c0-current', null), { admit: false, reason: 'counters_unobservable' }, 'unknown usage denies admission');
assert.deepEqual(await evaluateCanaryAdmission(rooms, 'c0-current', { todayCalls: 0, todayGptLiveMinutes: 0 }), { admit: false, reason: 'concurrency_limit_reached' }, 'one other SIP room denies a second call');
const first = { listRooms: async () => [{ name: 'c0-current' }], listParticipants: async () => [{ kind: ParticipantKind.SIP }] };
assert.equal((await evaluateCanaryAdmission(first, 'c0-current', { todayCalls: 0, todayGptLiveMinutes: 0 })).admit, true, 'the first call excludes itself');
assert.deepEqual(await evaluateCanaryAdmission({ listRooms: async () => { throw new Error('down'); }, listParticipants: async () => [] }, 'c0-current', { todayCalls: 0, todayGptLiveMinutes: 0 }), { admit: false, reason: 'counters_unobservable' });
console.log('admission.check OK');
