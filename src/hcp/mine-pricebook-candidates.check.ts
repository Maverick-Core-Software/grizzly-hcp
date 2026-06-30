/**
 * Self-check for pure utilities in mine-pricebook-candidates.
 * No framework — run with: npx tsx src/hcp/mine-pricebook-candidates.check.ts
 */
import assert from 'node:assert/strict';
import { normalize, modalValue, aggregateCandidates } from './mine-pricebook-candidates.js';

// ── normalize ──────────────────────────────────────────────────────────────
assert.equal(normalize('Ground Rod Installation'), 'ground rod installation');
assert.equal(normalize('Outlet - 20A (GFCI)'), 'outlet 20a gfci');
assert.equal(normalize('  Panel   Upgrade  '), 'panel upgrade');

// ── modalValue ─────────────────────────────────────────────────────────────
assert.equal(modalValue([100, 200, 100, 300]), 100, '100 appears twice — wins');
assert.equal(modalValue([200, 100]), 100, 'tie → lowest value wins');
assert.equal(modalValue([100, 200]), 100, 'tie with reversed order → still lowest wins, not first');
assert.equal(modalValue([150]), 150, 'single element');

// ── aggregateCandidates ────────────────────────────────────────────────────
const jobs = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }];
const lineItemsByJob = new Map([
  ['j1', [
    { name: 'Ground Rod', unit_price: 18500, kind: 'labor', service_item_id: null },
    { name: 'Ground Rod', unit_price: 18500, kind: 'labor', service_item_id: null }, // duplicate in same job
  ]],
  ['j2', [
    { name: 'Ground Rod', unit_price: 20000, kind: 'labor', service_item_id: null },
    { name: 'Panel Upgrade', unit_price: 150000, kind: 'labor', service_item_id: 'olit_existing' }, // pricebook item — skip
  ]],
  ['j3', [
    { name: 'Ground Rod', unit_price: 18500, kind: 'labor', service_item_id: null },
  ]],
]);

const agg = aggregateCandidates(jobs, lineItemsByJob);

const gr = agg.get('ground rod');
assert.ok(gr, 'Ground Rod should be aggregated');
assert.ok(agg instanceof Map, 'aggregateCandidates should return a Map');
assert.ok(typeof gr.uses === 'number', 'candidate entry must have numeric uses');
assert.ok(Array.isArray(gr.prices), 'candidate entry must have prices array');
assert.equal(gr.uses, 3, '3 distinct jobs — duplicate within j1 does not count twice');
assert.deepEqual(gr.prices, [18500, 20000, 18500], 'prices collected from each job occurrence');

assert.ok(!agg.has('panel upgrade'), 'pricebook-linked items (service_item_id set) must be skipped');

// empty inputs must not throw
const emptyAgg = aggregateCandidates([], new Map());
assert.ok(emptyAgg instanceof Map && emptyAgg.size === 0, 'empty jobs → empty Map');

console.log('✓ mine-pricebook-candidates self-check passed');
