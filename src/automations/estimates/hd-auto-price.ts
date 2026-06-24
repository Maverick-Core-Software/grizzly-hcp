/**
 * HD auto-pricing pass: for unmatched material line items, fetch a Home Depot
 * price, apply Grizzly's 45% markup, and patch the match result in-place so
 * buildLineItem picks it up. Logs to data/auto-priced.jsonl (skipped in dry-run).
 */
import { randomUUID } from 'crypto';
import { appendFileSync } from 'fs';
import path from 'path';
import { fetchHomeDepotPrice } from '../../agent/tools/reads/home-depot.js';
import { appendToCsv } from '../../rag/price-book.js';

const AUTO_PRICED_LOG = path.join(process.cwd(), 'data', 'auto-priced.jsonl');

// Items whose description contains any of these keywords are pure labor —
// no HD price exists for them, so they stay as NEEDS_PRICING_FLAG.
// ponytail: 'install' intentionally excluded — "Install 2-inch PVC Conduit" is a material.
const LABOR_KEYWORDS = ['run', 'pull', 'labor', 'service call', 'diagnostic', 'inspection', 'permit'];

export async function applyHdAutoPricing(
  matched: Array<{
    description: string;
    match?: { item: { category?: string; uuid?: string; name: string; description?: string; price: number; priceStr?: string; unitOfMeasure?: string }; score: number; exact: boolean } | null;
  }>,
  progress: (msg: string) => void,
  dryRun: boolean,
): Promise<void> {
  await Promise.all(matched.map(async m => {
    if (m.match) return; // already matched — skip

    const desc = m.description.toLowerCase();
    const isLabor = LABOR_KEYWORDS.some(kw => desc.includes(kw));
    if (isLabor) return; // labor stays as NEEDS_PRICING_FLAG

    progress(`HD lookup: ${m.description}...`);
    const hdResult = await fetchHomeDepotPrice(m.description);
    if (!hdResult) {
      progress(`HD: no result for "${m.description}" — will flag for manual pricing`);
      return;
    }

    const grizzlyPrice = +(hdResult.price * 1.45).toFixed(2);
    const uuid = `hd_auto_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const pbItem = {
      category: 'Materials',
      uuid,
      name: hdResult.name,
      description: m.description,
      price: grizzlyPrice,
      priceStr: `$${grizzlyPrice.toFixed(2)}`,
      unitOfMeasure: hdResult.unit === 'per ft' ? 'Linear Foot' : 'Each',
    };

    // Patch match result in-place so buildLineItem picks it up
    m.match = { item: pbItem, score: 1.0, exact: false };

    progress(`HD auto-priced "${m.description}": HD $${hdResult.price} → Grizzly $${grizzlyPrice}`);

    if (!dryRun) {
      await appendToCsv(pbItem);
      appendFileSync(
        AUTO_PRICED_LOG,
        JSON.stringify({ ts: new Date().toISOString(), description: m.description, hdName: hdResult.name, hdPrice: hdResult.price, grizzlyPrice, uuid }) + '\n',
        'utf-8',
      );
    } else {
      progress(`[dry-run] would append to pricebook.csv + auto-priced.jsonl`);
    }
  }));
}
