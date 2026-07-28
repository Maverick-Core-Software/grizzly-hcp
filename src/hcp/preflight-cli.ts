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
 */
import { checkHcpAuth } from "./preflight-auth.js";

async function main(): Promise<void> {
  const r = await checkHcpAuth();
  if (r.ok) {
    console.log(`HCP auth ok — ${r.detail}`);
    return;
  }
  console.log(`HCP auth FAILED — ${r.detail}`);
  console.log(`HCP_AUTH_PREFLIGHT_FAIL ${r.detail}`);
  process.exitCode = 1;
}

// checkHcpAuth never throws, but defend the contract regardless — any
// unexpected throw still surfaces as the marker line and a non-zero exit.
main().catch((err) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.log(`HCP auth FAILED — ${detail}`);
  console.log(`HCP_AUTH_PREFLIGHT_FAIL ${detail}`);
  process.exitCode = 1;
});
