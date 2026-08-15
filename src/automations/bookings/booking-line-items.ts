/**
 * Line items for voice booking estimates.
 *
 * Policy:
 *  1. Always attach the default visit fee ("Service Fee" unless overridden).
 *  2. Troubleshooting jobs are generic — do NOT free-text match the issue.
 *     - single circuit/appliance → Troubleshoot Level 1
 *     - multiple circuits/appliances → Troubleshoot Level 2
 *  3. Non-troubleshoot issues still try a price-book match as a second line.
 *  4. If the caller complained about the fee/price, add a 50% Service Fee
 *     discount line (fixed discount).
 *  5. Never write to the live price book on miss — $0 + NEEDS PRICING flag.
 *  6. If every path fails, force one fallback labor line so the estimate is never empty.
 */
import { addLineItem } from "../../hcp/gateway.js";
import { buildLineItem } from "../../hcp/build-line-item.js";
import { findBestMatch, matchLineItems } from "../../rag/price-book.js";

export const DEFAULT_BOOKING_LINE_NAME =
  process.env.BOOKING_DEFAULT_LINE_ITEM?.trim() || "Service Fee";

export const TROUBLESHOOT_LEVEL_1 = "Troubleshoot Level 1";
export const TROUBLESHOOT_LEVEL_2 = "Troubleshoot Level 2";
export const SERVICE_FEE_DISCOUNT_NAME = "50% Service Fee Discount — price concern";

export interface BookingLineOptions {
  /** True when the caller objected to price/fee; triggers 50% service-fee discount. */
  priceConcern?: boolean;
}

export type BookingWorkItem = {
  description: string;
  quantity: number;
  unitPrice: number;
};

/** Install/upgrade language — not a pure diagnostic call. */
const INSTALL_HINTS =
  /\b(install|installing|installation|replace|replacing|replacement|add new|adding|upgrade|upgrading|rewire|rewiring|new circuit|new outlet|new light|pendant|recessed|panel upgrade|meter|ev charger|charger install|hardwire|hard-wire)\b/i;

/** Diagnostic / not-working language. */
const TROUBLE_HINTS =
  /\b(troubleshoot|trouble|diagnos|not working|won't work|will not work|stopped working|keeps? (tripping|popping|blowing)|breaker (trip|pop|blow)|no power|dead outlet|outlet dead|flicker|intermittent|short(ed|ing)?|spark|buzz|hum|burning smell|hot outlet|gfci (trip|won't reset)|won't reset|keep(s)? going out|power out|half (the )?house|something'?s wrong|check (out|on|why)|look at|figure out|what'?s wrong)\b/i;

/** Signals the caller pushed back on price / service fee. */
const PRICE_CONCERN_HINTS =
  /\b(too (much|expensive|high)|price(y)?|cost(ly)?|cheaper|discount|half off|50%|fifty percent|service fee|trip fee|complain|sticker shock|that'?s a lot|wow that'?s|can you do better|lower (the )?price|reduce (the )?fee)\b/i;

/**
 * True when the issue reads as troubleshooting/diagnostic rather than
 * planned install work. Ambiguous mixed text still counts as troubleshooting
 * if diagnostic language is present and install language is not dominant.
 */
