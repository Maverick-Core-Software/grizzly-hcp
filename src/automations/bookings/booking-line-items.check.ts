/**
 * Offline checks for booking line-item helpers.
 *   npx tsx src/automations/bookings/booking-line-items.check.ts
 */
import assert from "node:assert/strict";
import {
  buildBookingWorkItems,
  DEFAULT_BOOKING_LINE_NAME,
  hasPriceConcern,
  isTroubleshootingIssue,
  TROUBLESHOOT_LEVEL_1,
  TROUBLESHOOT_LEVEL_2,
  troubleshootLevel,
} from "./booking-line-items.js";

// Always includes the default visit fee.
{
  const items = buildBookingWorkItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].description, DEFAULT_BOOKING_LINE_NAME);
  assert.equal(items[0].quantity, 1);
}

// Non-troubleshoot install becomes free-text second work item.
{
  const items = buildBookingWorkItems(
    "Install three new pendant light locations in the kitchen",
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].description, DEFAULT_BOOKING_LINE_NAME);
  assert.match(items[1].description, /pendant/i);
  assert.equal(isTroubleshootingIssue("Install three new pendant light locations"), false);
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

// Troubleshooting → Service Fee + Level 1 (single appliance).
{
  const issue = "Breaker keeps popping after converting a 3-prong outlet to 4-prong for a new stove";
  assert.equal(isTroubleshootingIssue(issue), true);
  assert.equal(troubleshootLevel(issue), 1);
  const items = buildBookingWorkItems(issue);
  assert.equal(items.length, 2);
  assert.equal(items[0].description, DEFAULT_BOOKING_LINE_NAME);
  assert.equal(items[1].description, TROUBLESHOOT_LEVEL_1);
}

// Multiple systems → Level 2.
{
  const issue = "Outdoor outlet and attic light switch both stopped working";
  assert.equal(isTroubleshootingIssue(issue), true);
  assert.equal(troubleshootLevel(issue), 2);
  const items = buildBookingWorkItems(issue);
  assert.equal(items[1].description, TROUBLESHOOT_LEVEL_2);
}

// Whole-home / multiple circuits → Level 2.
{
  assert.equal(troubleshootLevel("Multiple circuits keep tripping in the house"), 2);
  assert.equal(troubleshootLevel("Half the house has no power"), 2);
}

// Price concern detection.
{
  assert.equal(hasPriceConcern("breaker tripping", false), false);
  assert.equal(hasPriceConcern("breaker tripping", true), true);
  assert.equal(hasPriceConcern("they said the service fee is too expensive"), true);
}

console.log("✓ booking-line-items self-check passed");
