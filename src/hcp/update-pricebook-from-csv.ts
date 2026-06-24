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
const PROBE   = process.argv.includes('--probe');
const DRY_RUN = !process.argv.includes('--execute') && !PROBE;

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

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += ch; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readCsv(): Promise<CsvRow[]> {
  const text = await fs.readFile(CSV_PATH, 'utf-8');
  const allRows = parseCsvRows(text);
  const rows: CsvRow[] = [];
  for (let i = 1; i < allRows.length; i++) {
    const cols = allRows[i];
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

/** Returns { pricebookUuid, catMap } — pricebookUuid is the `uuid` field (not industry_uuid). */
async function fetchServiceCategories(): Promise<{ pricebookUuid: string; catMap: Map<string, string> }> {
  const industries = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    '/alpha/pricebook/industries'
  );
  const electrical = (industries.data ?? []).find(i => i.name.toLowerCase().includes('electrical'));
  if (!electrical) throw new Error('Electrical industry not found in HCP');

  const res = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    `/alpha/pricebook/categories?pricebook_industry_uuid=${electrical.uuid}&page=1&page_size=100&sort_column=order_index&sort_direction=asc`
  );
  const catMap = new Map<string, string>();
  for (const c of res.data ?? []) catMap.set(c.name.trim(), c.uuid);
  return { pricebookUuid: electrical.uuid, catMap };
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

async function ensureServiceCategory(name: string, catMap: Map<string, string>, pricebookUuid: string): Promise<string | null> {
  if (catMap.has(name)) return catMap.get(name)!;
  console.log(`  [NEW CAT] Creating service category: "${name}"`);
  if (DRY_RUN) { console.log('    → dry-run: skipped'); return null; }
  try {
    const res = await hcpPostForm<{ uuid: string; name: string }>(
      '/alpha/pricebook/categories',
      { name, pricebook_industry_uuid: pricebookUuid }
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
  const mode = PROBE ? 'PROBE (one item)' : DRY_RUN ? 'DRY RUN (pass --execute to apply)' : 'EXECUTE MODE';
  console.log(`\nPricebook HCP Sync — ${mode}\n`);

  const rows = await readCsv();
  const serviceRows  = rows.filter(r => r.uuid.startsWith('olit_'));
  const materialRows = rows.filter(r => r.uuid.startsWith('pbmat_'));
  console.log(`CSV: ${serviceRows.length} services, ${materialRows.length} materials`);

  // ── Fetch all existing HCP categories ──────────────────────────────────────
  console.log('\nFetching HCP categories...');
  const { pricebookUuid: electricalUuid, catMap: existingSvcCatMap } = await fetchServiceCategories();
  const existingMatCatMap = await fetchMaterialCategories();
  const svcCatUuidToName = new Map([...existingSvcCatMap].map(([n, u]) => [u, n]));
  const matCatUuidToName = new Map([...existingMatCatMap].map(([n, u]) => [u, n]));
  console.log(`  ${existingSvcCatMap.size} service categories, ${existingMatCatMap.size} material categories`);

  // ── Fetch ALL live items (from all existing categories) ───────────────────
  console.log('\nFetching all live items from HCP...');
  const liveServices  = new Map<string, { name: string; categoryUuid: string }>();
  const liveMaterials = new Map<string, { name: string; categoryUuid: string }>();

  for (const [, uuid] of existingSvcCatMap) {
    for (const [k, v] of await fetchLiveServices(electricalUuid, uuid)) liveServices.set(k, v);
  }
  for (const [, uuid] of existingMatCatMap) {
    for (const [k, v] of await fetchLiveMaterials(uuid)) liveMaterials.set(k, v);
  }
  console.log(`  ${liveServices.size} services, ${liveMaterials.size} materials`);

  // ── DRY RUN: show diff by name/category-name comparison, no mutations ─────
  if (DRY_RUN) {
    // Figure out which categories are new
    const newSvcCats = [...new Set(serviceRows.map(r => r.category))].filter(c => !existingSvcCatMap.has(c));
    const newMatCats = [...new Set(materialRows.map(r => r.category))].filter(c => !existingMatCatMap.has(c));
    if (newSvcCats.length) console.log(`\n  Categories to CREATE in HCP (${newSvcCats.length}):\n  ${newSvcCats.join('\n  ')}`);
    if (newMatCats.length) console.log(`\n  Material categories to CREATE (${newMatCats.length}):\n  ${newMatCats.join('\n  ')}`);

    // Show item-level diff
    let nameChanges = 0, catChanges = 0, notFound = 0;
    for (const row of [...serviceRows, ...materialRows]) {
      const isService = row.uuid.startsWith('olit_');
      const live      = isService ? liveServices.get(row.uuid) : liveMaterials.get(row.uuid);
      if (!live) { notFound++; continue; }
      const liveCatName = isService ? svcCatUuidToName.get(live.categoryUuid) : matCatUuidToName.get(live.categoryUuid);
      const nChanged = live.name !== row.name;
      const cChanged = liveCatName !== row.category;
      if (nChanged || cChanged) {
        const tag = isService ? '[SVC]' : '[MAT]';
        console.log(`  ${tag} "${live.name}"`);
        if (nChanged) { console.log(`       name → "${row.name}"`); nameChanges++; }
        if (cChanged) { console.log(`       cat  "${liveCatName ?? '?'}" → "${row.category}"`); catChanges++; }
      }
    }
    console.log(`\n── Summary: ${nameChanges} name changes, ${catChanges} category moves, ${notFound} not in HCP ──`);
    if (newSvcCats.length || newMatCats.length) console.log(`  ${newSvcCats.length + newMatCats.length} new categories will be created first`);
    console.log('\nRun with --probe to test one item, or --execute to apply all.');
    return;
  }

  // ── PROBE / EXECUTE: create categories first, then compute diff by UUID ───

  // Ensure all CSV categories exist in HCP (creates missing ones)
  const svcCatMap = new Map(existingSvcCatMap);
  const matCatMap = new Map(existingMatCatMap);
  for (const cat of new Set(serviceRows.map(r => r.category))) {
    await ensureServiceCategory(cat, svcCatMap, electricalUuid);
  }
  for (const cat of new Set(materialRows.map(r => r.category))) {
    await ensureMaterialCategory(cat, matCatMap);
  }

  // Also fetch from any newly created categories (they'll be empty but need to be in svcCatMap)
  // Items are still in old categories — liveServices already has them all from the initial fetch above.

  // ── Compute diff by UUID ───────────────────────────────────────────────────
  const svcChanges: Array<{ uuid: string; name: string; categoryUuid: string; oldName: string; oldCatName: string }> = [];
  const matChanges: Array<{ uuid: string; name: string; categoryUuid: string; oldName: string; oldCatName: string }> = [];

  for (const row of serviceRows) {
    const live          = liveServices.get(row.uuid);
    const targetCatUuid = svcCatMap.get(row.category);
    if (!targetCatUuid) { console.warn(`  ⚠ No UUID for service category "${row.category}" — skipping`); continue; }
    if (!live) { console.warn(`  ⚠ ${row.uuid} not found in live HCP — skipping`); continue; }
    if (live.name !== row.name || live.categoryUuid !== targetCatUuid) {
      svcChanges.push({ uuid: row.uuid, name: row.name, categoryUuid: targetCatUuid, oldName: live.name, oldCatName: svcCatUuidToName.get(live.categoryUuid) ?? live.categoryUuid });
    }
  }

  for (const row of materialRows) {
    const live          = liveMaterials.get(row.uuid);
    const targetCatUuid = matCatMap.get(row.category);
    if (!targetCatUuid) { console.warn(`  ⚠ No UUID for material category "${row.category}" — skipping`); continue; }
    if (!live) { console.warn(`  ⚠ ${row.uuid} not found in live HCP — skipping`); continue; }
    if (live.name !== row.name || live.categoryUuid !== targetCatUuid) {
      matChanges.push({ uuid: row.uuid, name: row.name, categoryUuid: targetCatUuid, oldName: live.name, oldCatName: matCatUuidToName.get(live.categoryUuid) ?? live.categoryUuid });
    }
  }

  console.log(`\n── Changes: ${svcChanges.length} services, ${matChanges.length} materials ──`);

  // ── PROBE: test one PATCH, then stop ──────────────────────────────────────
  if (PROBE) {
    const first = svcChanges[0] ?? matChanges[0];
    if (!first) { console.log('Nothing to update.'); return; }
    const isService = first.uuid.startsWith('olit_');
    const endpoint  = isService ? `/alpha/pricebook/services/${first.uuid}` : `/alpha/pricebook/materials/${first.uuid}`;
    const body = isService
      ? { name: first.name, pricebook_category_uuid: first.categoryUuid }
      : { name: first.name, material_category_uuid: first.categoryUuid };
    console.log(`\n  Item:    "${first.oldName}" → "${first.name}"`);
    console.log(`  Cat:     "${first.oldCatName}" → target UUID ${first.categoryUuid}`);
    console.log(`  PATCH ${endpoint}`);
    const res = await hcpPatch<{ uuid: string; name: string }>(endpoint, body);
    console.log(`\n  ✅ Response: uuid=${res?.uuid}, name="${res?.name}"`);
    console.log('\nProbe succeeded — run --execute to apply all changes.');
    return;
  }

  // ── EXECUTE: apply all PATCHes ────────────────────────────────────────────
  let ok = 0, fail = 0;
  for (const c of svcChanges) {
    try {
      await hcpPatch(`/alpha/pricebook/services/${c.uuid}`, { name: c.name, pricebook_category_uuid: c.categoryUuid });
      process.stdout.write('.');
      ok++;
    } catch (e) {
      fail++;
      console.error(`\n  FAIL ${c.uuid}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  for (const c of matChanges) {
    try {
      await hcpPatch(`/alpha/pricebook/materials/${c.uuid}`, { name: c.name, material_category_uuid: c.categoryUuid });
      process.stdout.write('.');
      ok++;
    } catch (e) {
      fail++;
      console.error(`\n  FAIL ${c.uuid}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  console.log(`\n\nDone. ${ok} updated, ${fail} failed.`);
  if (fail === 0) console.log('HCP pricebook is now in sync with data/pricebook.csv.');
}

run().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
