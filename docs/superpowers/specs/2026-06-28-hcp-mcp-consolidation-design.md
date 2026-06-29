# HCP MCP Consolidation — Design

**Status:** Draft for review
**Date:** 2026-06-28
**Repos touched:** `housecall-pro-mcp` (Infrastructure), `grizzly-hcp` (Active)

---

## Goal

Retire grizzly-hcp's hand-rolled Housecall Pro client (`src/hcp/*`) and route **all** HCP access — reads and writes — through the `housecall-pro-mcp` server, run as a single shared daemon. One authenticated browser session serves every consumer.

## Why

Two independent HCP clients exist today:

- **grizzly-hcp** — a cookie/CSRF API client against `pro.housecallpro.com`, auth via `npm run login`. ~13 hand-rolled operations.
- **housecall-pro-mcp** — 77 MCP tools over a persisted Playwright browser session against `app.housecallpro.com`, no API key. Stdio-only.

They hit the **same internal HCP API** (e.g. grizzly's `addLineItem` and the MCP's `add_line_item` both POST `/alpha/jobs/{id}/line_items`). Maintaining two auth flows and two client surfaces for the same backend is duplicated, drift-prone work. The MCP is the canonical layer; grizzly's client should go.

## Decisions already made (with the user)

1. **Full retirement** of `src/hcp/*`, not a reads-only consolidation. This requires porting 4 missing write operations into the MCP first.
2. **Persistent MCP daemon over HTTP** (vs. file-lock-serialized subprocess spawns, or collapsing the pipeline into one process). Rationale: there are **three** independent HCP consumers — `mav-slack`, `watch-email` (+ its spawned children), and the ad-hoc `npm run estimate` CLI — plus a future CodexForge consumer. A daemon is the only model where all of them share one warm, authenticated session; the CLI cannot be collapsed into a single process, and cross-process file locks on Windows are fragile.

---

## The 4 missing write tools

The MCP today is read-heavy + partial-write. It already covers `add_line_item`, `bulk_update_line_items`, `set_deposit`, `apply_estimate_template`, `email_estimate`, and customer search (`global_search`). It is missing exactly the four operations that form the spine of grizzly's `commit-estimate.ts` write workflow:

| New MCP tool | Method | Endpoint | Encoding | Notes |
|---|---|---|---|---|
| `create_customer` | POST | `/alpha/customers` | JSON | Split `name`→`first_name`/`last_name`; `phone`→`phone_number`; seed one empty address. Returns `{id, name, addressId, address}`. |
| `create_estimate` | POST | `/pro/add_estimate/customer/{customerId}` | **form-urlencoded** | `addressId`→`service_address_uuid`, plus `is_virtual:false`. Returns `{estimateId, uuid}`. |
| `assign_technician` | PUT | `/api/estimates/{apiUuid}/assignees` | JSON | **Two-step:** GET `/api/estimates/{estimateUuid}` first to derive `apiUuid` (`est.uuid ?? estimateUuid`); then PUT `{service_pro_uuids, notify_pro:true}`. The `/api/` namespace uses a different UUID than `/alpha/`. This lookup MUST be preserved. |
| `create_pricebook_item` | POST | `/alpha/pricebook/services` | **form-urlencoded** | Prices in cents; many static fields (`flat_rate_enabled:false`, `track_material_usage:true`, mirrored `laborRatesCost/Price`, etc.); `pricebook_category_uuid` optional → look up a default via existing `list_pricebook_categories` if omitted. Returns `{uuid, name, …, categoryUuid}`. |

Exact field maps are taken verbatim from grizzly's `src/hcp/estimates.ts` and `src/hcp/price-book.ts`.

**Boundary:** grizzly's `createPriceBookItem` also appends to a local CSV and indexes the item in RAG. **Those side effects stay in grizzly** as a post-step after the MCP call returns. The MCP tool only performs the HCP API write.

---

## Architecture

