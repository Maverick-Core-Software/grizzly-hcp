/**
 * Self-check for the offline helpers of the caller-scoped voice lookup.
 * (Network paths are exercised by scripts/probe-voice-lookup.ts against live HCP.)
 * Run with: npx tsx src/agent/tools/reads/voice-lookup.check.ts
 */
import assert from 'node:assert/strict';
import { phoneDigits, normalize, nameMatches, addressMatches, pluck } from './voice-lookup.js';

// phoneDigits
assert.equal(phoneDigits('+1 (469) 863-9804'), '4698639804');
assert.equal(phoneDigits('469.863.9804'), '4698639804');
assert.equal(phoneDigits('14698639804'), '4698639804');
assert.equal(phoneDigits(''), '');
assert.equal(phoneDigits(undefined), '');

// normalize
assert.equal(normalize('  123 Main St., Apt #4 '), '123 main st apt 4');

// nameMatches — last name anchors identity
assert.equal(nameMatches('Mike Smith', 'Michael Smith'), true);
assert.equal(nameMatches('smith', 'Michael Smith'), true);
assert.equal(nameMatches('Mike Jones', 'Michael Smith'), false);
assert.equal(nameMatches('', 'Michael Smith'), false);

// addressMatches — house number + a street word must both hit
assert.equal(addressMatches('123 Main Street, Rowlett', '123 Main St'), true);
assert.equal(addressMatches('123 Maple St', '123 Main St'), false);
assert.equal(addressMatches('456 Main St', '123 Main St'), false);
assert.equal(addressMatches('Main St', '123 Main St'), false);

// pluck — top level, then one level deep, else ''
assert.equal(pluck({ uuid: 'job_1', id: 'x' }, ['uuid', 'id']), 'job_1');
assert.equal(pluck({ schedule: { scheduled_start: '2026-07-14T14:00:00Z' } }, ['scheduled_start']), '2026-07-14T14:00:00Z');
assert.equal(pluck({ n: 42 }, ['n']), '42');
assert.equal(pluck(null, ['uuid']), '');
assert.equal(pluck({ a: 1 }, ['b']), '');

console.log('voice-lookup.check OK');
