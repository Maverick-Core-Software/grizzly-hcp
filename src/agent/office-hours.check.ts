/**
 * Self-check for office hours. No test framework — run with:
 *   npx tsx src/agent/office-hours.check.ts
 * Fixture dates are UTC instants chosen to land on known Central-time moments.
 * July = CDT (UTC-5), January = CST (UTC-6).
 */
import assert from 'node:assert/strict';
import { officeStatus } from './office-hours.js';

// Monday 2026-07-13 (CDT)
assert.equal(officeStatus(new Date('2026-07-13T13:00:00Z')), 'OPEN', 'Mon 08:00 open boundary');
assert.equal(officeStatus(new Date('2026-07-13T12:59:00Z')), 'CLOSED', 'Mon 07:59 closed');
assert.equal(officeStatus(new Date('2026-07-13T22:59:00Z')), 'OPEN', 'Mon 17:59 open');
assert.equal(officeStatus(new Date('2026-07-13T23:00:00Z')), 'CLOSED', 'Mon 18:00 closed boundary');

// Saturday 2026-07-18 (CDT): 08:00–14:00
assert.equal(officeStatus(new Date('2026-07-18T14:00:00Z')), 'OPEN', 'Sat 09:00 open');
assert.equal(officeStatus(new Date('2026-07-18T18:59:00Z')), 'OPEN', 'Sat 13:59 open');
assert.equal(officeStatus(new Date('2026-07-18T19:00:00Z')), 'CLOSED', 'Sat 14:00 closed boundary');

// Sunday 2026-07-19 (CDT): always closed
assert.equal(officeStatus(new Date('2026-07-19T16:00:00Z')), 'CLOSED', 'Sun midday closed');

// Winter (CST, UTC-6): Monday 2026-01-12
assert.equal(officeStatus(new Date('2026-01-12T14:00:00Z')), 'OPEN', 'Mon 08:00 CST open');
assert.equal(officeStatus(new Date('2026-01-12T13:59:00Z')), 'CLOSED', 'Mon 07:59 CST closed');

console.log('office-hours.check OK');