```
   mav-slack ─────────┐
   watch-email ───────┤    HTTP (localhost:<port>, bearer token)
     └─ from-email ───┤
   estimate CLI ──────┼──────────────────────────────▶  housecall-pro-mcp DAEMON  (PM2 service)
   (CodexForge, later)┘                                    │  Streamable HTTP transport
                                                           │  internal request mutex (serial)
                                                           │  ONE Playwright browser session
                                                           ▼
                                                   HCP internal API
                                              (app/pro.housecallpro.com)
```

- The daemon owns the only browser session. Consumers are thin HTTP MCP clients — no browser, no cookies, no `npm run login`.
- The MCP serializes tool calls internally, so "the browser page is a serial resource" stops being any consumer's problem.
- Stdio transport is retained so the MCP still works as a normal MCP-client child (e.g. CodexForge, Claude Desktop) where that's wanted.

---

## Component work breakdown

### A. housecall-pro-mcp

- **A1 — Form-urlencoded support.** `client.request()` only sends JSON today. Add: when a caller marks a body as form-encoded, set `Content-Type: application/x-www-form-urlencoded` and encode via `URLSearchParams` inside the `page.evaluate` fetch. `create_estimate` and `create_pricebook_item` need this.
- **A2 — Request serialization.** The client has no mutex; concurrent calls share one Playwright page and can corrupt state. Add a simple promise-chain mutex around `request()` so calls run one-at-a-time. (`ponytail:` global serial lock — fine for a single-tenant HCP account; upgrade path is a small concurrency pool if throughput ever matters.)
- **A3 — Four write tools.** Register `create_customer`, `create_estimate`, `assign_technician`, `create_pricebook_item` following the existing `add_line_item` / `set_deposit` pattern (`server.tool(name, desc, zodSchema, handler)`), using the exact endpoints/payloads above.
- **A4 — Streamable HTTP transport.** Add `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk@1.29.0` exports it) bound to `127.0.0.1:<HCP_MCP_PORT>`, gated by a bearer token from env (`HCP_MCP_TOKEN`). Keep `StdioServerTransport` available; select via env (e.g. `HCP_MCP_TRANSPORT=http|stdio`).
- **A5 — PM2 daemon.** Add a PM2 ecosystem entry (`housecall-pro-mcp`) running the HTTP transport with a long/disabled idle-close (`HCP_BROWSER_IDLE_MS` high or sentinel for never-close while the daemon is up). First-run login remains the one-time `HCP_HEADLESS=false` interactive step.

### B. grizzly-hcp

- **B1 — MCP client wrapper** (`src/hcp/mcp-client.ts`, new). Connects to the daemon over HTTP via `@mastra/mcp` `MCPClient` (url server). Exposes typed wrappers with the **same signatures** as the retired functions (`createCustomer`, `createEstimate`, `addLineItem`, `assignTechnician`, `setDeposit`, `createPriceBookItem`, `searchCustomer`, the reads), so consumers change by import path, not call shape.
- **B2 — Agent read tools.** `src/agent/tools/reads/hcp.ts` calls route through the MCP wrapper instead of `hcpGet`.
- **B3 — Write workflow.** `src/agent/workflows/private-hcp-writes/commit-estimate.ts` swaps its underlying HCP calls to the wrapper. Idempotency keys + audit logging are unchanged — only the bottom layer moves.
- **B4 — Grizzly-side bookkeeping.** After `createPriceBookItem` returns from the MCP, grizzly still does its CSV append + RAG index. This logic moves out of the deleted `price-book.ts` into `commit-estimate.ts` (where custom pricebook items are created), keeping the MCP wrapper a thin HCP pass-through with no local side effects.
- **B5 — Trigger scripts.** `from-chat.ts`, `from-email.ts`, `from-proposal.ts` keep their spawn/CLI trigger model; their HCP calls now resolve through the HTTP wrapper (no browser per child).
- **B6 — Delete** `src/hcp/client.ts`, `estimates.ts`, `price-book.ts`, `auth.ts`; remove the `login` npm script. (Retain in git history.)

