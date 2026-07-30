import assert from 'node:assert/strict';
import {
  buildSmsEstimateCompletionMessage,
  deriveSmsOperationId,
  parseSmsEstimateReady,
} from './sms-intake.js';

const messageSid = 'SM1234567890abcdef';
const operationId = deriveSmsOperationId(messageSid);
assert.ok(operationId);
assert.equal(deriveSmsOperationId(messageSid), operationId, 'operation ID must be deterministic');

const options = { trustedInboundPhone: '(469) 863-9804', operationId };
const standard = {
  scope: 'Install a dedicated 50A EV charger circuit.',
  customerName: '  Jane Customer  ',
  customerPhone: '+1 469-863-9804',
  customerAddress: '  123 Main St, Dallas, TX 75201  ',
  customerEmail: '   ',
};

const standardDecision = parseSmsEstimateReady(standard, options);
assert.equal(standardDecision.kind, 'ready');
if (standardDecision.kind === 'ready') {
  assert.equal(standardDecision.intake.customerName, 'Jane Customer');
  assert.equal(standardDecision.intake.customerAddress, '123 Main St, Dallas, TX 75201');
  assert.equal(standardDecision.intake.customerEmail, undefined, 'blank email is optional');
  assert.equal(standardDecision.intake.operationId, operationId);
}

const siteWalkDecision = parseSmsEstimateReady({
  ...standard,
  customerEmail: 'jane@example.com',
  leadSource: '  Google  ',
  siteWalk: true,
  depositPercent: 0,
}, options);
assert.equal(siteWalkDecision.kind, 'ready');
if (siteWalkDecision.kind === 'ready') {
  assert.equal(siteWalkDecision.intake.siteWalk, true);
  assert.equal(siteWalkDecision.intake.leadSource, 'Google');
}

for (const [field, value] of [
  ['scope', ''],
  ['customerName', ''],
  ['customerAddress', ''],
] as const) {
  const decision = parseSmsEstimateReady({ ...standard, [field]: value }, options);
  assert.equal(decision.kind, 'review', `missing ${field} should require review`);
}

assert.equal(parseSmsEstimateReady({ ...standard, customerPhone: '' }, options).kind, 'review');
assert.deepEqual(
  parseSmsEstimateReady({ ...standard, unsafeOverride: true }, options),
  { kind: 'review', reason: 'unexpected_field' },
  'unknown keys must not reach CRM behavior',
);
assert.deepEqual(
  parseSmsEstimateReady({ ...standard, customerPhone: '+1 214 555 1212' }, options),
  { kind: 'review', reason: 'phone_mismatch' },
);

assert.match(buildSmsEstimateCompletionMessage({}), /by text\./);
assert.match(buildSmsEstimateCompletionMessage({ customerEmail: 'jane@example.com' }), /by text and email\./);
assert.doesNotMatch(buildSmsEstimateCompletionMessage({}), /on the books/i);

console.log('sms-intake checks passed');