export function isTroubleshootingIssue(issue?: string): boolean {
  const text = (issue ?? "").trim();
  if (!text) return false;
  const trouble = TROUBLE_HINTS.test(text);
  const install = INSTALL_HINTS.test(text);
  if (trouble && !install) return true;
  if (trouble && install) {
    // e.g. "breaker popping after we changed the outlet" — still diagnostic.
    return true;
  }
  // Common short diagnostic phrases without strong install verbs.
  if (/\b(breaker|outlet|switch|light|stove|ac|hvac|fan|appliance|circuit)\b/i.test(text)
    && /\b(pop|trip|dead|out|broken|issue|problem|wrong|bad)\b/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Level 1 = single circuit or appliance.
 * Level 2 = multiple circuits or appliances (or whole-home / several rooms).
 * Default Level 1 unless the issue clearly names more than one system/location.
 */
export function troubleshootLevel(issue?: string): 1 | 2 {
  const text = (issue ?? "").toLowerCase();
  if (!text) return 1;

  // Explicit multi markers.
  if (/\b(multiple|several|a few|couple of|many)\s+(circuits?|appliances?|rooms?|issues?|problems?|outlets?|breakers?)\b/.test(text)) {
    return 2;
  }
  if (/\b(whole (house|home)|entire (house|home)|half (the )?house|upstairs and downstairs)\b/.test(text)) {
    return 2;
  }
  if (/\bboth\b/.test(text) && /\b(and|&)\b/.test(text)) {
    return 2;
  }

  // Two independent systems joined: "X and Y both/stopped/not working"
  // e.g. "Outdoor outlet and attic light switch both stopped working"
  const joinedSystems =
    /\b([\w-]+(?:\s+[\w-]+){0,3})\s+and\s+([\w-]+(?:\s+[\w-]+){0,3})\s+(both\s+)?(stopped|not working|dead|tripping|popping|out|broken|issues?|problems?)\b/.test(
      text,
    );
  if (joinedSystems) return 2;

  // "no power in kitchen and living room" style
  if (/\b(and|&)\b/.test(text) && /\b(rooms?|circuits?|appliances?)\b/.test(text)
    && /\b(no power|out|dead|not working|tripping)\b/.test(text)) {
    return 2;
  }

  return 1;
}

export function hasPriceConcern(issue?: string, flag?: boolean): boolean {
  if (flag === true) return true;
  return PRICE_CONCERN_HINTS.test(issue ?? "");
}

export function buildBookingWorkItems(
  issue?: string,
  opts: BookingLineOptions = {},
): BookingWorkItem[] {
  const items: BookingWorkItem[] = [
    { description: DEFAULT_BOOKING_LINE_NAME, quantity: 1, unitPrice: 0 },
  ];
  const issueText = (issue ?? "").trim();

  if (isTroubleshootingIssue(issueText)) {
    const level = troubleshootLevel(issueText);
    items.push({
      description: level === 2 ? TROUBLESHOOT_LEVEL_2 : TROUBLESHOOT_LEVEL_1,
      quantity: 1,
      unitPrice: 0, // price book supplies the real amount
    });
  } else if (
    issueText &&
    issueText.toLowerCase() !== DEFAULT_BOOKING_LINE_NAME.toLowerCase()
  ) {
    items.push({ description: issueText, quantity: 1, unitPrice: 0 });
  }

  // Discount is applied after price-book match (needs Service Fee amount).
  void opts;
  return items;
}

/**
 * Match work items to the price book and add them to the estimate via gateway.
 * Returns names of lines actually written (for logs / tests).
 */
export async function attachBookingLineItems(
  estimateUuid: string,
  issue?: string,
  opts: BookingLineOptions = {},
): Promise<string[]> {
  const workItems = buildBookingWorkItems(issue, opts);
  let matched = await matchLineItems(workItems);

  // Prefer exact catalog names for troubleshoot levels if fuzzy match drifted.
  matched = await ensureExactCatalogNames(matched);

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

  if (hasPriceConcern(issue, opts.priceConcern)) {
    const fee = await resolveServiceFeeAmount(matched);
    if (fee > 0) {
      matched.push({
        description: SERVICE_FEE_DISCOUNT_NAME,
        quantity: 1,
        unitPrice: Math.round((fee / 2) * 100) / 100,
        match: null,
      });
    }
  }

  const written: string[] = [];
  for (let i = 0; i < matched.length; i++) {
    const { item } = buildLineItem(matched[i], i);
    // Discount lines must be fixed-discount kind even without a catalog match.
    if (/discount/i.test(item.name) || /discount/i.test(item.description ?? "")) {
      item.kind = "fixed discount";
    }
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

async function ensureExactCatalogNames(
  matched: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    match: Awaited<ReturnType<typeof findBestMatch>>;
  }>,
) {
  const out = [];
  for (const row of matched) {
    if (
      row.description === TROUBLESHOOT_LEVEL_1 ||
      row.description === TROUBLESHOOT_LEVEL_2 ||
      row.description === DEFAULT_BOOKING_LINE_NAME
    ) {
      const exact = await findBestMatch(row.description, 0.5);
      if (exact && exact.exact) {
        out.push({ ...row, match: exact });
        continue;
      }
      // Fallback: any high-score name match on the exact catalog title.
      if (exact && normalize(exact.item.name) === normalize(row.description)) {
        out.push({ ...row, match: { ...exact, exact: true } });
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

async function resolveServiceFeeAmount(
  matched: Array<{
    description: string;
    match: Awaited<ReturnType<typeof findBestMatch>>;
  }>,
): Promise<number> {
  for (const row of matched) {
    if (
      row.description === DEFAULT_BOOKING_LINE_NAME ||
      normalize(row.match?.item.name ?? "") === normalize(DEFAULT_BOOKING_LINE_NAME)
    ) {
      if (row.match?.item.price && row.match.item.price > 0) {
        return row.match.item.price;
      }
    }
  }
  const fee = await findBestMatch(DEFAULT_BOOKING_LINE_NAME, 0.5);
  return fee?.item.price && fee.item.price > 0 ? fee.item.price : 79;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
