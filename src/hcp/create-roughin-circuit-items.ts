/**
 * One-shot: create 10 standardized rough-in circuit items in Remodel — Rough-In.
 * All flat-rate (Each). Run with --execute to apply.
 */
import 'dotenv/config';
import { hcpGet } from './client.js';
import { createPriceBookItem } from './price-book.js';

const DRY_RUN = !process.argv.includes('--execute');

async function getCategoryUuid(name: string): Promise<string> {
  const industries = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    '/alpha/pricebook/industries'
  );
  const electrical = (industries.data ?? []).find(i => i.name.toLowerCase().includes('electrical'));
  if (!electrical) throw new Error('Electrical industry not found');

  const res = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    `/alpha/pricebook/categories?pricebook_industry_uuid=${electrical.uuid}&page=1&page_size=100&sort_column=order_index&sort_direction=asc`
  );
  const cat = (res.data ?? []).find(c => c.name === name);
  if (!cat) throw new Error(`Category not found: "${name}"`);
  return cat.uuid;
}

const CATEGORY = 'Remodel — Rough-In';

const s = (amp: string, pole: string, voltage: string, range: string): string =>
  `Install new ${amp} ${pole} ${voltage} circuit. Price is based on wire length — routed through open wall cavities during rough-in (${range} of wire). Includes breaker, wire, box, and labor to run and terminate at load.`;

const NEW_ITEMS: Array<{ name: string; description: string; unitPrice: number }> = [
  // ── Short runs ────────────────────────────────────────────────────────────────
  { name: "Install New 15/20A 120V Circuit (Rough-In, 0'–150')",    description: s('15A or 20A', 'single-pole', '120V',       "up to 150'"),  unitPrice: 329 },
  { name: "Install New 15/20A 240V Circuit (Rough-In, 0'–150')",    description: s('15A or 20A', 'double-pole', '240V',       "up to 150'"),  unitPrice: 349 },
  { name: "Install New 30A 120V/240V Circuit (Rough-In, 0'–150')",  description: s('30A', 'single or double-pole', '120V/240V', "up to 150'"), unitPrice: 379 },
  { name: "Install New 40A 240V Circuit (Rough-In, 0'–100')",       description: s('40A', 'double-pole', '240V',              "up to 100'"),  unitPrice: 409 },
  { name: "Install New 50A/60A 240V Circuit (Rough-In, 0'–100')",   description: s('50A or 60A', 'double-pole', '240V',       "up to 100'"),  unitPrice: 439 },
  // ── Long runs ─────────────────────────────────────────────────────────────────
  { name: "Install New 15/20A 120V Circuit (Rough-In, 151'–250')",  description: s('15A or 20A', 'single-pole', '120V',       "151'–250'"),   unitPrice: 509 },
  { name: "Install New 15/20A 240V Circuit (Rough-In, 151'–250')",  description: s('15A or 20A', 'double-pole', '240V',       "151'–250'"),   unitPrice: 529 },
  { name: "Install New 30A 120V/240V Circuit (Rough-In, 151'–250')", description: s('30A', 'single or double-pole', '120V/240V', "151'–250'"), unitPrice: 559 },
  { name: "Install New 40A 240V Circuit (Rough-In, 101'–200')",     description: s('40A', 'double-pole', '240V',              "101'–200'"),   unitPrice: 589 },
  { name: "Install New 50A/60A 240V Circuit (Rough-In, 101'–200')", description: s('50A or 60A', 'double-pole', '240V',       "101'–200'"),   unitPrice: 619 },
];

async function run() {
  console.log(`\nRough-In Circuit Items — ${DRY_RUN ? 'DRY RUN (pass --execute to apply)' : 'EXECUTE'}\n`);

  const categoryUuid = DRY_RUN ? '(skipped)' : await getCategoryUuid(CATEGORY);
  if (!DRY_RUN) console.log(`${CATEGORY} → ${categoryUuid}\n`);

  for (const item of NEW_ITEMS) {
    console.log(`  [CREATE] "${item.name}" — $${item.unitPrice}`);
    if (!DRY_RUN) {
      const created = await createPriceBookItem({
        ...item,
        unitOfMeasure: 'Each',
        category: CATEGORY,
        categoryUuid,
      });
      console.log(`           → ${created.uuid}`);
    }
  }

  console.log(`\n${DRY_RUN
    ? 'Dry run complete. Run with --execute to apply.'
    : `Done. ${NEW_ITEMS.length} created.\nRun: npm run export-pricebook && npm run push-pricebook`
  }`);
}

run().catch(e => { console.error(e); process.exit(1); });
