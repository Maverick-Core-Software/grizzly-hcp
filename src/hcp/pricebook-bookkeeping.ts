/**
 * Grizzly-local bookkeeping for a newly created pricebook item: append to the
 * local CSV cache + index in RAG. Extracted from price-book.ts so it runs after
 * EITHER the direct or the MCP createPriceBookItem (the MCP wrapper is a pure
 * HCP passthrough with no local side effects).
 *
 * ponytail: RAG indexing is best-effort (non-blocking) — a RAG outage must not
 * fail an estimate. Upgrade path: a retry queue if missed indexings matter.
 */
import { appendToCsv } from "../rag/price-book.js";
import { indexPriceBookItem } from "../rag/client.js";

export async function recordNewPricebookItem(args: {
  uuid: string;
  name: string;
  description: string;
  price: number;          // dollars
  category?: string;
  unitOfMeasure?: string;
}): Promise<void> {
  const category = args.category ?? "Custom";
  const unitOfMeasure = args.unitOfMeasure ?? "Each";
  try {
    await appendToCsv({
      category,
      uuid: args.uuid,
      name: args.name,
      description: args.description,
      price: args.price,
      priceStr: `$${args.price.toFixed(2)}`,
      unitOfMeasure,
    });
  } catch (e) {
    console.error("[pricebook-bookkeeping] CSV append failed (non-fatal) for", args.uuid, args.name, e);
  }
  try {
    await indexPriceBookItem({
      uuid: args.uuid,
      name: args.name,
      description: args.description,
      price: args.price,
      category,
      unitOfMeasure,
    });
  } catch (e) {
    console.error("[pricebook-bookkeeping] RAG index failed (non-fatal) for", args.uuid, args.name, e);
  }
}
