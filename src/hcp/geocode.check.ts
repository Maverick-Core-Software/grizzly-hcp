/**
 * Self-check for the Census geocoder. No test framework — run with:
 *   npx tsx src/hcp/geocode.check.ts
 *
 * Network-dependent assertions are marked with [NETWORK] in the assertion
 * message so a reader can tell they need connectivity.
 */
import assert from "node:assert/strict";
import { resolveAddress } from "./geocode.js";

// 1. [NETWORK] Real full address resolves with expected state and 5-digit zip.
const full = await resolveAddress("1600 Pennsylvania Avenue NW, Washington, DC");
assert.ok(full !== null, "[NETWORK] full address should resolve");
if (full) {
  assert.equal(full.state, "DC", "[NETWORK] state should be DC");
  assert.ok(/^\d{5}$/.test(full.zip ?? ""), "[NETWORK] zip should be 5-digit");
  assert.ok(full.street.length > 0, "[NETWORK] street should be non-empty");
  assert.ok(typeof full.latitude === "number" && typeof full.longitude === "number",
    "[NETWORK] lat/lng should be numbers");
}

// 2. [NETWORK] Street+city input with no zip still resolves to a state and zip.
const partial = await resolveAddress("100 Main St, Dallas TX");
assert.ok(partial !== null, "[NETWORK] street+city should resolve");
if (partial) {
  assert.equal(partial.state, "TX", "[NETWORK] state should be TX");
  assert.ok(/^\d{5}$/.test(partial.zip ?? ""), "[NETWORK] zip should be 5-digit even when not supplied");
}

// 3. [NETWORK] Nonsense input returns null.
const nonsense = await resolveAddress("zzzxyzqrx none such place, nowhere");
assert.equal(nonsense, null, "[NETWORK] nonsense address should return null");

// 4. Empty string returns null without issuing a network request.
const empty = await resolveAddress("");
assert.equal(empty, null, "empty string should return null immediately");

console.log("geocode.check OK");
