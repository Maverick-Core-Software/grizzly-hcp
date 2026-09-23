import assert from 'node:assert/strict';
import { fetchAllowedCaller } from './caller.js';
import { fakeSid } from './fake-fixtures.js';

const sid = fakeSid('CA');
const allowed = ['+15551230001'];
assert.equal(await fetchAllowedCaller({ calls: () => ({ fetch: async () => ({ from: '+15551230001' }) }) }, sid, allowed), '+15551230001');
assert.equal(await fetchAllowedCaller({ calls: () => ({ fetch: async () => ({ from: '+15551230002' }) }) }, sid, allowed), null, 'non-allowlisted caller fails closed');
assert.equal(await fetchAllowedCaller({ calls: () => ({ fetch: async () => { throw new Error('unavailable'); } }) }, sid, allowed), null, 'fetch failure fails closed');
console.log('caller.check OK');
