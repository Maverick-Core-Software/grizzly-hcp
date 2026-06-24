/**
 * One-shot: create 10 standardized circuit items + delete 4 legacy duplicates.
 *
 * Default: dry-run (prints what would happen).
 * Pass --execute to apply.
 *
 * Run:
 *   npx tsx src/hcp/create-circuit-items.ts           (dry-run)
 *   npx tsx src/hcp/create-circuit-items.ts --execute (apply)
 */
import 'dotenv/config';
import { hcpGet } from './client.js';
import { createPriceBookItem, deletePriceBookItem } from './price-book.js';

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

// ─── Item definitions ─────────────────────────────────────────────────────────

const CATEGORY = 'New Circuit Wiring/Conduit';

const s = (amp: string, pole: string, voltage: string, maxFt: string, extras: string): string =>
  `Install new ${amp} ${pole} ${voltage} circuit. Price is based on wire length — routed from panel, through accessible attic, and down interior wall to desired location (up to ${maxFt} of wire). Includes breaker, wire, box, ${extras}, and labor to run new circuit and terminate at load.`;

const l = (amp: string, pole: string, voltage: string, range: string, extras: string): string =>
  `Install new ${amp} ${pole} ${voltage} circuit. Priced per foot of wire — routed from panel, through accessible attic, and down interior wall to desired location. Enter total wire footage as quantity (${range} range). Includes breaker, wire, box, ${extras}, and labor to run new circuit and terminate at load.`;

const NEW_ITEMS: Array<{ name: string; description: string; unitPrice: number; unitOfMeasure: string }> = [
  // ── Short runs (flat price, unit: Each) ──────────────────────────────────────
  {
    name:        "Install New 15/20A 120V Circuit (Attic Access, 0'–50')",
    description: s('15A or 20A', 'single-pole', '120V', "50'", 'duplex receptacle'),
    unitPrice:   397,
    unitOfMeasure: 'Each',
  },
  {
    name:        "Install New 15/20A 240V Circuit (Attic Access, 0'–50')",
    description: s('15A or 20A', 'double-pole', '240V', "50'", 'receptacle or termination point'),
    unitPrice:   429,
    unitOfMeasure: 'Each',
  },
  {
    name:        "Install New 30A 120V/240V Circuit (Attic Access, 0'–50')",
    description: s('30A', 'single or double-pole', '120V/240V', "50'", 'receptacle or termination point'),
    unitPrice:   469,
    unitOfMeasure: 'Each',
  },
  {
    name:        "Install New 40A 240V Circuit (Attic Access, 0'–25')",
    description: s('40A', 'double-pole', '240V', "25'", 'receptacle or termination point'),
    unitPrice:   499,
    unitOfMeasure: 'Each',
  },
  {
    name:        "Install New 50A/60A 240V Circuit (Attic Access, 0'–25')",
    description: s('50A or 60A', 'double-pole', '240V', "25'", 'receptacle or termination point'),
    unitPrice:   599,
    unitOfMeasure: 'Each',
  },
  // ── Long runs (per-foot price, unit: Per Foot — enter footage as qty) ────────
  {
    name:        "Install New 15/20A 120V Circuit (Attic Access, 51'–150')",
    description: l('15A or 20A', 'single-pole', '120V', "51'–150'", 'duplex receptacle'),
    unitPrice:   6.99,
    unitOfMeasure: 'Per Foot',
  },
  {
    name:        "Install New 15/20A 240V Circuit (Attic Access, 51'–150')",
    description: l('15A or 20A', 'double-pole', '240V', "51'–150'", 'receptacle or termination point'),
    unitPrice:   7.19,
    unitOfMeasure: 'Per Foot',
  },
  {
    name:        "Install New 30A 120V/240V Circuit (Attic Access, 51'–150')",
    description: l('30A', 'single or double-pole', '120V/240V', "51'–150'", 'receptacle or termination point'),
    unitPrice:   9.18,
    unitOfMeasure: 'Per Foot',
  },
  {
    name:        "Install New 40A 240V Circuit (Attic Access, 26'–100')",
    description: l('40A', 'double-pole', '240V', "26'–100'", 'receptacle or termination point'),
    unitPrice:   9.78,
    unitOfMeasure: 'Per Foot',
  },
  {
    name:        "Install New 50A/60A 240V Circuit (Attic Access, 26'–100')",
    description: l('50A or 60A', 'double-pole', '240V', "26'–100'", 'receptacle or termination point'),
    unitPrice:   11.78,
    unitOfMeasure: 'Per Foot',
  },
];

const DELETE_UUIDS: Array<{ uuid: string; label: string }> = [
  { uuid: 'olit_46e2218fd7fe4c19a566769058601e94', label: "Install New 15/20a Circuit (Up To 50')" },
  { uuid: 'olit_e1f5d86485c247d5acac583eca86d5ee', label: "15/20a Home Runs (Up To 150')" },
  { uuid: 'olit_47a989535b5d4c37b4d59b75ceee3ad3', label: "Install New 220v 30a Circuit (Up To 10')" },
  { uuid: 'olit_e223ca3cf26e45c68c86e5e3826e8d83', label: "Install New 220v 50a Circuit (Next To Panel)" },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const mode = DRY_RUN ? 'DRY RUN (pass --execute to apply)' : 'EXECUTE MODE';
  console.log(`\nCircuit Items Batch — ${mode}\n`);

  console.log('Fetching category UUID...');
  const categoryUuid = DRY_RUN ? '(skipped in dry-run)' : await getCategoryUuid(CATEGORY);
  if (!DRY_RUN) console.log(`  ${CATEGORY} → ${categoryUuid}\n`);

  // ── Creates ──────────────────────────────────────────────────────────────────
  console.log(`Creating ${NEW_ITEMS.length} new items:`);
  for (const item of NEW_ITEMS) {
    console.log(`  [CREATE] "${item.name}" — $${item.unitPrice.toFixed(2)} / ${item.unitOfMeasure}`);
    if (!DRY_RUN) {
      const created = await createPriceBookItem({
        ...item,
        category: CATEGORY,
        categoryUuid,
      });
      console.log(`           → ${created.uuid}`);
    }
  }

  // ── Deletes ──────────────────────────────────────────────────────────────────
  console.log(`\nDeleting ${DELETE_UUIDS.length} legacy items:`);
  for (const { uuid, label } of DELETE_UUIDS) {
    console.log(`  [DELETE] ${uuid}  "${label}"`);
    if (!DRY_RUN) {
      await deletePriceBookItem(uuid);
      console.log(`           → deleted`);
    }
  }

  console.log(`\n${ DRY_RUN
    ? 'Dry run complete. Run with --execute to apply.'
    : `Done. ${NEW_ITEMS.length} created, ${DELETE_UUIDS.length} deleted.\nRun: npm run export-pricebook && npm run push-pricebook`
  }`);
}

run().catch(e => { console.error(e); process.exit(1); });
