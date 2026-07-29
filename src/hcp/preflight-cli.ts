/**
 * Standalone entry point for the HCP auth preflight.
 *
 * Prints a one-line human summary and exits:
 *   - 0  on success
 *   - 1  on failure, with a line beginning exactly `HCP_AUTH_PREFLIGHT_FAIL `
 *        followed by the detail
 *
 * The marker string is the contract with the Hermes monitor, which greps the
 * journal for it. It must appear verbatim and nowhere else in the repo outside
 * the intentional printers and the check that asserts it.
 *
 * Run: npm run preflight-auth
 *
 * ponytail: exits via `process.exitCode` + return, not `process.exit()`. A
 * forced exit after fetch trips libuv's `UV_HANDLE_CLOSING` assertion on
 * Windows (undici keepalive + tsx's esbuild service are mid-close), which on
 * the hard-crash branch returns the NT status 0xC0000409 instead of 1 and
 * breaks the monitor's exit-code contract. Natural drain closes those handles
 * cleanly; `list-templates.ts` already exits this way. The run still finishes
 * in ~1s because the loop empties as soon as the probe resolves.
 *
 * That drain only happens if nothing is still holding the loop open, which is
 * why every path calls `closeHcp()`. On the daemon path the MCP transport keeps
 * a socket open indefinitely, and without the close this process printed its
 * success line and then hung forever.
 */
import { checkHcpAuth } from "./preflight-auth.js";
import { closeHcp } from "./client.js";

async function main(): Promise<void> {
  const r = await checkHcpAuth();
  if (r.ok) {
    console.log(`HCP auth ok — ${r.detail}`);
    await closeHcp();
    return;
  }
  console.log(`HCP auth FAILED — ${r.detail}`);
  console.log(`HCP_AUTH_PREFLIGHT_FAIL ${r.detail}`);
  process.exitCode = 1;
  await closeHcp();
}

// checkHcpAuth never throws, but defend the contract regardless — any
// unexpected throw still surfaces as the marker line and a non-zero exit.
main().catch(async (err) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.log(`HCP auth FAILED — ${detail}`);
  console.log(`HCP_AUTH_PREFLIGHT_FAIL ${detail}`);
  process.exitCode = 1;
  await closeHcp();
});
