/**
 * Show which previously-unmatched pricebook items have since been added to HCP.
 *
 * Run after adding items to HCP pricebook + re-exporting the CSV:
 *   npm run export-pricebook && npm run review-unmatched
 *
 * When resolved items appear, run:
 *   npm run enrich-rag -- --force
 *   npm run sync-estimates
 */
import 'dotenv/config';
import fs from 'fs';
import { loadPriceBook } from '../rag/price-book.js';

const TRAINING_LOG = 'data/estimate-training.jsonl';

interface TrainingEntry {
  estimateUuid: string;
  scope: string;
  customerName: string;
  lineItemsMatched: string[];
  lineItemsUnmatched: string[];
  createdAt: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function run() {
  if (!fs.existsSync(TRAINING_LOG)) {
    console.log('No training log yet — build some estimates first (from-chat or from-email).');
    return;
  }

  const entries: TrainingEntry[] = fs
    .readFileSync(TRAINING_LOG, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));

  // Aggregate unmatched items across all estimates
  const unmatchedMap = new Map<string, { displayName: string; count: number; estimates: string[]; lastSeen: string }>();
  for (const entry of entries) {
    for (const item of entry.lineItemsUnmatched) {
      const key = normalize(item);
      const existing = unmatchedMap.get(key) ?? { displayName: item, count: 0, estimates: [], lastSeen: '' };
      existing.count++;
      existing.estimates.push(entry.estimateUuid);
      existing.lastSeen = entry.createdAt;
      unmatchedMap.set(key, existing);
    }
  }

  if (unmatchedMap.size === 0) {
    console.log(`✅ No unmatched items across ${entries.length} logged estimate(s).`);
    return;
  }

  // Check current pricebook
  const catalog = await loadPriceBook();
  const pricebookKeys = new Set(
    catalog.filter(i => i.uuid.startsWith('olit_')).map(i => normalize(i.name)),
  );

  const resolved: Array<{ displayName: string; count: number }> = [];
  const stillMissing: Array<{ displayName: string; count: number; lastSeen: string }> = [];

  for (const data of unmatchedMap.values()) {
    if (pricebookKeys.has(normalize(data.displayName))) {
      resolved.push({ displayName: data.displayName, count: data.count });
    } else {
      stillMissing.push({ displayName: data.displayName, count: data.count, lastSeen: data.lastSeen });
    }
  }

  console.log(`\nTraining log: ${entries.length} estimate(s), ${unmatchedMap.size} unique unmatched item(s)\n`);

  if (resolved.length) {
    console.log('✅ RESOLVED — now in pricebook (were previously unmatched):');
    for (const r of resolved.sort((a, b) => b.count - a.count)) {
      console.log(`   "${r.displayName}" — missed on ${r.count} estimate(s)`);
    }
    console.log('');
    console.log('Next steps:');
    console.log('  npm run enrich-rag -- --force   # re-enrich RAG descriptions');
    console.log('  npm run sync-estimates           # push updated job data to RAG');
    console.log('');
  }

  if (stillMissing.length) {
    console.log('⚠️  STILL MISSING — not yet in pricebook:');
    for (const m of stillMissing.sort((a, b) => b.count - a.count)) {
      const date = m.lastSeen.slice(0, 10);
      console.log(`   "${m.displayName}" — ${m.count} estimate(s), last seen ${date}`);
    }
    console.log('');
    console.log('Add these to HCP pricebook, re-export the CSV, then re-run:');
    console.log('  npm run export-pricebook && npm run review-unmatched');
  }
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
