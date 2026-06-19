/**
 * Pull all customers from HCP and write data/customers.csv for RAG ingest.
 * Run: npm run export-customers
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { hcpGet } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.resolve(__dirname, '../../data/customers.csv');

interface HcpAddress {
  street: string;
  street_line_2: string;
  city: string;
  state: string;
  zip: string;
}

interface HcpCustomer {
  id: string;
  display_name: string;
  email: string | null;
  mobile_number: string | null;
  home_number: string | null;
  company: string | null;
  notes: string | null;
  tags: { data: Array<{ name: string }> };
  addresses: { data: HcpAddress[] };
}

interface PagedList<T> {
  data: T[];
  page: number;
  page_size: number;
  total_pages_count: number;
  total_count: number;
}

function escape(s: string | null | undefined): string {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

async function run() {
  console.log('Fetching all customers from HCP...');

  const rows: string[] = [];
  let page = 1;
  let total = 0;

  while (true) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: '100',
      sort_by: 'display_name',
      sort_direction: 'asc',
    });
    params.append('expand[]', 'addresses');
    params.append('expand[]', 'tags');

    const res = await hcpGet<PagedList<HcpCustomer>>(`/alpha/customers?${params}`);
    const customers = res.data ?? [];

    for (const c of customers) {
      const addr = c.addresses?.data?.[0];
      const tags = (c.tags?.data ?? []).map(t => t.name).join(', ');
      rows.push([
        c.display_name,
        c.email,
        c.mobile_number ?? c.home_number,
        c.company,
        addr?.street,
        addr?.city,
        addr?.state,
        addr?.zip,
        tags,
        c.notes,
      ].map(escape).join(','));
    }

    total += customers.length;
    process.stdout.write(`\r  Page ${page}/${res.total_pages_count} — ${total} customers`);

    if (page >= res.total_pages_count) break;
    page++;
  }

  const HEADER = ['name', 'email', 'mobile_number', 'company', 'street', 'city', 'state', 'zip', 'tags', 'notes']
    .map(escape).join(',');

  await fs.writeFile(CSV_PATH, HEADER + '\n' + rows.join('\n'), 'utf-8');
  console.log(`\n\nExported ${total} customers → ${CSV_PATH}`);
  console.log('Run "npm run push-customers" to re-index in RAG.');
}

run().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