---

## Data flow — estimate build (after cutover)

1. Slack `[ESTIMATE_READY]{…}` → spawns `from-chat.ts` (unchanged trigger).
2. `from-chat.ts` resolves customer: wrapper `searchCustomer` → MCP `global_search`; if absent, `createCustomer` → MCP `create_customer`.
3. Builds line items (RAG match / HD pricing — unchanged, grizzly-local).
4. Calls `commitEstimateWorkflow` → wrapper: `create_estimate` → `create_pricebook_item` (per new custom item) → `add_line_item` ×N → `assign_technician` → `set_deposit`.
5. Each wrapper call is one HTTP request to the daemon, serialized onto the single browser session.
6. Workflow logs audit + idempotency as today; returns `{estimateUrl, uuid, unmatched}` to stdout.

---

## Auth consolidation

Single source of truth: the daemon's persisted Playwright session (`~/.hcp-mcp-browser/`). Grizzly's cookie flow and `npm run login` are retired. Session refresh, when it expires, is a one-time `HCP_HEADLESS=false` relaunch of the daemon — documented in a short runbook.

---

## Phased cutover (safety — the live estimate path is never rebuilt blind)

- **Phase 1 — MCP, additive.** A1–A5. Nothing in grizzly changes yet. Verify each new tool against a designated **test customer** via the MCP directly (and existing DRY-RUN paths). Reversible: grizzly still uses `client.ts`.
- **Phase 2 — grizzly reads via MCP**, behind `HCP_VIA_MCP` env flag (default off). `client.ts` still present. Verify agent reads (schedule, jobs, messages).
- **Phase 3 — grizzly writes via MCP**, same flag. Run a full DRY_RUN end-to-end, then one **live estimate to the test customer**, and compare the result to a `client.ts`-built estimate.
- **Phase 4 — flip default on**, delete `src/hcp/*`, remove `npm run login`.

Each phase is independently revertible by the flag until Phase 4.

---

## Error handling

- **Daemon unreachable** → wrapper raises a clear `HCP service unavailable` error; `commit-estimate.ts` already has a `manualRecovery` path that surfaces to the operator.
- **Session expired (401) in daemon** → daemon returns a structured "not logged in" error; runbook says relaunch with `HCP_HEADLESS=false`. Single point of failure is mitigated by PM2 auto-restart + the runbook.
- **Serialization stall** → mutex acquisition has a timeout; a stuck call fails its own request rather than wedging the queue indefinitely.
- **Bearer token mismatch** → 401 from the HTTP transport; consumer logs a config error.

## Testing

- **MCP:** unit test the form-encoding switch; one test per new write tool asserting method + endpoint + encoded payload (mock `client.request` / `page.evaluate`). `ponytail:` one runnable check per non-trivial unit.
- **grizzly:** the existing `DRY_RUN` estimate path exercises the full pipeline without writing; add a wrapper smoke test against the daemon; the Phase 3 live test-customer estimate is the integration gate.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Rebuilding the LIVE estimate path | Phased cutover behind a flag; git history retained; test-customer gate before deletion. |
| Single browser session = SPOF for the whole estimate business | PM2 auto-restart; clear re-login runbook; the daemon is the *only* failure point instead of N scattered ones. |
| Concurrent calls corrupt the browser page | Internal request mutex (A2). |
| `assign_technician` UUID subtlety lost in the port | Two-step GET→`apiUuid` lookup is called out explicitly and carried verbatim. |
| form-urlencoded fields encoded wrong (cents, booleans) | Port field maps verbatim from grizzly; tool-level tests assert the encoded body. |

## Out of scope

- Wiring CodexForge to the daemon (future; the daemon makes it possible).
- `createMaterialItem` and other unused grizzly operations not on the estimate path.
- mav-imessage teardown (grizzly's call, tracked elsewhere).
