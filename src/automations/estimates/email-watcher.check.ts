/**
 * Self-check for the email-watcher sender deny-list.
 * Run: npx tsx src/automations/estimates/email-watcher.check.ts
 *
 * Verifies Housecall Pro / CRM notifications are skipped before classification,
 * and that genuine customer senders still pass through to Haiku.
 */
import assert from 'node:assert/strict';
import { isIgnoredSender } from './email-watcher.js';

// Real HCP notification senders observed in the live inbox — must be ignored.
const MUST_IGNORE = [
  'Housecall Pro <notifications@housecallpro.com>',
  'Grizzly Electrical Solutions <notifications@housecallpro.com>',
  'TradeWire by Housecall Pro <info@updates.housecallpro.com>',
  'notifications@housecallpro.com',
  'someone@mail.housecallpro.com',
];

// Genuine customers / our own test sends — must NOT be ignored (go to Haiku).
const MUST_PASS = [
  'Carter Barns <carterbarns@grizzlyelectrical.net>',
  'Ray Liotta <projectmanager.ray@gmail.com>',
  'jane@gmail.com',
  // lookalike domain must not be caught by the housecallpro.com rule
  'scammer@nothousecallpro.com.evil.example',
];

for (const from of MUST_IGNORE) {
  assert.equal(isIgnoredSender(from), true, `should ignore: ${from}`);
}
for (const from of MUST_PASS) {
  assert.equal(isIgnoredSender(from), false, `should pass: ${from}`);
}

console.log(`✓ email-watcher deny-list self-check passed (${MUST_IGNORE.length} ignored, ${MUST_PASS.length} passed)`);
