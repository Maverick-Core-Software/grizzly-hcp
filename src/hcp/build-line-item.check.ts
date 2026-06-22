/**
 * Self-check for the no-match line-item policy. No test framework — run with:
 *   npx tsx src/hcp/build-line-item.check.ts
 *
 * Guards the F2 regression: a no-match item must NOT write a $0 placeholder to
 * the live HCP price book, and must come back as a flagged $0 line for manual pricing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLineItem, NEEDS_PRICING_FLAG, type MatchedWorkItem } from './build-line-item.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. No match → $0 line, flagged, no price-book id.
const noMatch: MatchedWorkItem = { description: '3 New Dedicated 20A Circuits', quantity: 1, unitPrice: 0, match: null };
const { item: unpriced, matched: m1 } = buildLineItem(noMatch, 0);
assert.equal(m1, false, 'no-match item should report matched=false');
assert.equal(unpriced.unitPrice, 0, 'no-match item must be $0');
assert.equal(unpriced.description, NEEDS_PRICING_FLAG, 'no-match item must carry the NEEDS-PRICING flag');
assert.equal(unpriced.serviceItemId, undefined, 'no-match item must not reference a price-book item');
assert.equal(unpriced.name, noMatch.description, 'no-match item keeps the work description as its name');

// 2. Real match → price flows through from the price book.
const withMatch: MatchedWorkItem = {
  description: 'GFCI receptacle',
  quantity: 2,
  unitPrice: 0,
  match: {
    item: { category: 'Labor', uuid: 'olit_real', name: 'Replace GFCI Receptacle', description: '', price: 149, priceStr: '$149.00', unitOfMeasure: 'Each' },
    score: 0.8,
    exact: false,
  },
};
const { item: priced, matched: m2 } = buildLineItem(withMatch, 1);
assert.equal(m2, true, 'matched item should report matched=true');
assert.equal(priced.unitPrice, 149, 'matched item takes the price-book price');
assert.equal(priced.serviceItemId, 'olit_real', 'matched item references the price-book uuid');

// 3. Static guard: neither automation may write to the live price book on no-match.
for (const f of ['../automations/estimates/from-chat.ts', '../automations/estimates/from-email.ts']) {
  const src = fs.readFileSync(path.resolve(__dirname, f), 'utf-8');
  assert.ok(!/createPriceBookItem/.test(src), `${f} must not call createPriceBookItem (would write a $0 item to the live price book)`);
}

console.log('✓ build-line-item self-check passed — no $0 price-book writes on no-match');
