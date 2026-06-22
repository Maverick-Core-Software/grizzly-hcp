/**
 * Find and remove $0 (unpriced) items from the live HCP price book — cleanup for
 * the junk left behind by the old auto-create-on-no-match bug (TEST-RESULTS F2).
 *
 * List $0 services:            npx tsx src/hcp/cleanup-zero-items.ts
 * Delete specific items:       npx tsx src/hcp/cleanup-zero-items.ts --delete olit_aaa,olit_bbb
 * Delete ALL $0 services:      npx tsx src/hcp/cleanup-zero-items.ts --delete-all-zero
 */
import 'dotenv/config';
import { listAllServices, deletePriceBookItem } from './price-book.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const services = await listAllServices();
const zero = services.filter(s => s.price === 0);

console.log(`\n${services.length} services total, ${zero.length} at $0:\n`);
for (const s of zero) console.log(`  ${s.uuid}  [${s.category}]  ${s.name}`);

const deleteAllZero = process.argv.includes('--delete-all-zero');
const explicit = (arg('--delete') ?? '').split(',').map(s => s.trim()).filter(Boolean);

const toDelete = deleteAllZero
  ? zero.map(s => s.uuid)
  : explicit;

if (toDelete.length === 0) {
  console.log('\nNothing deleted (pass --delete <uuid,uuid> or --delete-all-zero to remove).');
  process.exit(0);
}

console.log(`\nDeleting ${toDelete.length} item(s)...`);
for (const uuid of toDelete) {
  const svc = services.find(s => s.uuid === uuid);
  try {
    await deletePriceBookItem(uuid);
    console.log(`  ✓ deleted ${uuid}${svc ? ` (${svc.name})` : ''}`);
  } catch (e) {
    console.error(`  ✗ failed ${uuid}: ${e instanceof Error ? e.message : e}`);
  }
}
console.log('\nDone. Local pricebook.csv updated. (RAG vectors persist until next full rebuild.)');
