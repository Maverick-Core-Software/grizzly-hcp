/**
 * Syncs renamed/recategorized pricebook items from data/pricebook.csv → live HCP.
 *
 * Default: dry-run (no changes). Pass --execute to apply.
 * Pass --probe to test PATCH on a single item first.
 *
 * Run:
 *   npx tsx src/hcp/update-pricebook-from-csv.ts           (dry-run)
 *   npx tsx src/hcp/update-pricebook-from-csv.ts --execute (apply all)
 *   npx tsx src/hcp/update-pricebook-from-csv.ts --probe   (test one item)
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { hcpGet, hcpPatch, hcpPostForm } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH  = path.resolve(__dirname, '../../data/pricebook.csv');
const DRY_RUN   = !process.argv.includes('--execute');
const PROBE     = process.argv.includes('--probe');

// ─── CSV parsing ──────────────────────────────────────────────────────────────

interface CsvRow {
  industryUuid: string;
  category:     string;
  uuid:         string;
  name:         string;
  description:  string;
  price:        string;  // "$xxx.xx"
  unitOfMeasure: string;
}

function parsePrice(s: string): number {
  return Math.round(parseFloat(s.replace('$', '') || '0') * 100);
}

async function readCsv(): Promise<CsvRow[]> {
  const text  = await fs.readFile(CSV_PATH, 'utf-8');
  const lines = text.split('\n').filter(l => l.trim());
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].match(/"([^"]*)"/g)?.map(s => s.slice(1, -1)) ?? [];
    if (cols.length < 6) continue;
    rows.push({
      industryUuid:  cols[1] ?? '',
      category:      cols[2] ?? '',
      uuid:          cols[3] ?? '',
      name:          cols[4] ?? '',
      description:   cols[5] ?? '',
      price:         cols[6] ?? '$0.00',
      unitOfMeasure: cols[9] ?? 'Each',
    });
  }
  return rows;
}

// ─── HCP category fetching ────────────────────────────────────────────────────

async function fetchServiceCategories(electricalUuid: string): Promise<Map<string, string>> {
  const res = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    `/alpha/pricebook/categories?pricebook_industry_uuid=${electricalUuid}&page=1&page_size=100&sort_column=order_index&sort_direction=asc`
  );
  const map = new Map<string, string>();
  for (const c of res.data ?? []) map.set(c.name.trim(), c.uuid);
  return map;
}

async function fetchMaterialCategories(): Promise<Map<string, string>> {
  const res = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    '/alpha/pricebook/material_categories?page=1&page_size=100'
  );
  const map = new Map<string, string>();
  for (const c of res.data ?? []) map.set(c.name.trim(), c.uuid);
  return map;
}

// ─── HCP live item fetching ───────────────────────────────────────────────────

async function fetchLiveServices(electricalUuid: string, catUuid: string): Promise<Map<string, { name: string; categoryUuid: string }>> {
  const map = new Map<string, { name: string; categoryUuid: string }>();
  let page = 1;
  while (true) {
    const res = await hcpGet<{ data: Array<{ uuid: string; name: string; pricebook_category_uuid: string }>; total_pages_count: number }>(
      `/alpha/pricebook/services?pricebook_category_uuid=${catUuid}&page=${page}&page_size=100&sort_column=name&sort_direction=asc`
    );
    for (const s of res.data) map.set(s.uuid, { name: s.name, categoryUuid: s.pricebook_category_uuid });
    if (page >= res.total_pages_count) break;
    page++;
  }
  return map;
}

async function fetchLiveMaterials(catUuid: string): Promise<Map<string, { name: string; categoryUuid: string }>> {
  const map = new Map<string, { name: string; categoryUuid: string }>();
  let page = 1;
  while (true) {
    const res = await hcpGet<{ data: Array<{ uuid: string; name: string; material_category_uuid: string }>; total_pages_count: number }>(
      `/alpha/pricebook/materials?material_category_uuid=${catUuid}&page=${page}&page_size=100&sort_column=name&sort_direction=asc`
    );
    for (const m of res.data) map.set(m.uuid, { name: m.name, categoryUuid: m.material_category_uuid });
    if (page >= res.total_pages_count) break;
    page++;
  }
  return map;
}

// ─── Category creation ────────────────────────────────────────────────────────

async function ensureServiceCategory(name: string, electricalUuid: string, catMap: Map<string, string>): Promise<string | null> {
  if (catMap.has(name)) return catMap.get(name)!;
  console.log(`  [NEW CAT] Creating service category: "${name}"`);
  if (DRY_RUN) { console.log('    → dry-run: skipped'); return null; }
  try {
    const res = await hcpPostForm<{ uuid: string; name: string }>(
      '/alpha/pricebook/categories',
      { name, pricebook_industry_uuid: electricalUuid }
    );
    catMap.set(name, res.uuid);
    return res.uuid;
  } catch (e) {
    console.error(`    → FAILED to create category: ${(e as Error).message}`);
    return null;
  }
}

async function ensureMaterialCategory(name: string, catMap: Map<string, string>): Promise<string | null> {
  if (catMap.has(name)) return catMap.get(name)!;
  console.log(`  [NEW MAT CAT] Creating material category: "${name}"`);
  if (DRY_RUN) { console.log('    → dry-run: skipped'); return null; }
  try {
    const res = await hcpPostForm<{ uuid: string; name: string }>(
      '/alpha/pricebook/material_categories',
      { name }
    );
    catMap.set(name, res.uuid);
    return res.uuid;
  } catch (e) {
    console.error(`    → FAILED to create material category: ${(e as Error).message}`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nPricebook HCP Sync — ${DRY_RUN ? 'DRY RUN (pass --execute to apply)' : 'EXECUTE MODE'}\n`);

  const rows = await readCsv();
  const serviceRows  = rows.filter(r => r.uuid.startsWith('olit_'));
  const materialRows = rows.filter(r => r.uuid.startsWith('pbmat_'));
  console.log(`CSV: ${serviceRows.length} services, ${materialRows.length} materials`);

  // Get electrical industry UUID from CSV (already stored there)
  const electricalUuid = rows.find(r => r.industryUuid)?.industryUuid ?? '';
  if (!electricalUuid) throw new Error('No industryUuid in CSV');

  // ── Service categories ──────────────────────────────────────────────────────
  console.log('\nFetching HCP service categories...');
  const svcCatMap = await fetchServiceCategories(electricalUuid);
  console.log(`  ${svcCatMap.size} categories in HCP`);

  // Ensure all CSV service categories exist in HCP
  const csvSvcCats = [...new Set(serviceRows.map(r => r.category))];
  for (const cat of csvSvcCats) {
    await ensureServiceCategory(cat, electricalUuid, svcCatMap);
  }

  // ── Material categories ─────────────────────────────────────────────────────
  console.log('\nFetching HCP material categories...');
  const matCatMap = await fetchMaterialCategories();
  console.log(`  ${matCatMap.size} material categories in HCP`);

  const csvMatCats = [...new Set(materialRows.map(r => r.category))];
  for (const cat of csvMatCats) {
    await ensureMaterialCategory(cat, matCatMap);
  }

  // ── Fetch all live items ────────────────────────────────────────────────────
  console.log('\nFetching all live service items from HCP...');
  const liveServices = new Map<string, { name: string; categoryUuid: string }>();
  for (const [, uuid] of svcCatMap) {
    const items = await fetchLiveServices(electricalUuid, uuid);
    for (const [k, v] of items) liveServices.set(k, v);
  }
  console.log(`  ${liveServices.size} live services`);

  console.log('\nFetching all live material items from HCP...');
  const liveMaterials = new Map<string, { name: string; categoryUuid: string }>();
  for (const [, uuid] of matCatMap) {
    const items = await fetchLiveMaterials(uuid);
    for (const [k, v] of items) liveMaterials.set(k, v);
  }
  console.log(`  ${liveMaterials.size} live materials`);

  // ── Compute diff ────────────────────────────────────────────────────────────
  const svcChanges: Array<{ uuid: string; name: string; categoryUuid: string; oldName?: string; oldCat?: string }> = [];
  const matChanges: Array<{ uuid: string; name: string; categoryUuid: string; oldName?: string; oldCat?: string }> = [];

  for (const row of serviceRows) {
    const live = liveServices.get(row.uuid);
    const targetCatUuid = svcCatMap.get(row.category);
    if (!targetCatUuid) {
      console.warn(`  ⚠ No category UUID for "${row.category}" — skipping ${row.uuid}`);
      continue;
    }
    const nameChanged = live && live.name !== row.name;
    const catChanged  = live && live.categoryUuid !== targetCatUuid;
    if (!live || nameChanged || catChanged) {
      svcChanges.push({ uuid: row.uuid, name: row.name, categoryUuid: targetCatUuid, oldName: live?.name, oldCat: live?.categoryUuid });
    }
  }

  for (const row of materialRows) {
    const live = liveMaterials.get(row.uuid);
    const targetCatUuid = matCatMap.get(row.category);
    if (!targetCatUuid) {
      console.warn(`  ⚠ No material category UUID for "${row.category}" — skipping ${row.uuid}`);
      continue;
    }
    const nameChanged = live && live.name !== row.name;
    const catChanged  = live && live.categoryUuid !== targetCatUuid;
    if (!live || nameChanged || catChanged) {
      matChanges.push({ uuid: row.uuid, name: row.name, categoryUuid: targetCatUuid, oldName: live?.name, oldCat: live?.categoryUuid });
    }
  }

  console.log(`\n── Changes needed: ${svcChanges.length} services, ${matChanges.length} materials ──`);

  if (svcChanges.length === 0 && matChanges.length === 0) {
    console.log('Nothing to update — HCP is already in sync with CSV.');
    return;
  }

  // Print diff
  for (const c of svcChanges) {
    if (c.oldName !== c.name) console.log(`  [SVC] ${c.uuid}\n       "${c.oldName ?? '(not found)'}"\n    →  "${c.name}"`);
    if (c.oldCat  !== c.categoryUuid) console.log(`       cat: ${c.oldCat ?? '?'} → ${c.categoryUuid}`);
  }
  for (const c of matChanges) {
    if (c.oldName !== c.name) console.log(`  [MAT] ${c.uuid}\n       "${c.oldName ?? '(not found)'}"\n    →  "${c.name}"`);
    if (c.oldCat  !== c.categoryUuid) console.log(`       cat: ${c.oldCat ?? '?'} → ${c.categoryUuid}`);
  }

  if (DRY_RUN) {
    console.log('\nDry run complete. Pass --execute to apply.');
    return;
  }

  if (PROBE) {
    // Test a single PATCH before bulk run
    const first = svcChanges[0] ?? matChanges[0];
    if (!first) { console.log('Nothing to probe.'); return; }
    const isService = first.uuid.startsWith('olit_');
    const endpoint  = isService
      ? `/alpha/pricebook/services/${first.uuid}`
      : `/alpha/pricebook/materials/${first.uuid}`;
    const body = isService
      ? { name: first.name, pricebook_category_uuid: first.categoryUuid }
      : { name: first.name, material_category_uuid: first.categoryUuid };
    console.log(`\nProbing PATCH ${endpoint}...`);
    console.log('Body:', JSON.stringify(body, null, 2));
    const res = await hcpPatch<unknown>(endpoint, body);
    console.log('Response:', JSON.stringify(res, null, 2));
    console.log('\nProbe succeeded. Run with --execute to apply all changes.');
    return;
  }

  // ── Execute PATCHes ─────────────────────────────────────────────────────────
  let ok = 0, fail = 0;

  for (const c of svcChanges) {
    try {
      await hcpPatch(`/alpha/pricebook/services/${c.uuid}`, {
        name:                    c.name,
        pricebook_category_uuid: c.categoryUuid,
      });
      process.stdout.write('.');
      ok++;
    } catch (e) {
      fail++;
      console.error(`\n  FAIL ${c.uuid}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  for (const c of matChanges) {
    try {
      await hcpPatch(`/alpha/pricebook/materials/${c.uuid}`, {
        name:                  c.name,
        material_category_uuid: c.categoryUuid,
      });
      process.stdout.write('.');
      ok++;
    } catch (e) {
      fail++;
      console.error(`\n  FAIL ${c.uuid}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  console.log(`\n\nDone. ${ok} updated, ${fail} failed.`);
  if (fail === 0) {
    console.log('HCP pricebook is now in sync with data/pricebook.csv.');
  }
}

run().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
