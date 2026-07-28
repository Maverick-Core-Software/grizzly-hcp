/**
 * Pull all HCP jobs with full line items → enriched CSV → push to Proxmox RAG ingest.
 *
 * The existing jobs.csv only has the first line item title. This script fetches
 * the complete breakdown (every item, quantity, unit price, kind) so the RAG can
 * learn Grizzly's estimating patterns from real historical data.
 *
 * Run: npm run sync-estimates
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { hcpGet } from './client.js';
import { deleteJobPoints, publishCsv, resolveRagConfig } from './rag-publish.js';
import { checkHcpAuth } from './preflight-auth.js';

/** Distinctive marker the Hermes monitor greps the journal for. */
const AUTH_FAIL_MARKER = 'HCP_AUTH_PREFLIGHT_FAIL';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolved CSV output path — overridable via ESTIMATES_CSV_PATH. */
const CSV_PATH =
  process.env.ESTIMATES_CSV_PATH
    ? path.resolve(process.env.ESTIMATES_CSV_PATH)
    : path.resolve(__dirname, '../../data/estimates-enriched.csv');

// ── HCP types ──────────────────────────────────────────────────────────────

interface HcpJob {
  id: string;
  invoice_number: string;
  description: string | null;
  total_amount: number;          // cents
  work_status: string;
  printable_address: string;
  note: string | null;
  notes: unknown[];
  schedule: { data: { start_time: string | null } };
  work_status_timestamps: { finish: string | null };
  customer: { data: { display_name: string; email: string | null; mobile_number: string | null } };
}

interface HcpLineItem {
  name: string;
  quantity: number;
  unit_price: number;  // cents
  kind: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escape(s: string | null | undefined): string {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function fetchLineItems(jobId: string): Promise<HcpLineItem[]> {
  try {
    const res = await hcpGet<Record<string, unknown>>(`/alpha/jobs/${jobId}/line_items`);
    // HCP wraps line items under different keys depending on context
    const items = (res['line_items'] ?? res['data'] ?? []) as HcpLineItem[];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function formatLineItems(items: HcpLineItem[]): string {
  return items
    .filter(i => i.kind !== 'fixed discount' && i.name?.trim())
    .map(i => `${i.name} × ${i.quantity} @ ${dollars(i.unit_price)} (${i.kind})`)
    .join(' | ');
}

/** Concurrency-limited parallel map. */
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
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
  console.log(`HCP auth ok via ${auth.via}`);

  // 1. Collect all jobs
  console.log('Fetching jobs from HCP...');
  const allJobs: HcpJob[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({ page: String(page), page_size: '100' });
    params.append('expand[]', 'customer');

    const res = await hcpGet<{ data: { data: HcpJob[] }; total_page_count: number }>(
      `/alpha/jobs?${params}`,
    );
    const batch = res.data?.data ?? [];
    allJobs.push(...batch);
    process.stdout.write(`\r  ${allJobs.length} jobs (page ${page}/${res.total_page_count})`);
    if (page >= res.total_page_count) break;
    page++;
  }
  console.log(`\nTotal: ${allJobs.length} jobs\n`);

  // 2. Fetch line items (5 concurrent — safe for HCP's undocumented rate limits)
  console.log('Fetching line items...');
  let done = 0;
  const enriched = await pMap(
    allJobs,
    async job => {
      const lineItems = await fetchLineItems(job.id);
      done++;
      process.stdout.write(`\r  ${done}/${allJobs.length} enriched`);
      return { job, lineItems };
    },
    5,
  );
  const withItems = enriched.filter(e => e.lineItems.length > 0).length;
  console.log(`\nLine items found on ${withItems}/${allJobs.length} jobs\n`);

  // 3. Build enriched CSV
  const HEADER = [
    'invoice_number', 'customer_name', 'completed_at', 'status',
    'total_amount', 'line_items', 'notes', 'service_address',
    'customer_email', 'customer_phone',
  ].map(escape).join(',');

  const rows = enriched.map(({ job, lineItems }) => {
    const customer  = job.customer?.data;
    const completed = job.work_status_timestamps?.finish ?? job.schedule?.data?.start_time ?? '';
    const notes     = [
      job.note,
      ...(Array.isArray(job.notes)
        ? job.notes.map(n => (typeof n === 'string' ? n : (n as Record<string, unknown>)?.note ?? ''))
        : []),
    ].filter(Boolean).join(' | ');

    const lineItemsText = lineItems.length > 0
      ? formatLineItems(lineItems)
      : job.description ?? '';

    return [
      job.invoice_number,
      customer?.display_name,
      completed,
      job.work_status,
      dollars(job.total_amount),
      lineItemsText,
      notes,
      job.printable_address,
      customer?.email,
      customer?.mobile_number,
    ].map(escape).join(',');
  });

  await fs.writeFile(CSV_PATH, HEADER + '\n' + rows.join('\n'), 'utf-8');
  console.log(`Wrote ${enriched.length} rows → data/estimates-enriched.csv`);

  // 4. Publish results to RAG ingest
  console.log('Publishing to RAG ingest...');
  const cfg = resolveRagConfig();
  await deleteJobPoints(cfg);
  await publishCsv(cfg, CSV_PATH);

  console.log('\nDone. RAG will re-index automatically.');
  console.log(`  Jobs synced:        ${allJobs.length}`);
  console.log(`  With line items:    ${withItems}`);
  console.log(`  Without line items: ${allJobs.length - withItems}`);
}

run().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
