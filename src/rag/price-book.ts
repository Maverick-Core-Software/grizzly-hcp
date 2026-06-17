/**
 * Local fuzzy matcher against the Grizzly HCP price book CSV.
 * Pre-matches proposal line items to HCP price book names before
 * Playwright searches HCP, so we search with the exact right term.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.resolve(__dirname, '../../data/pricebook.csv');

export interface PriceBookItem {
  category: string;
  uuid: string;
  name: string;
  description: string;
  price: number;       // numeric, e.g. 79.00
  priceStr: string;    // raw string from CSV, e.g. "$79.00"
  unitOfMeasure: string;
}

export interface MatchResult {
  item: PriceBookItem;
  score: number;       // 0–1, higher = better match
  exact: boolean;
}

let _cache: PriceBookItem[] | null = null;

export async function loadPriceBook(): Promise<PriceBookItem[]> {
  if (_cache) return _cache;

  const raw = await fs.readFile(CSV_PATH, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  const items: PriceBookItem[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 7) continue;
    const priceStr = cols[6] ?? '';
    const price = parseFloat(priceStr.replace(/[$,]/g, '')) || 0;
    items.push({
      category: cols[2] ?? '',
      uuid: cols[3] ?? '',
      name: (cols[4] ?? '').trim(),
      description: (cols[5] ?? '').trim(),
      price,
      priceStr,
      unitOfMeasure: (cols[9] ?? '').trim(),
    });
  }

  _cache = items;
  return items;
}

/**
 * Find the best price book match for a given description.
 * Returns null if nothing scores above the threshold.
 */
export async function findBestMatch(description: string, threshold = 0.35): Promise<MatchResult | null> {
  const items = await loadPriceBook();
  const needle = normalize(description);

  let best: MatchResult | null = null;

  for (const item of items) {
    const haystack = normalize(item.name + ' ' + item.description);
    const score = similarity(needle, haystack);
    const exact = normalize(item.name) === needle;

    if (score >= threshold && (!best || score > best.score)) {
      best = { item, score, exact };
    }
  }

  return best;
}

/**
 * Match all line items at once. Returns an array parallel to inputs,
 * each entry is { match: MatchResult | null, original: string }.
 */
export async function matchLineItems(
  items: Array<{ description: string; quantity: number; unitPrice: number }>
): Promise<Array<{ description: string; quantity: number; unitPrice: number; match: MatchResult | null }>> {
  return Promise.all(
    items.map(async item => ({
      ...item,
      match: await findBestMatch(item.description),
    }))
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a: string, b: string): number {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 2));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 2));
  if (wordsA.size === 0) return 0;

  let hits = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) hits++;
  }

  // Jaccard-style overlap weighted toward the needle
  return hits / Math.max(wordsA.size, 1);
}

/** Minimal CSV parser that handles quoted fields with embedded commas/newlines */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}
