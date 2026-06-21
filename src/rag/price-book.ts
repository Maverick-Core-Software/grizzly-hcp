/**
 * Price book matcher. Tries RAG semantic search first (when online),
 * falls back to local CSV fuzzy match. Both paths return the same MatchResult shape.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { searchPriceBook, checkHealth } from './client.js';

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
export async function findBestMatch(description: string, threshold = 0.6): Promise<MatchResult | null> {
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

const RAG_SCORE_THRESHOLD = 0.60; // cosine similarity — junk vectors removed, lowered to catch near-miss short names

/**
 * Match all line items at once. Tries RAG semantic search first (when online),
 * falls back to local CSV fuzzy match for any item that scores below threshold.
 */
export async function matchLineItems(
  items: Array<{ description: string; quantity: number; unitPrice: number }>
): Promise<Array<{ description: string; quantity: number; unitPrice: number; match: MatchResult | null }>> {
  const ragOnline = await checkHealth();

  return Promise.all(
    items.map(async item => {
      let match: MatchResult | null = null;

      if (ragOnline) {
        try {
          const hits = await searchPriceBook(item.description, 1);
          const top = hits[0];
          if (top && top.score >= RAG_SCORE_THRESHOLD) {
            match = {
              item: {
                category: top.category,
                uuid: top.uuid,
                name: top.name,
                description: top.description,
                price: top.price,
                priceStr: `$${top.price.toFixed(2)}`,
                unitOfMeasure: top.unitOfMeasure,
              },
              score: top.score,
              exact: false,
            };
          }
        } catch {
          // RAG offline or this item failed — fall through to local
        }
      }

      if (!match) {
        match = await findBestMatch(item.description);
      }

      return { ...item, match };
    })
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
  const wordsA = new Set(a.split(' ').filter(w => w.length > 3));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 3));

  // Require at least 2 meaningful words to avoid single-word false matches
  if (wordsA.size < 2) return 0;

  let hits = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) hits++;
  }

  return hits / Math.max(wordsA.size, 1);
}

/**
 * Append a new item to the local pricebook.csv and invalidate the in-memory cache.
 * Called automatically when a custom line item is saved to the HCP price book.
 */
export async function appendToCsv(item: Omit<PriceBookItem, 'price'> & { price: number }): Promise<void> {
  const INDUSTRY        = 'Electrical';
  const INDUSTRY_UUID   = 'ind_600204be061340dabf33d97e8db5c0b9';
  const TAXABLE         = 'false';
  const TASK_CODE       = '';
  const ONLINE_BOOKING  = 'true';

  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;

  const row = [
    INDUSTRY,
    INDUSTRY_UUID,
    item.category,
    item.uuid,
    item.name,
    item.description,
    item.priceStr || `$${item.price.toFixed(2)}`,
    '$0.00',
    TAXABLE,
    item.unitOfMeasure || 'Each',
    TASK_CODE,
    ONLINE_BOOKING,
  ].map(escape).join(',');

  await fs.appendFile(CSV_PATH, '\n' + row, 'utf-8');
  _cache = null; // force reload on next use
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
