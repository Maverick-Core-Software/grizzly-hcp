import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const HD_SEARCH_URL = 'https://www.homedepot.com/s/json/';

interface HdResult {
  price: number;
  unit: 'each' | 'per ft';
  name: string;
}

export async function fetchHomeDepotPrice(description: string): Promise<HdResult | null> {
  const keyword = encodeURIComponent(description);
  const url = `${HD_SEARCH_URL}?keyword=${keyword}&pageSize=3&storeId=121`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GrizzlyEstimator/1.0)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;

    // ponytail: HD's JSON schema changes; if parsing fails, return null rather than crash
    const data = await res.json() as Record<string, unknown>;
    const products = (data?.searchModel as Record<string, unknown>)?.products as unknown[];
    if (!Array.isArray(products) || products.length === 0) return null;

    const first = products[0] as Record<string, unknown>;
    const pricing = first?.pricing as Record<string, unknown> | undefined;
    const price = Number((pricing as Record<string, unknown>)?.value ?? (pricing as Record<string, unknown>)?.original ?? 0);
    if (!price || price <= 0) return null;

    const identifiers = first?.identifiers as Record<string, unknown> | undefined;
    const name = String((identifiers as Record<string, unknown>)?.productLabel ?? description);

    // Determine unit from product info
    const uom = String((pricing as Record<string, unknown>)?.uom ?? '').toLowerCase();
    const unit: HdResult['unit'] = uom.includes('ft') || uom.includes('foot') || uom.includes('linear')
      ? 'per ft'
      : 'each';

    return { price, unit, name };
  } catch {
    return null;
  }
}

export const lookupHomeDepotPriceTool = createTool({
  id: 'lookup_home_depot_price',
  description:
    'Look up the current Home Depot price for an electrical material. ' +
    'Use in Build mode only when a material has no pricebook match. ' +
    'Grizzly applies 45% markup on top of the HD price. ' +
    'Returns null if not found — item will be flagged for manual pricing.',
  inputSchema: z.object({
    description: z.string().describe('Material description, e.g. "2 inch PVC Schedule 40 conduit"'),
  }),
  execute: async ({ description }) => {
    const result = await fetchHomeDepotPrice(description);
    if (!result) return { found: false, description };
    const grizzlyPrice = +(result.price * 1.45).toFixed(2);
    return {
      found: true,
      hdPrice: result.price,
      grizzlyPrice,
      unit: result.unit,
      hdName: result.name,
      markupNote: 'HD price × 1.45 (45% markup — Grizzly standard for HD-sourced materials)',
    };
  },
});

export const homeDepotTools = {
  lookup_home_depot_price: lookupHomeDepotPriceTool,
};
