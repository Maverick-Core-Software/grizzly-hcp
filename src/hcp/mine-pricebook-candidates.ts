/**
 * Mine historical HCP job line items for pricebook candidates.
 * Custom items (service_item_id null) used on 2+ distinct jobs that aren't
 * already in the pricebook or previously promoted are surfaced for review.
 *
 * Run: npm run mine-pricebook
 * State: data/promoted-items.json tracks already-promoted items so re-runs skip them.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { hcpGet } from './client.js';
import { listAllServices, createPriceBookItem } from './price-book.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '../../data/promoted-items.json');
const CONCURRENCY = 5;
const MIN_USES = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export interface RawLineItem {
  name: string;
  unit_price: number;        // cents
  kind: string;
  service_item_id?: string | null;
}

export interface Candidate {
  displayName: string;
  uses: number;
  modalPrice: number;        // dollars
  kind: string;
}

interface StateFile {
  promoted: Array<{ name: string; uuid: string; addedAt: string }>;
}

// ── Pure utilities (exported for check file) ───────────────────────────────

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function modalValue(arr: number[]): number {
  if (arr.length === 0) return 0;  // ponytail: 0 = no price data seen; Task 4 displays as $0.00
  const counts = new Map<number, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = arr[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v < best)) { best = v; bestCount = c; }
  }
  return best;
}

export function aggregateCandidates(
  jobs: Array<{ id: string }>,
  lineItemsByJob: Map<string, RawLineItem[]>,
): Map<string, { displayName: string; uses: number; prices: number[]; kinds: string[] }> {
  const agg = new Map<string, { displayName: string; uses: number; prices: number[]; kinds: string[] }>();

  for (const job of jobs) {
    const items = lineItemsByJob.get(job.id) ?? [];
    const seenThisJob = new Set<string>();

    for (const item of items) {
      if (!item.name?.trim()) continue;
      if (item.service_item_id) continue;          // already a pricebook item
      const key = normalize(item.name);
      if (seenThisJob.has(key)) continue;           // deduplicate within this job
      seenThisJob.add(key);

      const existing = agg.get(key) ?? { displayName: item.name, uses: 0, prices: [], kinds: [] };
      existing.uses++;
      if (item.unit_price > 0) existing.prices.push(item.unit_price);
      if (item.kind) existing.kinds.push(item.kind);
      agg.set(key, existing);
    }
  }

  return agg;
}

// ── State file ─────────────────────────────────────────────────────────────

async function loadPricebookNames(): Promise<Set<string>> {
  const services = await listAllServices();
  return new Set(services.map(s => normalize(s.name)));
}

async function loadStateNames(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf-8');
    const state: StateFile = JSON.parse(raw);
    return new Set((state.promoted ?? []).map(p => normalize(p.name)));
  } catch {
    return new Set();   // file doesn't exist yet on first run
  }
}

async function appendToState(items: Array<{ name: string; uuid: string }>): Promise<void> {
  let state: StateFile = { promoted: [] };
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf-8');
    state = JSON.parse(raw);
  } catch { /* new file */ }

  const today = new Date().toISOString().slice(0, 10);
  state.promoted.push(...items.map(i => ({ name: i.name, uuid: i.uuid, addedAt: today })));
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

// ── HCP fetching ───────────────────────────────────────────────────────────

interface HcpJob { id: string; invoice_number: string; }

async function fetchAllJobs(): Promise<HcpJob[]> {
  const all: HcpJob[] = [];
  let page = 1;
  while (true) {
    const res = await hcpGet<{ data: { data: HcpJob[] }; total_page_count: number }>(
      `/alpha/jobs?page=${page}&page_size=100`,
    );
    const batch = res.data?.data ?? [];
    all.push(...batch);
    process.stdout.write(`\r  Fetched ${all.length} jobs (page ${page}/${res.total_page_count})`);
    if (page >= res.total_page_count) break;
    page++;
  }
  console.log();
  return all;
}

async function fetchLineItems(jobId: string): Promise<RawLineItem[]> {
  try {
    const res = await hcpGet<Record<string, unknown>>(`/alpha/jobs/${jobId}/line_items`);
    const items = (res['line_items'] ?? res['data'] ?? []) as RawLineItem[];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

// ponytail: 5-concurrent limit matches known HCP rate tolerance (see sync-estimates.ts)
async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Placeholder main (will be replaced in Task 4) ─────────────────────────

async function run() {
  throw new Error('Not implemented yet');
}

const isMain = /mine-pricebook-candidates\.(ts|js)$/.test(process.argv[1] ?? '');
if (isMain) run().catch(err => { console.error(err.message); process.exit(1); });
