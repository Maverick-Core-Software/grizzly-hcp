/**
 * Pull all HCP estimates with options and line items → enriched CSV.
 *
 * One CSV row per estimate option. Estimates with no options still produce
 * one row.
 *
 * Run: npm run export-estimates
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { hcpGet } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CSV_PATH =
  process.env.ESTIMATES_EXPORT_CSV_PATH
    ? path.resolve(process.env.ESTIMATES_EXPORT_CSV_PATH)
    : path.resolve(__dirname, '../../data/estimates-export.csv');

// ── HCP types ──────────────────────────────────────────────────────────────

interface HcpEstimate {
  id: string;
  invoice_number: string;
  description: string | null;
  created_at: string;
  outcome: string | null;
  value: number;
  address: string | null;
  request_address: string | null;
  notes: string | null;
  customer_name: string;
  customer_billable_email: string;
  customer_phone_number: string | null;
  assigned_pros: { full_name: string }[];
  options?: HcpOption[];
}

interface HcpOption {
  id: string;
  name: string;
  total_amount: number;
  status: string;
  option_description: string | null;
  address: string | null;
  employees: string[];
  notes: { data: { content: string }[] };
}

interface HcpLineItem {
  name: string;
  quantity: number;
  unit_price: number;
  kind: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escape(s: string | null | undefined): string {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function nonEmpty(s: string | null | undefined): string | undefined {
  return s && s.trim() ? s : undefined;
}

async function fetchLineItems(optionId: string): Promise<HcpLineItem[]> {
  try {
    const res = await hcpGet<Record<string, unknown>>(`/alpha/estimates/${optionId}/line_items`);
    return (res['line_items'] ?? res['data'] ?? []) as HcpLineItem[];
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

async function run(): Promise<{ csvPath: string; estimateCount: number; optionCount: number; withLineItems: number }> {
  console.log('Fetching estimates from HCP...');
  const allEstimates: HcpEstimate[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({ page: String(page), page_size: '100' });
    params.append('expand[]', 'canceled_options');
    params.append('expand[]', 'options.notes');

    const res = await hcpGet<{ data: Record<string, HcpEstimate>; total_pages_count: number }>(`/beta/estimates?${params}`);
    const batch = res.data ? Object.values(res.data) : [];
    allEstimates.push(...batch);
    process.stdout.write(`\r  ${allEstimates.length} estimates (page ${page}/${res.total_pages_count})`);
    if (page >= res.total_pages_count) break;
    page++;
  }
  console.log(`\nTotal: ${allEstimates.length} estimates\n`);

  // Flatten → per-option rows. If an estimate has no options, produce one row.
  interface Enriched { estimate: HcpEstimate; option: HcpOption | null; lineItems: HcpLineItem[]; }
  const estimateOptions: Enriched[] = [];
  allEstimates.forEach(est => {
    const options = est.options && est.options.length > 0 ? est.options : [null];
    options.forEach(opt => {
      estimateOptions.push({ estimate: est, option: opt, lineItems: [] });
    });
  });

  // Fetch line items per option
  console.log('Fetching line items...');
  let done = 0;
  const enriched: Enriched[] = await pMap(
    estimateOptions,
    async eo => {
      const items = eo.option ? await fetchLineItems(eo.option.id) : [];
      done++;
      process.stdout.write(`\r  ${done}/${estimateOptions.length} enriched`);
      return { ...eo, lineItems: items };
    },
    5,
  );

  const withItems = enriched.filter(e => e.lineItems.length > 0).length;

  // Build CSV
  const HEADER = [
    'estimate_uuid', 'option_uuid', 'estimate_number', 'customer_name',
    'customer_email', 'customer_phone', 'service_address', 'created_date',
    'outcome', 'option_name', 'option_status', 'option_total',
    'line_items', 'notes', 'assigned_pros',
  ].map(escape).join(',');

  const rows = enriched.map(e => {
    const { estimate, option, lineItems } = e;

    const addr = nonEmpty(estimate.request_address) ?? nonEmpty(estimate.address) ?? nonEmpty(option?.address);
    const optTotal = option?.total_amount ?? estimate.value;

    // notes: estimate notes + option notes
    const estNote = estimate.notes && typeof estimate.notes === 'string' ? estimate.notes : '';
    const optNotes = option && option.notes && Array.isArray(option.notes.data)
      ? option.notes.data.map(n => n.content)
      : [];
    const notes = [estNote, ...optNotes].filter(Boolean).join(' | ');

    // line_items: formatted items, or option_description, or estimate description
    const formatted = formatLineItems(lineItems);
    const lineItemsText = formatted || option?.option_description || estimate.description || '';

    const pros = option?.employees?.filter(Boolean) || estimate.assigned_pros?.map(p => p.full_name) || [];

    return [
      estimate.id,
      option?.id ?? '',
      estimate.invoice_number,
      estimate.customer_name,
      estimate.customer_billable_email,
      estimate.customer_phone_number,
      addr ?? '',
      estimate.created_at,
      estimate.outcome,
      option?.name ?? '',
      option?.status ?? '',
      dollars(optTotal),
      lineItemsText,
      notes,
      pros.join(', '),
    ].map(escape).join(',');
  });

  await fs.writeFile(CSV_PATH, HEADER + '\n' + rows.join('\n'), 'utf-8');
  console.log(`Wrote ${rows.length} rows → ${CSV_PATH}`);

  return { csvPath: CSV_PATH, estimateCount: allEstimates.length, optionCount: rows.length, withLineItems: withItems };
}

export { run as runEstimatesExport };

// -- CLI entry --

// esbuild rewrites import.meta.url to the *bundle's* path, so inside a bundle
// this module would look like the entry point and self-run on import. Also
// require the script name to match this module.
if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  path.basename(process.argv[1], path.extname(process.argv[1])) === 'export-estimates'
) {
  run()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('\nFailed:', err.message);
      process.exit(1);
    });
}
