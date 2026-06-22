/**
 * Builds an HCP estimate line item from a price-book match result.
 * Shared by the from-chat and from-email automations so the no-match
 * behavior stays consistent in one place.
 *
 * No-match policy: we DO add the line (so the estimate stays complete and
 * resilient) but at $0 with a visible NEEDS-PRICING flag in the description,
 * so Carter prices it manually in HCP. We deliberately do NOT write a $0
 * placeholder into the live HCP price book — that pollutes the real catalog
 * with unpriced junk (see TEST-RESULTS-2026-06-21.md F2).
 */
import type { HcpLineItem } from './estimates.js';
import type { MatchResult } from '../rag/price-book.js';

/** Flag shown in the line-item description when no price book match was found. */
export const NEEDS_PRICING_FLAG = '⚠ NEEDS PRICING — no price book match';

/** A single matched work item as returned by matchLineItems(). */
export interface MatchedWorkItem {
  description: string;
  quantity: number;
  unitPrice: number;
  match: MatchResult | null;
}

export function itemKind(description: string, category: string): HcpLineItem['kind'] {
  const d = description.toLowerCase();
  const c = category.toLowerCase();
  if (d.includes('discount') || c.includes('discount')) return 'fixed discount';
  if (c.includes('material') || d.includes('material') || d.includes('wire') ||
      d.includes('conduit') || d.includes('panel') || d.includes('breaker') ||
      d.includes('box') || d.includes('device') || d.includes('fixture')) {
    return 'materials';
  }
  return 'labor';
}

/**
 * Build the HCP line item for a matched work item.
 * Returns the item plus `matched` so callers can track/report unmatched items.
 * On no-match the item is $0 with the NEEDS_PRICING_FLAG description — never
 * written back to the price book.
 */
export function buildLineItem(m: MatchedWorkItem, orderIndex: number): { item: HcpLineItem; matched: boolean } {
  const pb = m.match?.item;
  const matched = !!pb;

  const item: HcpLineItem = {
    name:          pb?.name ?? m.description,
    description:   pb ? m.description : NEEDS_PRICING_FLAG,
    unitPrice:     (pb && pb.price > 0) ? pb.price : (m.unitPrice ?? 0),
    quantity:      m.quantity,
    kind:          itemKind(m.description, pb?.category ?? ''),
    taxable:       false,
    serviceItemId: pb?.uuid,
    orderIndex,
  };

  return { item, matched };
}
