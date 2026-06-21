/**
 * CLI: npm run estimate <path-to-proposal.pdf|.docx> [--dry-run] [--template <eot_uuid>] [--takeoff <blueprint.dwg|.dxf|.pdf>]
 *
 * Pipeline:
 *   0. (Optional) Blueprint takeoff: parse DWG/DXF/PDF → extract device counts, routing lengths
 *      Output is appended to the scope text before proposal parsing
 *   1. Extract raw text from PDF or DOCX
 *   2. Claude parses text → structured ProposalData
 *   3. Match line items against local price book
 *   4. Look up customer in HCP
 *   5. Create estimate via HCP API (no Playwright)
 *   6. Apply template (if --template or job type matched)
 *   7. Add all line items
 *   8. Set deposit if total > $5,000
 */
import 'dotenv/config';
import path from 'path';
import { extractText } from '../../parsers/extract-text.js';
import { parseProposal } from '../../parsers/parse-proposal.js';
import { matchLineItems } from '../../rag/price-book.js';
import {
  searchCustomer,
  createEstimate,
  applyTemplate,
  addLineItem,
  setDeposit,
  listTemplates,
  type HcpLineItem,
} from '../../hcp/estimates.js';
import { createPriceBookItem } from '../../hcp/price-book.js';
import { runTakeoff } from '../../takeoff/index.js';
import type { TakeoffResult } from '../../takeoff/types.js';

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath    = args.find(a => !a.startsWith('--'));
const dryRun      = args.includes('--dry-run');
const tplIdx      = args.indexOf('--template');
const templateArg = tplIdx !== -1 ? args[tplIdx + 1] : undefined;
const takeoffIdx  = args.indexOf('--takeoff');
const takeoffFile = takeoffIdx !== -1 ? args[takeoffIdx + 1] : undefined;

if (!filePath) {
  console.error('Usage: npm run estimate <file.pdf|.docx> [--dry-run] [--template <eot_uuid>] [--takeoff <blueprint.dwg|.dxf|.pdf>]');
  process.exit(1);
}

const resolvedPath = path.resolve(filePath);

console.log('\n=== Grizzly HCP — Estimate from Proposal ===');
console.log(`File: ${resolvedPath}`);
if (dryRun) console.log('Mode: DRY RUN (no HCP changes)\n');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map proposal line item kind based on description / price book category. */
function itemKind(description: string, category: string): HcpLineItem['kind'] {
  const d = description.toLowerCase();
  const c = category.toLowerCase();
  if (d.includes('discount') || c.includes('discount')) return 'fixed discount';
  if (c.includes('material') || d.includes('material') || d.includes('wire') ||
      d.includes('conduit') || d.includes('panel') || d.includes('breaker') ||
      d.includes('box') || d.includes('device') || d.includes('fixture')) {
    return 'materials';
  }
  return 'labor';
}

