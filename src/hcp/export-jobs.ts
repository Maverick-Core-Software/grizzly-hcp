/**
 * Pull all jobs from HCP and write data/jobs.csv for RAG ingest.
 * Covers all statuses: scheduled, completed, needs scheduling, in progress.
 * Run: npm run export-jobs
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { hcpGet } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.resolve(__dirname, '../../data/jobs.csv');

interface HcpJob {
  id: string;
  invoice_number: string;
  description: string | null;
  total_amount: number;           // cents
  work_status: string;
  printable_address: string;
  note: string | null;
  notes: string[];
  schedule: { data: { start_time: string | null; end_time: string | null } };
  work_status_timestamps: { finish: string | null; start: string | null };
  customer: { data: { display_name: string; email: string | null; mobile_number: string | null } };
}

interface JobsResponse {
  data: { data: HcpJob[] };
  total_count: number;
  total_page_count: number;
}

function escape(s: string | null | undefined): string {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

function centsToStr(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function run() {
  console.log('Fetching all jobs from HCP...');

  const rows: string[] = [];
  let page = 1;
  let total = 0;

  while (true) {
    const params = new URLSearchParams({ page: String(page), page_size: '100' });
    params.append('expand[]', 'customer');

    const res = await hcpGet<JobsResponse>(`/alpha/jobs?${params}`);
    const jobs = res.data?.data ?? [];

    for (const j of jobs) {
      const customer = j.customer?.data;
      const completedAt = j.work_status_timestamps?.finish ?? '';
      const scheduledStart = j.schedule?.data?.start_time ?? '';
      const noteText = [
        j.note,
        ...(Array.isArray(j.notes) ? j.notes.map((n: any) => typeof n === 'string' ? n : n?.note ?? '') : []),
      ].filter(Boolean).join(' | ');

      rows.push([
        j.invoice_number,
        customer?.display_name,
        completedAt || scheduledStart,
        j.work_status,
        centsToStr(j.total_amount),
        j.description,
        noteText,
        j.printable_address,
        customer?.email,
        customer?.mobile_number,
      ].map(escape).join(','));
    }

    total += jobs.length;
    process.stdout.write(`\r  Page ${page}/${res.total_page_count} — ${total} jobs`);

    if (page >= res.total_page_count) break;
    page++;
  }

  const HEADER = [
    'invoice_number', 'customer_name', 'completed_at', 'status',
    'total_amount', 'line_items', 'notes', 'service_address',
    'customer_email', 'customer_phone',
  ].map(escape).join(',');

  await fs.writeFile(CSV_PATH, HEADER + '\n' + rows.join('\n'), 'utf-8');
  console.log(`\n\nExported ${total} jobs → ${CSV_PATH}`);
  console.log('Run "npm run push-jobs" to re-index in RAG.');
}

run().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
