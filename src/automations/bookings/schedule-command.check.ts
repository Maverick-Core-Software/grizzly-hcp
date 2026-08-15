/**
 * Offline checks for SCHEDULE command parsing.
 *   npx tsx src/automations/bookings/schedule-command.check.ts
 */
import assert from 'node:assert/strict';
import {
  formatScheduleReplyHint,
  parseScheduleCommand,
  toOffsetIso,
} from './schedule-command.js';

{
  const p = parseScheduleCommand('SCHEDULE 08/18 9:00 am - 11:00 am');
  assert.ok(p);
  assert.equal(p.estimateId, undefined);
  assert.equal(p.start.getMonth(), 7);
  assert.equal(p.start.getDate(), 18);
  assert.equal(p.start.getHours(), 9);
  assert.equal(p.end.getHours(), 11);
}

{
  const p = parseScheduleCommand('SCHEDULE 502552175 8/18/2026 2:00 pm - 4:00 pm');
  assert.ok(p);
  assert.equal(p.estimateId, 502552175);
  assert.equal(p.start.getHours(), 14);
  assert.equal(p.end.getHours(), 16);
}

{
  const p = parseScheduleCommand('SCHEDULE #502552175 08/18 9:00 am to 11:00 am');
  assert.ok(p);
  assert.equal(p.estimateId, 502552175);
}

{
  assert.equal(parseScheduleCommand('please schedule tomorrow'), null);
  assert.equal(parseScheduleCommand('SCHEDULE 08/18 9:00 am'), null); // missing end
  assert.equal(parseScheduleCommand('SCHEDULE 08/18 11:00 am - 9:00 am'), null); // end before start
}

{
  const d = new Date(2026, 7, 18, 14, 0, 0);
  const iso = toOffsetIso(d);
  assert.match(iso, /^2026-08-18T14:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(iso.includes('Z'), false);
}

{
  assert.match(formatScheduleReplyHint(502552175), /SCHEDULE 502552175/);
}

console.log('✓ schedule-command self-check passed');
