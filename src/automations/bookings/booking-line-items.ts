/**
 * Line items for voice booking estimates.
 *
 * from-voice historically created an empty estimate shell (customer + address +
 * note only). HCP needs at least one line item before the estimate is useful for
 * office pricing and customer-facing totals.
 *
 * Policy:
 *  1. Always try to attach the default visit fee ("Service Fee" unless overridden).
 *  2. If the caller described work (issue), try to match that as a second line.
 *  3. Never write to the live price book on miss — $0 + NEEDS PRICING flag (buildLineItem).
 *  4. If every path fails, still force one fallback labor line so the estimate is never empty.
 */
import { addLineItem } from "../../hcp/gateway.js";
import { buildLineItem } from "../../hcp/build-line-item.js";
import { matchLineItems } from "../../rag/price-book.js";

export const DEFAULT_BOOKING_LINE_NAME =
  process.env.BOOKING_DEFAULT_LINE_ITEM?.trim() || "Service Fee";

export function buildBookingWorkItems(issue?: string): Array<{
  description: string;
  quantity: number;
  unitPrice: number;
}> {
  const items: Array<{ description: string; quantity: number; unitPrice: number }> = [
    { description: DEFAULT_BOOKING_LINE_NAME, quantity: 1, unitPrice: 0 },
  ];
  const issueText = (issue ?? "").trim();
  if (
    issueText &&
    issueText.toLowerCase() !== DEFAULT_BOOKING_LINE_NAME.toLowerCase()
  ) {
    items.push({ description: issueText, quantity: 1, unitPrice: 0 });
  }
  return items;
}

/**
 * Match work items to the price book and add them to the estimate via gateway.
 * Returns names of lines actually written (for logs / tests).
 */
export async function attachBookingLineItems(
  estimateUuid: string,
  issue?: string,
): Promise<string[]> {
  const workItems = buildBookingWorkItems(issue);
  let matched = await matchLineItems(workItems);

  // If the default fee failed to match and is the only item, still write a line.
  if (matched.length === 0) {
    matched = [
      {
        description: DEFAULT_BOOKING_LINE_NAME,
        quantity: 1,
        unitPrice: 0,
        match: null,
      },
    ];
  }

  const written: string[] = [];
  for (let i = 0; i < matched.length; i++) {
    const { item } = buildLineItem(matched[i], i);
    await addLineItem(estimateUuid, item, i);
    written.push(item.name);
  }

  // Hard guarantee: never leave a booking estimate with zero lines.
  if (written.length === 0) {
    const fallback = {
      name: DEFAULT_BOOKING_LINE_NAME,
      description: "Voice booking — price on site if needed",
      unitPrice: 0,
      quantity: 1,
      kind: "labor" as const,
      taxable: false,
      orderIndex: 0,
    };
    await addLineItem(estimateUuid, fallback, 0);
    written.push(fallback.name);
  }

  return written;
}
