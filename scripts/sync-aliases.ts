import 'dotenv/config';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { learnPricebookAlias } from '../src/rag/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIASES_PATH = path.resolve(__dirname, '../data/pricebook-aliases.json');

async function main() {
  const raw = JSON.parse(await readFile(ALIASES_PATH, 'utf-8').catch(() => '{}')) as Record<string, string[]>;
  const entries = Object.entries(raw).filter(([, phrases]) => phrases.length > 0);
  console.log(`Syncing ${entries.length} aliased items to Qdrant...`);

  let ok = 0, unchanged = 0, failed = 0;
  const missing: string[] = [];

  for (const [item_id, phrases] of entries) {
    const result = await learnPricebookAlias({ item_id, phrases });
    if (result.success) {
      if (result.unchanged) { unchanged++; }
      else { ok++; console.log(`  ✓ ${item_id}  ${result.item_name} (${result.alias_count} aliases)`); }
    } else if (result.error?.includes('404')) {
      missing.push(item_id);
      console.warn(`  ? ${item_id}  not found in Qdrant (stale ID)`);
    } else {
      failed++;
      console.error(`  ✗ ${item_id}  ${result.error}`);
    }
  }

  console.log(`\nDone: ${ok} updated, ${unchanged} unchanged, ${missing.length} stale IDs, ${failed} errors`);

  if (missing.length > 0) {
    console.log('\nStale IDs (no longer in pricebook):');
    missing.forEach(id => console.log('  ' + id));
    console.log('\nRemove these from data/pricebook-aliases.json manually.');
  }

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
