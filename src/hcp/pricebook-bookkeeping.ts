/**
 * Grizzly-local bookkeeping for a newly created pricebook item: append to the
 * local CSV cache + index in RAG. Extracted from price-book.ts so it runs after
 * EITHER the direct or the MCP createPriceBookItem (the MCP wrapper is a pure
 * HCP passthrough with no local side effects).
 *
 * ponytail: RAG indexing is best-effort (non-blocking) — a RAG outage must not
 * fail an estimate. Recoverability: a failed index appends the item to
 * data/rag-reindex-pending.jsonl; drainReindexPending() replays that queue once
 * RAG is back (wired into `npm run enrich-rag`).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendToCsv } from "../rag/price-book.js";
import { indexPriceBookItem } from "../rag/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overridable for tests; defaults to the repo's data/ dir alongside pricebook.csv.
const PENDING_PATH =
  process.env.RAG_REINDEX_PENDING_PATH ??
  path.resolve(__dirname, "../../data/rag-reindex-pending.jsonl");

export interface PricebookIndexItem {
  uuid: string;
  name: string;
  description: string;
  price: number; // dollars
  category: string;
  unitOfMeasure: string;
}

/**
 * Index an item in RAG; on failure, append it to the pending-reindex queue so a
 * later drain can recover it. Best-effort and never throws — a RAG outage must
 * never fail the caller (e.g. an estimate).
 */
export async function indexOrQueuePricebookItem(item: PricebookIndexItem): Promise<void> {
  try {
    await indexPriceBookItem(item);
  } catch (e) {
    console.error(
      "[pricebook-bookkeeping] RAG index failed (non-fatal), queuing for reindex:",
      item.uuid,
      item.name,
      e,
    );
    try {
      await fs.appendFile(PENDING_PATH, JSON.stringify(item) + "\n", "utf-8");
    } catch (e2) {
      // Last resort — nothing else we can safely do without blocking the caller.
      console.error("[pricebook-bookkeeping] failed to queue pending reindex for", item.uuid, e2);
    }
  }
}

/**
 * Replay data/rag-reindex-pending.jsonl: re-index each queued item and drop the
 * ones that succeed; entries that still fail are kept for the next run. Returns
 * counts. Best-effort — a missing/empty queue is a no-op.
 */
export async function drainReindexPending(): Promise<{ drained: number; remaining: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(PENDING_PATH, "utf-8");
  } catch {
    return { drained: 0, remaining: 0 }; // nothing queued
  }

  const lines = raw.split("\n").filter(l => l.trim());
  const stillPending: string[] = [];
  let drained = 0;

  for (const line of lines) {
    let item: PricebookIndexItem;
    try {
      item = JSON.parse(line);
    } catch {
      continue; // drop unparseable lines rather than wedge the queue forever
    }
    try {
      await indexPriceBookItem(item);
      drained++;
    } catch {
      stillPending.push(line);
    }
  }

  if (stillPending.length) {
    await fs.writeFile(PENDING_PATH, stillPending.join("\n") + "\n", "utf-8");
  } else {
    await fs.rm(PENDING_PATH, { force: true });
  }
  return { drained, remaining: stillPending.length };
}

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
  await indexOrQueuePricebookItem({
    uuid: args.uuid,
    name: args.name,
    description: args.description,
    price: args.price,
    category,
    unitOfMeasure,
  });
}
