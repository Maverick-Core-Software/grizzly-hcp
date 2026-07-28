/**
 * Weekly HCP catalog sync — the AIWA entry point.
 *
 * Exports the price book, the customer list and the estimates from HCP, then
 * publishes all three CSVs into the RAG ingest directory in a single run.
 *
 * This job is local-target only: it runs on the same host as the RAG and Qdrant,
 * so publishing is a file copy plus a direct HTTP call. It has no remote-copy
 * path and must never grow one.
 *
 * Run: npm run sync-catalog        (local dev)
 *      node dist/sync-catalog.mjs  (AIWA, via the systemd timer)
 */
import 'dotenv/config';
import { runPricebookExport } from './export-pricebook.js';
import { runCustomersExport } from './export-customers.js';
import { runEstimatesExport } from './export-estimates.js';
import { deletePointsByType, publishCsv, resolveRagConfig } from './rag-publish.js';
import { checkHcpAuth } from './preflight-auth.js';

/** Distinctive marker the Hermes monitor greps the journal for. */
const AUTH_FAIL_MARKER = 'HCP_AUTH_PREFLIGHT_FAIL';

/** Destination names in the ingest directory. The ingest keys off these. */
const DEST_PRICEBOOK = 'pricebook.csv';
const DEST_CUSTOMERS = 'customers.csv';
const DEST_ESTIMATES = 'estimates.csv';

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
  error?: string;
}

/** True when the failure looks like an expired HCP browser session. */
function isAuthFailure(message: string): boolean {
  return /\b401\b|\b403\b|unauthor|forbidden|session|cookie|log ?in/i.test(message);
}

/**
 * Run one export/publish half, capturing any failure instead of throwing so the
 * remaining halves still run.
 */
async function step(name: string, fn: () => Promise<string>): Promise<StepResult> {
  console.log(`\n── ${name} ─────────────────────────────────────────────`);
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // stdout, not stderr, so the run trace stays in order in the journal
    console.log(`  ${name} FAILED: ${message}`);
    return { name, ok: false, detail: '', error: message };
  }
}

async function run() {
  const cfg = resolveRagConfig();

  if (cfg.target !== 'local') {
    console.error(
      `sync-catalog is local-target only, but RAG_TARGET resolved to "${cfg.target}".\n` +
      'This job runs on the same host as the RAG and must publish locally.\n' +
      'Set RAG_TARGET=local and re-run.',
    );
    process.exit(1);
  }

  // Preflight: verify the HCP session before any export work.
  // ponytail: process.exitCode + return, not process.exit(1) — a forced exit
  // after fetch trips libuv's UV_HANDLE_CLOSING assertion on Windows and can
  // return the NT status instead of 1. Natural drain preserves the exit code.
  const auth = await checkHcpAuth();
  if (!auth.ok) {
    console.error('HCP auth preflight failed — not running any export.');
    console.error(`${AUTH_FAIL_MARKER} ${auth.detail}`);
    process.exitCode = 1;
    return;
  }

  console.log('HCP catalog sync');
  console.log(`  Ingest directory: ${cfg.ingestDir}`);
  console.log(`  Qdrant:           ${cfg.qdrantUrl} (collection "${cfg.collection}")`);
  console.log(`  Session:          ok via ${auth.via}`);

  const results: StepResult[] = [];

  // 1. Price book — upsert only, no deletes.
  results.push(await step('Price book', async () => {
    const r = await runPricebookExport();
    await publishCsv(cfg, r.csvPath, DEST_PRICEBOOK);
    return `${r.rowCount} rows (${r.serviceCount} services + ${r.materialCount} materials) → ${DEST_PRICEBOOK}`;
  }));

  // 2. Customers — upsert only, no deletes.
  results.push(await step('Customers', async () => {
    const r = await runCustomersExport();
    await publishCsv(cfg, r.csvPath, DEST_CUSTOMERS);
    return `${r.customerCount} customers → ${DEST_CUSTOMERS}`;
  }));

  // 3. Estimates — replace rather than accumulate, so stale options do not
  //    linger. Only type "estimate" is cleared; type "job" belongs to the
  //    separate jobs sync and must never be touched here.
  results.push(await step('Estimates', async () => {
    const r = await runEstimatesExport();
    await deletePointsByType(cfg, 'estimate');
    await publishCsv(cfg, r.csvPath, DEST_ESTIMATES);
    return `${r.estimateCount} estimates / ${r.optionCount} options (${r.withLineItems} with line items) → ${DEST_ESTIMATES}`;
  }));

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);

  console.log('\n══ Summary ═══════════════════════════════════════════');
  for (const r of results) {
    console.log(r.ok ? `  OK    ${r.name}: ${r.detail}` : `  FAIL  ${r.name}: ${r.error}`);
  }
  console.log(`  Published into: ${cfg.ingestDir}`);

  if (failed.length === 0) {
    console.log('\nDone. RAG will re-index automatically.');
    return;
  }

  console.error(`\n${failed.length} of ${results.length} steps failed.`);
  if (failed.some(f => isAuthFailure(f.error ?? ''))) {
    if (auth.via === 'daemon') {
      console.error(
        'This looks like an expired HCP session. The relogin must run on the PC\n' +
        '(npm run relogin) — that refreshes the browser profile the MCP daemon\n' +
        'uses. No cookie file is copied to this host. Re-run after the relogin.',
      );
    } else {
      console.error(
        'This looks like an expired HCP session. Run "npm run login" on the PC to\n' +
        'refresh the saved browser session, then place the refreshed cookie file on\n' +
        'this host through Orca and re-run.',
      );
    }
  }
  process.exit(1);
}

run().catch(err => {
  console.error('\nFailed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
