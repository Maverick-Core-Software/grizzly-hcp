/**
 * One-shot: clean up GFCI items, replace aluminum wiring item with 3 tiered items,
 * replace device box item with 3 tiered items, and update energy monitor price.
 * Run with --execute to apply.
 */
import 'dotenv/config';
import { hcpGet, hcpPatch } from './client.js';
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

async function patchItem(uuid: string, fields: Record<string, unknown>, label: string) {
  console.log(`  [PATCH]  "${label}" — ${JSON.stringify(fields)}`);
  if (!DRY_RUN) {
    await hcpPatch(`/alpha/pricebook/services/${uuid}`, fields);
    console.log(`           → updated`);
  }
}

// ── GFCI ──────────────────────────────────────────────────────────────────────

const GFCI_UPDATES = [
  {
    uuid: 'olit_fd1fc130aaac41bcaa43300d018aa5ce',
    label: 'Replace GFCI Receptacle → $99',
    fields: {
      name: 'Replace GFCI Receptacle',
      description: 'Remove non-working GFCI and install new GFCI receptacle in same location. Includes testing for correct operation after install.',
      price: 9900,
    },
  },
  {
    uuid: 'olit_db146e0950b94365a8b54a7d63837dff',
    label: 'Install GFCI → Replace Standard Receptacle with GFCI @ $149',
    fields: {
      name: 'Replace Standard Receptacle with GFCI',
      description: 'Remove existing standard duplex receptacle and install new GFCI receptacle in same location. Provides ground fault protection for moisture-prone areas. Includes testing for correct operation after install.',
      price: 14900,
    },
  },
];

const GFCI_DELETE = { uuid: 'olit_257dbe3c42c34b44a641706fb36c98bc', label: 'Install GFCI ($56 — vague duplicate)' };

// ── Aluminum Wiring ───────────────────────────────────────────────────────────

const AL_DELETE = { uuid: 'olit_66829cdb648843dbadab858fd15cb8fe', label: 'Remove Aluminum Wiring (unpriced)' };

const AL_DESC = (range: string) =>
  `Remove existing aluminum wiring at each device location (${range} devices, closed wall). Disconnect aluminum conductors at device box, install copper-to-aluminum connections (Alumiconn or equivalent) and copper pigtails, and remove aluminum back to next accessible joint. Reinstall device. Price is per device — enter device count as quantity.`;

const AL_ITEMS = [
  { name: 'Remove Aluminum Wiring (1-10 Devices)',  description: AL_DESC('1-10'),  unitPrice: 99 },
  { name: 'Remove Aluminum Wiring (11-20 Devices)', description: AL_DESC('11-20'), unitPrice: 79 },
  { name: 'Remove Aluminum Wiring (21+ Devices)',   description: AL_DESC('21+'),   unitPrice: 69 },
];

// ── Device Box ────────────────────────────────────────────────────────────────

const BOX_DELETE = { uuid: 'olit_94d223ac282a4dceaa4f795fec47f29a', label: 'Replace Device box (unpriced)' };

const BOX_DESC = (range: string) =>
  `Remove existing device and cover plate. Remove old device box from wall and install new device box at same location (${range} boxes, closed wall). Reinstall device and cover plate. Check for correct operation after install. Price is per box — enter box count as quantity.`;

const BOX_ITEMS = [
  { name: 'Replace Device Box (1-10 Boxes)',  description: BOX_DESC('1-10'),  unitPrice: 39 },
  { name: 'Replace Device Box (11-20 Boxes)', description: BOX_DESC('11-20'), unitPrice: 36 },
  { name: 'Replace Device Box (21+ Boxes)',   description: BOX_DESC('21+'),   unitPrice: 31 },
];

// ── Energy Monitor ─────────────────────────────────────────────────────────────

const ENERGY_UPDATE = {
  uuid: 'olit_364340e5192843308f03e412652b079c',
  label: 'Whole Home Energy Monitor → $599',
  fields: { price: 59900 },
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nSwitches/Devices Cleanup — ${DRY_RUN ? 'DRY RUN (pass --execute to apply)' : 'EXECUTE'}\n`);

  const categoryUuid = DRY_RUN ? '(skipped)' : await getCategoryUuid('Switches, Outlets & Devices');

  // GFCI
  console.log('── GFCI ──');
  for (const { uuid, label, fields } of GFCI_UPDATES) await patchItem(uuid, fields, label);
  console.log(`  [DELETE] "${GFCI_DELETE.label}"`);
  if (!DRY_RUN) await deletePriceBookItem(GFCI_DELETE.uuid);

  // Aluminum Wiring
  console.log('\n── Aluminum Wiring ──');
  console.log(`  [DELETE] "${AL_DELETE.label}"`);
  if (!DRY_RUN) await deletePriceBookItem(AL_DELETE.uuid);
  for (const item of AL_ITEMS) {
    console.log(`  [CREATE] "${item.name}" — $${item.unitPrice}/device`);
    if (!DRY_RUN) {
      const created = await createPriceBookItem({ ...item, unitOfMeasure: 'Each', category: 'Switches, Outlets & Devices', categoryUuid });
      console.log(`           → ${created.uuid}`);
    }
  }

  // Device Box
  console.log('\n── Device Box ──');
  console.log(`  [DELETE] "${BOX_DELETE.label}"`);
  if (!DRY_RUN) await deletePriceBookItem(BOX_DELETE.uuid);
  for (const item of BOX_ITEMS) {
    console.log(`  [CREATE] "${item.name}" — $${item.unitPrice}/box`);
    if (!DRY_RUN) {
      const created = await createPriceBookItem({ ...item, unitOfMeasure: 'Each', category: 'Switches, Outlets & Devices', categoryUuid });
      console.log(`           → ${created.uuid}`);
    }
  }

  // Energy Monitor
  console.log('\n── Energy Monitor ──');
  await patchItem(ENERGY_UPDATE.uuid, ENERGY_UPDATE.fields, ENERGY_UPDATE.label);

  console.log(`\n${DRY_RUN ? 'Dry run complete. Run with --execute to apply.' : 'Done.\nRun: npm run export-pricebook && npm run push-pricebook'}`);
}

run().catch(e => { console.error(e); process.exit(1); });
