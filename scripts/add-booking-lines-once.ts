/**
 * One-shot: attach booking line items to an existing estimate UUID.
 * Usage:
 *   npx tsx scripts/add-booking-lines-once.ts est_xxx "issue description"
 */
import "dotenv/config";
import { attachBookingLineItems } from "../src/automations/bookings/booking-line-items.js";

const uuid = process.argv[2];
const issue = process.argv[3] ?? "";
if (!uuid?.startsWith("est_")) {
  console.error('Usage: npx tsx scripts/add-booking-lines-once.ts est_<uuid> "optional issue"');
  process.exit(2);
}

const written = await attachBookingLineItems(uuid, issue);
console.log(JSON.stringify({ success: true, estimateUuid: uuid, lines: written }));
