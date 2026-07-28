/**
 * Logic check for the HCP auth preflight.
 *
 * Verifies the contract:
 *   - checkHcpAuth is exported with the right shape (never-throws, carries via)
 *   - preflight-cli.ts contains the exact marker literal
 *   - the marker appears nowhere in the repo except the intentional printers
 *     and this check file
 *   - running the CLI as a subprocess either exits 0 with no marker (live
 *     session ok), or exits non-zero with the exact marker line on its own
 *     line followed by a space and a non-empty detail
 *
 * Both subprocess outcomes are valid — we are verifying the plumbing, not the
 * live session. We assert the invariant that matches the observed outcome.
 *
 * The CLI runs in a child process (never in-process) because the daemon path
 * imports the MCP SDK, which leaves TCP handles open that prevent Node from
 * exiting. The child always calls process.exit() itself; the subprocess timeout
 * is a backstop only.
 *
 * Run: npx tsx src/hcp/preflight-auth.check.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const MARKER = "HCP_AUTH_PREFLIGHT_FAIL";

async function main(): Promise<void> {
  // ─── 1. Source-level shape checks ────────────────────────────────────────
  const authSrc = readFileSync(resolve(__dirname, "preflight-auth.ts"), "utf-8");
  assert.ok(
    /export\s+async\s+function\s+checkHcpAuth\s*\(\s*\)/.test(authSrc),
    "checkHcpAuth is exported from preflight-auth.ts"
  );
  assert.ok(
    authSrc.includes('"daemon" | "cookies"'),
    "PreflightAuthResult.via is typed as daemon | cookies"
  );
  assert.ok(
    /return\s*\{\s*ok:\s*false,\s*via,\s*detail:\s*message\s*\}/.test(authSrc),
    "checkHcpAuth catches errors and returns { ok: false, via, detail } rather than throwing"
  );

  const cliSrc = readFileSync(resolve(__dirname, "preflight-cli.ts"), "utf-8");
  assert.ok(
    cliSrc.includes(MARKER),
    "preflight-cli.ts contains the exact marker literal"
  );
  assert.ok(
    /process\.exitCode\s*=\s*1/.test(cliSrc),
    "preflight-cli.ts sets process.exitCode = 1 on the failure path (crash-free exit on Windows)"
  );
  assert.ok(
    !/process\.exit\(\s*\d/.test(cliSrc),
    "preflight-cli.ts must NOT call process.exit(N) directly — it trips libuv's UV_HANDLE_CLOSING assertion after fetch on Windows and corrupts the exit code. Use process.exitCode + return."
  );
  console.log("✓ Source shape: checkHcpAuth exported, never-throws; CLI has marker + exit codes");

  // ─── 2. Marker uniqueness — the string is the contract ───────────────────
  // The marker may appear only where it is intentionally printed or asserted.
  const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".pi-subagents"]);
  const occurrences: Record<string, number> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = resolve(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(entry)) continue;
      const txt = readFileSync(p, "utf-8");
      const n = txt.split(MARKER).length - 1;
      if (n > 0) occurrences[relative(repoRoot, p).replace(/\\/g, "/")] = n;
    }
  }
  walk(repoRoot);

  const allowed = new Set([
    "src/hcp/preflight-cli.ts",
    "src/hcp/sync-catalog.ts",
    "src/hcp/sync-estimates.ts",
    "src/hcp/preflight-auth.check.ts",
  ]);
  const files = Object.keys(occurrences).sort();
  for (const f of files) {
    assert.ok(
      allowed.has(f),
      `marker "${MARKER}" appears unexpectedly in ${f} (allowed: ${[...allowed].join(", ")})`,
    );
  }
  for (const required of [
    "src/hcp/preflight-cli.ts",
    "src/hcp/sync-catalog.ts",
    "src/hcp/sync-estimates.ts",
  ]) {
    assert.ok(
      (occurrences[required] ?? 0) >= 1,
      `marker must appear in ${required}`,
    );
  }
  console.log(`✓ Marker uniqueness: occurrences = ${JSON.stringify(occurrences)}`);

  // ─── 3. Subprocess: CLI exit-code + marker contract ──────────────────────
  // Either outcome is valid. Assert the matching invariant honestly.
  const cliPath = resolve(__dirname, "preflight-cli.ts");
  const tsxBin = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  let stdout = "";
  let exitCode: number | null = null;
  try {
    const out = execFileSync(process.execPath, [tsxBin, cliPath], {
      cwd: repoRoot,
      timeout: 20000,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    stdout = out.toString();
    exitCode = 0;
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer | string; status?: number; code?: string };
    stdout = typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString() ?? "");
    exitCode = typeof err.status === "number" ? err.status : null;
  }

  assert.ok(
    exitCode !== null && Number.isInteger(exitCode),
    `CLI produced an integer exit code (got ${String(exitCode)})`,
  );

  if (exitCode === 0) {
    assert.ok(
      !stdout.includes(MARKER),
      "exit 0 must not emit the failure marker",
    );
    console.log("✓ CLI exited 0 (live session ok) — no marker emitted");
  } else {
    assert.ok(
      stdout.includes(MARKER),
      `exit ${exitCode} must emit the exact marker "${MARKER}"`,
    );
    const markerLine = stdout
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${MARKER} `));
    assert.ok(
      markerLine,
      `marker must start its own line, followed by a space (got stdout: ${stdout.slice(0, 200)})`,
    );
    assert.ok(
      markerLine!.length > `${MARKER} `.length,
      "marker line must carry a non-empty detail after the space",
    );
    console.log(
      `✓ CLI exited ${exitCode} — marker line present: "${markerLine!.slice(0, 100)}"`,
    );
  }

  console.log("\nAll preflight-auth checks passed.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗", err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
