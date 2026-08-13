/**
 * Offline checks for booking line-item helpers.
 *   npx tsx src/automations/bookings/booking-line-items.check.ts
 */
import assert from "node:assert/strict";
import {
  buildBookingWorkItems,
  DEFAULT_BOOKING_LINE_NAME,
} from "./booking-line-items.js";

// Always includes the default visit fee.
{
  const items = buildBookingWorkItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].description, DEFAULT_BOOKING_LINE_NAME);
  assert.equal(items[0].quantity, 1);
}

// Issue becomes a second work item.
{
  const items = buildBookingWorkItems(
    "Outdoor outlet and attic light switch both stopped working",
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].description, DEFAULT_BOOKING_LINE_NAME);
  assert.match(items[1].description, /Outdoor outlet/i);
}

// Blank / whitespace issue does not duplicate.
{
  const items = buildBookingWorkItems("   ");
  assert.equal(items.length, 1);
}

// Same name as default is not duplicated.
{
  const items = buildBookingWorkItems(DEFAULT_BOOKING_LINE_NAME);
  assert.equal(items.length, 1);
}

console.log("✓ booking-line-items self-check passed");
