/**
 * Thumbtack Agent — polls HCP for new Thumbtack leads, auto-scopes via RAG,
 * and notifies Carter via Slack + ntfy.
 *
 * Run:  npm run thumbtack   (long-running; PM2: grizzly-thumbtack)
 *
 * Polls HCP's get_recently_viewed every POLL_MS (default 2 min), filters for
 * Thumbtack-sourced jobs, runs each through the RAG scoping pipeline, and
 * sends notifications.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scopeLead, type ScopingResult } from "./scoper.js";
import { notifyNewLead, notifyError } from "./notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const SEEN_FILE = path.join(DATA_DIR, "seen-thumbtack.json");

const POLL_MS = parseInt(process.env.THUMBTACK_POLL_MS || "120000", 10); // 2 min
const HCP_MCP_URL = process.env.HCP_MCP_URL || "http://127.0.0.1:7332/";
const HCP_MCP_TOKEN = process.env.HCP_MCP_TOKEN || "";

// ── MCP Client (same pattern as src/hcp/mcp-client.ts) ────────────────

let clientPromise: Promise<Client> | null = null;

function getClient(): Promise<Client> {
  if (clientPromise) return clientPromise;
  if (!HCP_MCP_TOKEN) throw new Error("HCP_MCP_TOKEN required");
  clientPromise = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(HCP_MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${HCP_MCP_TOKEN}` } },
    });
    const client = new Client({ name: "grizzly-thumbtack", version: "1.0.0" });
    await client.connect(transport);
    return client;
  })().catch((e) => {
    clientPromise = null;
    throw new Error(`HCP MCP connect failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  return clientPromise;
}

async function hcpCall(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const client = await getClient();
  const res: any = await client.callTool({ name, arguments: args });
  const text: string = res?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
}

// ── Seen tracker ──────────────────────────────────────────────────

async function loadSeen(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(SEEN_FILE, "utf-8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveSeen(seen: Set<string>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SEEN_FILE, JSON.stringify([...seen], null, 2));
}

// ── Thumbtack detection ───────────────────────────────────────────

interface RecentEntry {
  id: string;
  type: "customer" | "job" | "estimate" | "invoice";
  display_name?: string;
}

async function pollRecent(): Promise<RecentEntry[]> {
  const data = await hcpCall("get_recently_viewed");
  // The response shape varies — extract entries from whatever structure HCP returns
  const entries: RecentEntry[] = [];
  const all = data?.data ?? data?.results ?? [];
  for (const item of all) {
    entries.push({
      id: item.id || item.uuid || "",
      type: item.type || item.entity_type || "unknown",
      display_name: item.display_name || item.name || "",
    });
  }
  return entries;
}

async function isThumbtackJob(jobId: string): Promise<boolean> {
  try {
    const job = await hcpCall("get_job_data", { job_id: jobId });
    const source = job?.source ?? job?.lead_source ?? "";
    const name = job?.customer?.display_name ?? job?.customer?.name ?? "";
    const notes = job?.notes ?? "";
    const combined = `${source} ${name} ${notes}`.toLowerCase();
    return combined.includes("thumbtack");
  } catch {
    return false;
  }
}

// ── Main loop ─────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log("[thumbtack] Agent starting — polling every", POLL_MS / 1000, "s");
  console.log("[thumbtack] HCP MCP:", HCP_MCP_URL);

  const seen = await loadSeen();

  while (true) {
    try {
      const recent = await pollRecent();
      const jobs = recent.filter((e) => e.type === "job" || e.type === "estimate");

      for (const entry of jobs) {
        if (seen.has(entry.id)) continue;

        // Check if it's a Thumbtack lead
        const isTT = await isThumbtackJob(entry.id);
        if (!isTT) {
          seen.add(entry.id); // Don't re-check non-Thumbtack jobs
          continue;
        }

        console.log(`[thumbtack] New Thumbtack lead: ${entry.display_name} (${entry.id})`);

        // Get full details
        const job = await hcpCall("get_job_data", { job_id: entry.id });
        const customerName = job?.customer?.display_name ?? job?.customer?.name ?? entry.display_name;
        const message = job?.notes ?? job?.description ?? "";
        const services: string[] = [];

        // Scope via RAG
        let scoping: ScopingResult;
        try {
          scoping = await scopeLead(message || `New lead from ${customerName}`);
        } catch (err) {
          console.error("[thumbtack] RAG scoping failed:", err);
          scoping = {
            questions: ["Could you describe the work needed?"],
            estimateRange: "Pending scoping",
            servicesIdentified: [],
            raw: "",
          };
        }

        // Notify
        await notifyNewLead({
          customerName,
          message,
          servicesIdentified: scoping.servicesIdentified,
          estimateRange: scoping.estimateRange,
          jobId: entry.id,
        });

        seen.add(entry.id);
        await saveSeen(seen);
        console.log(`[thumbtack] Processed: ${customerName} — ${scoping.estimateRange}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[thumbtack] Poll error:", msg);
      await notifyError("poll cycle failed", msg).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

run().catch((err) => {
  console.error("[thumbtack] Fatal:", err);
  process.exit(1);
});