/** Format TakeoffResult as a markdown block to prepend to proposal scope text. */
function formatTakeoffContext(takeoff: TakeoffResult): string {
  const deviceLines = Object.entries(takeoff.devices)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `- ${type}: ${count}`)
    .join('\n');

  const routingLines = Object.entries(takeoff.estimated_routing_lengths.by_type)
    .filter(([, r]) => r.nominal_ft > 0)
    .map(([type, r]) => `- ${type}: ~${Math.round(r.nominal_ft)} ft (${Math.round(r.min_ft)}–${Math.round(r.max_ft)} ft range)`)
    .join('\n');

  const panelLines = takeoff.panels.length > 0
    ? takeoff.panels.map(p => `- Panel ${p.panelId}: ${p.circuits.length} circuits${p.amperage ? `, ${p.amperage}A` : ''}`).join('\n')
    : '- None detected';

  return [
    '## Blueprint Takeoff Data',
    '(Extracted from attached blueprint — verify before use)',
    '',
    '### Device Counts',
    deviceLines || '(none detected)',
    '',
    '### Estimated Wire Routing Lengths',
    routingLines || '(scale unknown or no DXF geometry)',
    `Note: ${takeoff.estimated_routing_lengths.note}`,
    '',
    '### Panel Schedules',
    panelLines,
    '',
    `### Labor Estimate`,
    `- Rough-in: ${takeoff.labor.rough_in_hours.toFixed(1)} hrs`,
    `- Trim-out: ${takeoff.labor.trim_out_hours.toFixed(1)} hrs`,
    `- Panel work: ${takeoff.labor.panel_hours.toFixed(1)} hrs`,
    `- Total: ${takeoff.labor.total_hours.toFixed(1)} hrs`,
    '',
    `Confidence: devices=${takeoff.confidence.device_counts}, routing=${takeoff.confidence.routing_lengths}`,
    `Warnings: ${takeoff.warnings.length > 0 ? takeoff.warnings.map(w => w.message).join('; ') : 'none'}`,
    '',
  ].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  // Step 0 (optional): Blueprint takeoff
  let takeoffContext = '';
  if (takeoffFile) {
    const resolvedTakeoff = path.resolve(takeoffFile);
    console.log('\nStep 0 — Running blueprint takeoff...');
    console.log(`  File: ${resolvedTakeoff}`);
    const takeoff = await runTakeoff(resolvedTakeoff);
    takeoffContext = formatTakeoffContext(takeoff);
    console.log(`  Takeoff complete: ${Object.values(takeoff.devices).reduce((a, b) => a + b, 0)} devices detected`);
    console.log(`  Confidence: devices=${takeoff.confidence.device_counts}, routing=${takeoff.confidence.routing_lengths}`);
    if (takeoff.warnings.length > 0) {
      console.log(`  Warnings: ${takeoff.warnings.map(w => w.message).join('; ')}`);
    }
    console.log('\n  ⚠ REVIEW REQUIRED — Verify takeoff data before accepting into estimate.');
    console.log('  Press Enter to continue or Ctrl+C to abort...');
    await new Promise<void>(resolve => {
      process.stdin.setRawMode?.(false);
      process.stdin.resume();
      process.stdin.once('data', () => {
        process.stdin.pause();
        resolve();
      });
    });
  }

  // Step 1: Extract text
  console.log('Step 1/4 — Extracting text from document...');
  const rawText = await extractText(resolvedPath);
  console.log(`  ${rawText.length} characters extracted.`);

  // Step 2: Parse with Claude
  console.log('\nStep 2/4 — Parsing proposal with Claude...');
  // Augment raw text with takeoff data if available
  const augmentedText = takeoffContext ? `${rawText}\n\n${takeoffContext}` : rawText;
  const proposal = await parseProposal(augmentedText);
  const total = proposal.lineItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  console.log(`  Customer:   ${proposal.customer.name} — ${proposal.customer.address}`);
  console.log(`  Job type:   ${proposal.jobType ?? '(none)'}`);
  console.log(`  Line items: ${proposal.lineItems.length}`);
  console.log(`  Total:      $${total.toFixed(2)}`);

  // If no line items have prices but a Better total exists, collapse to one summary item
  const allPricesNull = proposal.lineItems.every(i => !i.unitPrice);
  if (allPricesNull && proposal.betterTotal) {
    console.log(`\n  No per-item prices found. Collapsing to single line item at Better total ($${proposal.betterTotal.toLocaleString()}).`);
    proposal.lineItems = [{
      description: proposal.scopeOfWork || proposal.jobType || 'Labor & Materials',
      quantity: 1,
      unitPrice: proposal.betterTotal,
      unit: 'each',
    }];
  }

  // Step 3: Match line items against price book
  console.log('\nStep 3/4 — Matching against price book...');
  const matched = await matchLineItems(proposal.lineItems);

  for (const m of matched) {
    if (m.match) {
      console.log(`  [MATCH ${Math.round(m.match.score * 100)}%] "${m.description}" → "${m.match.item.name}" (${m.match.item.uuid})`);
    } else {
      console.log(`  [CUSTOM]  "${m.description}" @ $${m.unitPrice}`);
    }
  }

  const fromPB = matched.filter(m => m.match).length;
  console.log(`\n  ${fromPB}/${matched.length} items matched in price book`);

  if (dryRun) {
    console.log('\n[DRY RUN] Stopping here — no HCP changes made.');
    console.log('\nLine items that would be created:');
    matched.forEach((m, i) => {
      const label = m.match ? `PB → ${m.match.item.name}` : 'CUSTOM';
      console.log(`  ${i + 1}. [${label}] ${m.description} — qty ${m.quantity} @ $${m.unitPrice}`);
    });
    if (total > 5000) {
      console.log(`\nDeposit: 50% ($${(total * 0.5).toFixed(2)}) would be set.`);
    }
    return;
  }

  // Step 4: Create in HCP
  console.log('\nStep 4/4 — Creating estimate in HCP via API...');

  // 4a. Find customer
  console.log(`  Looking up customer: ${proposal.customer.name}...`);
  const customer = await searchCustomer(proposal.customer.name);
  if (!customer) {
    throw new Error(
      `Customer "${proposal.customer.name}" not found in HCP. ` +
      'Create them in HCP first, then re-run.'
    );
  }
  console.log(`  Found: ${customer.name} (id=${customer.id}, addr=${customer.addressId})`);

  // 4b. Create estimate
  const estimate = await createEstimate(customer.id, customer.addressId);
  console.log(`  Estimate created: ${estimate.uuid}`);

  // 4c. Optionally apply template
  const templateUuid = templateArg;
  if (templateUuid) {
    console.log(`  Applying template: ${templateUuid}...`);
    await applyTemplate(estimate.uuid, templateUuid);
    console.log('  Template applied.');
  } else if (proposal.jobType) {
    // Try to auto-match by job type name
    const templates = await listTemplates();
    const jt = proposal.jobType.toLowerCase();
    const tmatch = templates.find(t => t.name.toLowerCase().includes(jt) || jt.includes(t.name.toLowerCase()));
    if (tmatch) {
      console.log(`  Auto-matched template: "${tmatch.name}" (${tmatch.uuid})`);
      await applyTemplate(estimate.uuid, tmatch.uuid);
    }
  }

  // 4d. Add line items
  console.log(`\n  Adding ${matched.length} line items...`);
  for (let i = 0; i < matched.length; i++) {
    const m = matched[i];
    const pb = m.match?.item;
    const category = pb?.category ?? '';

    const item: HcpLineItem = {
      name:         pb?.name ?? m.description,
      description:  pb ? m.description : undefined,
      unitPrice:    (pb && pb.price > 0) ? pb.price : (m.unitPrice ?? 0),
      quantity:     m.quantity,
      kind:         itemKind(m.description, category),
      taxable:      false,
      serviceItemId: pb?.uuid,
      orderIndex:   i,
    };

    const created = await addLineItem(estimate.uuid, item, i);
    let label = pb ? `PB: ${pb.name}` : 'custom';

    // Auto-save new custom items to the HCP price book
    if (!pb && m.unitPrice) {
      try {
        const saved = await createPriceBookItem({
          name:      m.description,
          unitPrice: m.unitPrice,
          kind:      itemKind(m.description, '') === 'materials' ? 'materials' : 'labor',
        });
        label = `custom → saved to PB (${saved.uuid})`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        label = `custom (PB save failed: ${msg.slice(0, 60)})`;
      }
    }

    console.log(`  [${i + 1}/${matched.length}] Added "${created.name}" (${label}, qty=${m.quantity})`);
  }

  // 4e. Set deposit for jobs over $5,000
  if (total >= 5000) {
    const depositAmount = total * 0.5;
    console.log('\n  Setting 50% deposit...');
    await setDeposit(estimate.uuid, depositAmount, 'percent');
    console.log(`  Deposit set: $${depositAmount.toFixed(2)}`);
  }

  const url = `https://pro.housecallpro.com/app/estimates/${estimate.uuid}`;
  console.log(`\nDone! Estimate URL:\n  ${url}`);

  // QR code — scan with phone to open in HCP app
  const qr = await import('qrcode-terminal');
  console.log('\nScan to open on your phone:');
  qr.default.generate(url, { small: true });
}

run().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
