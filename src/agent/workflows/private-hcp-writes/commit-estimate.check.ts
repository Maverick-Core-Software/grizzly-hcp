/**
 * Self-check for depositDollarsFromPercent. No test framework — run with:
 *   npx tsx src/agent/workflows/private-hcp-writes/commit-estimate.check.ts
 *
 * Guards the deposit units bug: commit-estimate used to pass depositPercent (50)
 * straight into setDeposit's flatAmountDollars slot, so a 50% deposit became a
 * flat $50. setDeposit always stores flat dollars; the deposit must be derived
 * from the line-item subtotal here.
 */
import assert from 'node:assert/strict';
import { depositDollarsFromPercent } from './commit-estimate.js';

// 1. The exact live-gate scenario: subtotal 345.99, 50% → 172.995 → toFixed(2) = 173.
const gate = depositDollarsFromPercent(
  [
    { unitPrice: 150, quantity: 2, kind: 'labor' },
    { unitPrice: 12, quantity: 3, kind: 'materials' },
    { unitPrice: 9.99, quantity: 1, kind: 'materials' },
  ],
  50,
);
assert.equal(gate, 173, `gate scenario should yield 173, got ${gate}`);
assert.notEqual(gate, 50, 'must NOT be the flat $50 from the old percent-as-dollars bug');

// 2. A 'fixed discount' line reduces the deposit base (positive-magnitude convention).
const withDiscount = depositDollarsFromPercent(
  [
    { unitPrice: 100, quantity: 2, kind: 'labor' },   // +200
    { unitPrice: 40, quantity: 1, kind: 'fixed discount' }, // -40 → subtotal 160
  ],
  50,
);
assert.equal(withDiscount, 80, `discount should reduce base: expected 80, got ${withDiscount}`);

// 3. 0% deposit → 0.
assert.equal(
  depositDollarsFromPercent([{ unitPrice: 500, quantity: 1, kind: 'labor' }], 0),
  0,
  '0% deposit must be 0',
);

console.log('✓ commit-estimate deposit self-check passed — deposit derived from subtotal × percent');
