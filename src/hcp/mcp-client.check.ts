/**
 * Smoke check against a LIVE daemon. Run only with the daemon up and env set:
 *   HCP_MCP_TOKEN=... HCP_MCP_URL=http://127.0.0.1:7332/ npx tsx src/hcp/mcp-client.check.ts
 * Verifies the wrapper can reach the daemon and round-trip a read (search_customer).
 */
import assert from "node:assert/strict";
import { searchCustomer } from "./mcp-client.js";

const res = await searchCustomer("ZZ Definitely No Such Customer 9999");
assert.ok(res === null || typeof res.id === "string", "searchCustomer returns null or a customer with an id");
console.log("✓ mcp-client smoke check passed — daemon reachable, search_customer round-trips");
