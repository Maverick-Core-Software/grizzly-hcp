/**
 * Regression check: the daemon path must terminate on its own.
 *
 * With HCP_VIA_MCP=true, hcpGet routes through mcp-client.ts, which holds a
 * StreamableHTTPClientTransport open in a module-level singleton. The sync
 * entry points and the preflight all end their success path by returning and
 * letting the event loop drain — never process.exit() — so a transport left
 * open means the process prints its success output and then hangs forever.
 * Both AIWA units are Type=oneshot with TimeoutStartUSec=infinity, so that
 * wedges the unit in `activating` and blocks the following weekly fire.
 *
 * This check spawns preflight-cli.ts against a stub daemon and asserts the
 * child exits BY ITSELF, quickly, with code 0. It is the guard that stops the
 * leak coming back: delete the closeHcp() calls and this check hangs and fails.
 *
 * ponytail: the stub speaks only the three exchanges the SDK client actually
 * performs against a stateless server (initialize, the initialized
 * notification, one tools/call) and answers plain JSON rather than SSE. Ceiling
 * — it is not a conformant MCP server and must not be reused as one. Upgrade
 * path: run the real daemon in-process if a test ever needs tool semantics
 * rather than transport lifetime.
 *
 * Run: npx tsx src/hcp/mcp-close.check.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = resolve(__dirname, "preflight-cli.ts");
const tsxBin = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

/** Must match PROBE_PATH in preflight-auth.ts. */
const PROBE_PATH = "/alpha/pricebook/industries";

/** How long the child gets to exit on its own before we call it hung. */
const EXIT_BUDGET_MS = 10_000;

function startStubDaemon(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    // Fidelity matters here: the leak this check guards against is a socket the
    // client never lets go of. A stub that declines the standalone SSE stream
    // and lets idle sockets time out cannot reproduce it — the child exits
    // cleanly either way and the check silently guards nothing. So accept the
    // GET stream and hold it open, exactly as the real daemon does.
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": open\n\n");
      return; // deliberately never ended
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let msg: { id?: unknown; method?: string; params?: { name?: string } };
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        res.writeHead(400).end();
        return;
      }

      // A notification carries no id and takes no response body.
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };

      if (msg.method === "initialize") {
        reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-hcp-mcp", version: "0.0.0" },
        });
        return;
      }

      if (msg.method === "tools/call" && msg.params?.name === "hcp_api_get") {
        reply({
          content: [{ type: "text", text: JSON.stringify({ object: "list", data: [] }) }],
        });
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `stub does not implement ${String(msg.method)}` },
      }));
    });
  });

  // Never hang up on an idle keep-alive socket — otherwise the stub, not the
  // code under test, is what lets the child's event loop drain.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ok({ url: `http://127.0.0.1:${port}/`, server });
    });
  });
}

interface ChildOutcome {
  exitedOnItsOwn: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
}

function runPreflightAgainst(url: string): Promise<ChildOutcome> {
  return new Promise((ok) => {
    const started = Date.now();
    const child = spawn(process.execPath, [tsxBin, cliPath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HCP_VIA_MCP: "true",
        HCP_MCP_URL: url,
        HCP_MCP_TOKEN: "stub-token-not-a-secret",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

    // The whole point of the check: did it end without being killed?
    let exitedOnItsOwn = true;
    const hang = setTimeout(() => {
      exitedOnItsOwn = false;
      child.kill("SIGKILL");
    }, EXIT_BUDGET_MS);

    child.on("close", (code, signal) => {
      clearTimeout(hang);
      ok({ exitedOnItsOwn, code, signal, elapsedMs: Date.now() - started, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const { url, server } = await startStubDaemon();
  console.log(`Stub daemon listening on ${url}`);

  let outcome: ChildOutcome;
  try {
    outcome = await runPreflightAgainst(url);
  } finally {
    // The held-open SSE stream means close() alone would never resolve.
    server.closeAllConnections();
    server.close();
  }

  console.log(
    `Child: exitedOnItsOwn=${outcome.exitedOnItsOwn} code=${String(outcome.code)} ` +
    `signal=${String(outcome.signal)} elapsed=${outcome.elapsedMs}ms`,
  );
  if (outcome.stdout.trim()) console.log(`  stdout: ${outcome.stdout.trim()}`);
  if (outcome.stderr.trim()) console.log(`  stderr: ${outcome.stderr.trim().slice(0, 500)}`);

  assert.ok(
    outcome.exitedOnItsOwn,
    `preflight-cli did not exit within ${EXIT_BUDGET_MS}ms on the daemon path — the MCP ` +
    `transport is holding the event loop open. This is the exact defect closeHcp() fixes.`,
  );
  assert.equal(outcome.code, 0, `expected exit code 0, got ${String(outcome.code)}`);
  assert.ok(
    outcome.stdout.includes("authenticated via daemon"),
    `expected the daemon route to be reported, got: ${outcome.stdout.slice(0, 200)}`,
  );
  assert.ok(
    !outcome.stdout.includes("HCP_AUTH_PREFLIGHT_FAIL"),
    "a successful probe must not emit the failure marker",
  );

  console.log(`\n✓ Daemon path exits on its own in ${outcome.elapsedMs}ms with code 0.`);
  console.log("All mcp-close checks passed.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗", err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
