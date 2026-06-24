/**
 * Delete empty service and material categories from the live HCP price book.
 *
 * Default: dry-run (shows what would be deleted, no changes).
 *
 * Run:
 *   npx tsx src/hcp/cleanup-empty-categories.ts            (dry-run)
 *   npx tsx src/hcp/cleanup-empty-categories.ts --execute  (apply)
 */
import 'dotenv/config';
import { hcpGet, hcpDelete } from './client.js';

const DRY_RUN = !process.argv.includes('--execute');

async function getElectricalUuid(): Promise<string> {
  const res = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    '/alpha/pricebook/industries'
  );
  const elec = (res.data ?? []).find(i => i.name.toLowerCase().includes('electrical'));
  if (!elec) throw new Error('Electrical industry not found');
  return elec.uuid;
}

async function serviceItemCount(catUuid: string): Promise<number> {
  const res = await hcpGet<{ data: unknown[]; total_count?: number }>(
    `/alpha/pricebook/services?pricebook_category_uuid=${catUuid}&page=1&page_size=1`
  );
  return res.total_count ?? res.data.length;
}

async function materialItemCount(catUuid: string): Promise<number> {
  const res = await hcpGet<{ data: unknown[]; total_count?: number }>(
    `/alpha/pricebook/materials?material_category_uuid=${catUuid}&page=1&page_size=1`
  );
  return res.total_count ?? res.data.length;
}

async function run() {
  console.log(`\nPricebook Category Cleanup — ${DRY_RUN ? 'DRY RUN (pass --execute to apply)' : 'EXECUTE MODE'}\n`);

  const electricalUuid = await getElectricalUuid();

  // ── Service categories ──────────────────────────────────────────────────────
  const svcRes = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    `/alpha/pricebook/categories?pricebook_industry_uuid=${electricalUuid}&page=1&page_size=100&sort_column=order_index&sort_direction=asc`
  );
  const svcCats = svcRes.data ?? [];
  console.log(`Service categories: ${svcCats.length} total`);

  const emptySvc: Array<{ uuid: string; name: string }> = [];
  for (const cat of svcCats) {
    const count = await serviceItemCount(cat.uuid);
    if (count === 0) emptySvc.push(cat);
  }

  // ── Material categories ─────────────────────────────────────────────────────
  const matRes = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    '/alpha/pricebook/material_categories?page=1&page_size=100'
  );
  const matCats = matRes.data ?? [];
  console.log(`Material categories: ${matCats.length} total`);

  const emptyMat: Array<{ uuid: string; name: string }> = [];
  for (const cat of matCats) {
    const count = await materialItemCount(cat.uuid);
    if (count === 0) emptyMat.push(cat);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log(`\nEmpty service categories (${emptySvc.length}):`);
  for (const c of emptySvc) console.log(`  ${c.uuid}  "${c.name}"`);

  console.log(`\nEmpty material categories (${emptyMat.length}):`);
  for (const c of emptyMat) console.log(`  ${c.uuid}  "${c.name}"`);

  if (emptySvc.length + emptyMat.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  if (DRY_RUN) {
    console.log(`\nWould delete ${emptySvc.length + emptyMat.length} empty categories. Run with --execute to apply.`);
    return;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  let ok = 0, fail = 0;
  for (const c of emptySvc) {
    try {
      await hcpDelete(`/alpha/pricebook/categories/${c.uuid}`);
      console.log(`  ✓ deleted service cat: "${c.name}"`);
      ok++;
    } catch (e) {
      console.error(`  ✗ failed "${c.name}": ${(e as Error).message.slice(0, 120)}`);
      fail++;
    }
  }
  for (const c of emptyMat) {
    try {
      await hcpDelete(`/alpha/pricebook/material_categories/${c.uuid}`);
      console.log(`  ✓ deleted material cat: "${c.name}"`);
      ok++;
    } catch (e) {
      console.error(`  ✗ failed "${c.name}": ${(e as Error).message.slice(0, 120)}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} deleted, ${fail} failed.`);
}

run().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
