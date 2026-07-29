/**
 * Smoke check against a LIVE daemon. Run only with the daemon up and env set:
 *   HCP_MCP_TOKEN=... HCP_MCP_URL=http://127.0.0.1:7332/ npx tsx src/hcp/mcp-client.check.ts
 * Verifies the wrapper can reach the daemon and round-trip a read (search_customer).
 */
import assert from "node:assert/strict";
import { searchCustomer, closeClient } from "./mcp-client.js";

try {
  const res = await searchCustomer("ZZ Definitely No Such Customer 9999");
  assert.ok(res === null || typeof res.id === "string", "searchCustomer returns null or a customer with an id");
  console.log("✓ mcp-client smoke check passed — daemon reachable, search_customer round-trips");
} finally {
  // Without this the transport keeps its socket and the process hangs forever
  // on success — the exact leak mcp-close.check.ts guards. Never process.exit()
  // here: a forced exit after fetch trips libuv's UV_HANDLE_CLOSING on Windows.
  await closeClient();
}
