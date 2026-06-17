/**
 * CLI: tsx src/automations/estimates/from-proposal.ts <path-to-proposal.pdf|.docx> [--dry-run]
 *
 * Pipeline:
 *   1. Extract raw text from PDF or DOCX
 *   2. Claude parses text → structured ProposalData
 *   3. Playwright fills HCP new estimate form
 */
import 'dotenv/config';
import path from 'path';
import { extractText } from '../../parsers/extract-text.js';
import { parseProposal } from '../../parsers/parse-proposal.js';
import { createEstimate } from './create-estimate.js';
import { closeBrowser } from '../../browser.js';

const [, , filePath, flag] = process.argv;
const dryRun = flag === '--dry-run';

if (!filePath) {
  console.error('Usage: tsx src/automations/estimates/from-proposal.ts <file.pdf|.docx> [--dry-run]');
  process.exit(1);
}

const resolvedPath = path.resolve(filePath);

console.log(`\n=== Grizzly HCP — Estimate from Proposal ===`);
console.log(`File: ${resolvedPath}`);
if (dryRun) console.log('Mode: DRY RUN (no changes will be made to HCP)\n');

async function run() {
  // Step 1: Extract text
  console.log('Step 1/3 — Extracting text from document...');
  const rawText = await extractText(resolvedPath);
  console.log(`  Extracted ${rawText.length} characters.`);

  // Step 2: Parse with Claude
  console.log('\nStep 2/3 — Parsing proposal data with Claude...');
  const proposal = await parseProposal(rawText);
  console.log('  Parsed:');
  console.log(`    Customer:   ${proposal.customer.name} — ${proposal.customer.address}`);
  console.log(`    Job type:   ${proposal.jobType ?? '(none)'}`);
  console.log(`    Line items: ${proposal.lineItems.length}`);
  const total = proposal.lineItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  console.log(`    Total:      $${total.toFixed(2)}`);

  // Step 3: Create in HCP
  console.log('\nStep 3/3 — Creating estimate in Housecall Pro...');
  const url = await createEstimate(proposal, dryRun);

  if (url) {
    console.log(`\nDone! Estimate URL: ${url}`);
  } else if (dryRun) {
    console.log('\nDry run complete — no changes made.');
  }
}

run().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
}).finally(closeBrowser);
