# HCP → MCP Write-Path Cutover (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route grizzly-hcp's shared estimate **write spine** (`commit-estimate.ts`, used by both the Slack and email automations) through the persistent housecall-pro-mcp HTTP daemon, behind a reversible `HCP_VIA_MCP` flag, after first fixing the daemon's broken line-item tools and adding a customer-search tool — proven end-to-end by one live estimate to a disposable test customer.

**Architecture:** Two repos. **Repo A** = `C:\Workspace\Infrastructure\housecall-pro-mcp` (the daemon): fix `add_line_item` / `update_line_item` / `bulk_update_line_items` to use HCP's real contract (cents, correct `kind` enum, required fields), and add a `search_customer` tool. **Repo B** = `C:\Workspace\Active\grizzly-hcp` (the consumer): add a thin MCP-client wrapper exposing the **same signatures** as the retired functions, gate it behind `HCP_VIA_MCP`, move the new-pricebook-item CSV/RAG bookkeeping up into `commit-estimate.ts` so the wrapper stays a pure passthrough, and point `commit-estimate.ts` at a gateway module that selects direct-client vs. MCP by the flag.

**Tech Stack:** TypeScript ESM throughout. Repo A: `tsc` build, `@modelcontextprotocol/sdk` (server), `zod`, tests via `node --import tsx --test "test/**/*.test.ts"` (`node:test` + `node:assert`). Repo B: `tsx` (no build step), `@mastra/core`, `uuid`, `zod`, tests via `*.check.ts` self-checks with `node:assert/strict` run by `npx tsx`. The wrapper uses `@modelcontextprotocol/sdk` **client** (`StreamableHTTPClientTransport` + `Client` with a bearer header) — the exact transport proven against this daemon in Plan 1's live gate.

---

## Scope & Decisions

**In scope (Plan 2):**
- **A-side (daemon) fixes:** `add_line_item`, `update_line_item`, `bulk_update_line_items` corrected to HCP's real contract; new `search_customer` tool. Pure body-builders in `write-bodies.ts` with `node:test` unit tests.
- **B-side (grizzly) cutover, flagged:** `src/hcp/mcp-client.ts` wrapper; `src/hcp/gateway.ts` flag-dispatch; CSV/RAG bookkeeping moved into `commit-estimate.ts`; `commit-estimate.ts` routed through the gateway. This covers `from-chat.ts` **and** `from-email.ts` (both call `commitEstimateWorkflow`).
- **Live test-customer gate** with `HCP_VIA_MCP=true`.

**Explicitly deferred to a Phase-4 follow-up plan (NOT this plan):**
- **B2 — agent reads via MCP.** The 5 tools in `src/agent/tools/reads/hcp.ts` hit `/pro/messages`, `/pro/jobs/scheduled`, `/pro/jobs/{id}`, `/pro/jobs?is_active`, `/pro/estimates?customer_id` — endpoints the daemon does not expose. Routing them needs new MCP read tools first.
- **`from-proposal.ts` (`npm run estimate`) migration.** It has a bespoke inline write sequence incl. `applyTemplate`/`listTemplates`, which are not on the verified MCP write spine. Stays on the direct client.
- **B6 — deleting `src/hcp/{client,estimates,price-book,auth}.ts` + the `login` script.** `client.ts` still backs the deferred reads, `from-proposal`, and ~15 export/sync/cleanup scripts. Deletion happens only after read parity exists. **`client.ts` is NOT touched in this plan.**

**Why deviate from the spec's `@mastra/mcp` for B1:** grizzly depends on `@mastra/core` but not `@mastra/mcp`; either way it is one new dependency. We use `@modelcontextprotocol/sdk`'s `Client` instead because Plan 1's live gate already proved that exact client + `StreamableHTTPClientTransport` + bearer header works against this daemon, the wrapper needs only `callTool` (not Mastra's tool-aggregation features), and it keeps the wrapper Mastra-agnostic. Documented deviation; same outcome.

**Branches:** Repo A → new branch `feat/hcp-line-item-fix` off `feat/hcp-write-daemon` (that branch is the repo's de-facto trunk; there is no `main`). Repo B → new branch `feat/hcp-via-mcp` off its current branch. Do not start work on either trunk directly.

**Reversibility:** Everything B-side is gated by `HCP_VIA_MCP` (default off → direct client, unchanged behavior). A-side fixes are strict corrections to already-broken tools (the old payloads are rejected by HCP today), so they cannot regress any working path.

---

## File Structure

**Repo A — `C:\Workspace\Infrastructure\housecall-pro-mcp`:**
- Modify: `src/tools/write-bodies.ts` — add pure builders `buildLineItemBody`, `buildBulkUpdateLineItemsBody`, `buildUpdateLineItemBody`, `deriveServiceType`, and the `LineItemKind` type.
- Modify: `src/tools/jobs.ts` — rewrite `add_line_item`, `update_line_item`, `bulk_update_line_items` to use the builders + correct zod schemas.
- Modify: `src/tools/search.ts` — add `search_customer` tool (or place in a new `registerWriteTools`-adjacent spot; search.ts is the natural home).
- Create: `src/tools/customer-search-body.ts` — pure `buildCustomerSearchParams(name)` query-param builder (kept pure for unit testing).
- Modify: `src/tools/customers.ts`? No — search lives in `search.ts`. Leave customers.ts untouched.
- Create: `test/line-item-bodies.test.ts`, `test/customer-search-body.test.ts`.

**Repo B — `C:\Workspace\Active\grizzly-hcp`:**
- Create: `src/hcp/mcp-client.ts` — MCP wrapper (lazy singleton client + typed functions matching retired signatures).
- Create: `src/hcp/gateway.ts` — re-exports the 7 write-spine functions, selecting `./estimates.js` + `./price-book.js` (direct) or `./mcp-client.js` (MCP) by `HCP_VIA_MCP`.
- Create: `src/hcp/pricebook-bookkeeping.ts` — `recordNewPricebookItem(...)` (CSV append + RAG index), extracted so it runs regardless of which client created the item.
- Modify: `src/agent/workflows/private-hcp-writes/commit-estimate.ts` — import the write-spine functions from `./gateway.js` instead of `../../../hcp/estimates.js` + `../../../hcp/price-book.js`; call `recordNewPricebookItem` after `createPriceBookItem`.
- Create: `src/hcp/mcp-client.check.ts` — wrapper smoke self-check (run against a live daemon).
- Modify: `.env.example` (or create if absent) — document `HCP_VIA_MCP`, `HCP_MCP_URL`, `HCP_MCP_TOKEN`.

---

## Task 1: Fix `add_line_item` (Repo A) — pure body-builder + tool rewrite

**Files:**
- Modify: `C:\Workspace\Infrastructure\housecall-pro-mcp\src\tools\write-bodies.ts`
- Modify: `C:\Workspace\Infrastructure\housecall-pro-mcp\src\tools\jobs.ts:91-109`
- Test: `C:\Workspace\Infrastructure\housecall-pro-mcp\test\line-item-bodies.test.ts`

**Context:** `add_line_item` currently sends `unit_price` in dollars (HCP wants cents), uses an invalid `kind` enum (`service|material|fee|percent_discount|fixed_discount`), and omits `amount`, `taxable`, `material_detail`, `client_side_id`, `expand`, `job_uuid`/`order_index`, and `duration_in_minutes`. HCP rejects it with `400 "Kind is not included in the list"`. The correct contract is grizzly's working `addLineItem` (`C:\Workspace\Active\grizzly-hcp\src\hcp\estimates.ts:75-122`). Mirror it as a pure builder so the body is unit-testable, generating `client_side_id` via `node:crypto.randomUUID()` (no new dependency).

- [ ] **Step 1: Write the failing test**

Create `test/line-item-bodies.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLineItemBody, deriveServiceType } from "../src/tools/write-bodies.ts";

const CSID = "csid-fixed-for-test";

test("buildLineItemBody: labor item — cents, duration, job_uuid, expand", () => {
  const body = buildLineItemBody(
    { estimateUuid: "est_1", name: "Install", unitPrice: 150, quantity: 2, kind: "labor" },
    CSID
  );
  assert.equal(body.unit_price, 15000, "dollars must convert to cents");
  assert.equal(body.unit_cost, 0);
  assert.equal(body.amount, 30000, "amount = unit_price_cents * quantity");
  assert.equal(body.kind, "labor");
  assert.equal(body.taxable, false);
  assert.deepEqual(body.material_detail, {});
  assert.equal(body.client_side_id, CSID);
  assert.deepEqual(body.expand, ["material_line_item_detail", "materials_auto_populated"]);
  assert.equal(body.job_uuid, "est_1");
  assert.equal(body.order_index, 0);
  assert.equal(body.duration_in_minutes, 120, "labor requires duration");
});

test("buildLineItemBody: fixed discount — no job_uuid/order_index/duration", () => {
  const body = buildLineItemBody(
    { estimateUuid: "est_1", name: "Discount", unitPrice: -50, quantity: 1, kind: "fixed discount" },
    CSID
  );
  assert.equal(body.unit_price, -5000);
  assert.equal("job_uuid" in body, false, "discounts omit job_uuid");
  assert.equal("order_index" in body, false, "discounts omit order_index");
  assert.equal("duration_in_minutes" in body, false, "discounts omit duration");
});

test("buildLineItemBody: service_item_id derives service_item_type", () => {
  const body = buildLineItemBody(
    { estimateUuid: "est_1", name: "X", unitPrice: 10, quantity: 1, kind: "materials", serviceItemId: "pbmat_abc" },
    CSID
  );
  assert.equal(body.service_item_id, "pbmat_abc");
  assert.equal(body.service_item_type, "Pricebook::Material");
});

test("deriveServiceType maps known prefixes", () => {
  assert.equal(deriveServiceType("olit_x"), "OrganizationalLineItemTemplate");
  assert.equal(deriveServiceType("pbmat_x"), "Pricebook::Material");
  assert.equal(deriveServiceType("pbsd_x"), "Pricebook::StandardDiscount");
  assert.equal(deriveServiceType("unknown"), "OrganizationalLineItemTemplate");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "C:\Workspace\Infrastructure\housecall-pro-mcp" && node --import tsx --test test/line-item-bodies.test.ts`
Expected: FAIL — `buildLineItemBody`/`deriveServiceType` are not exported yet.

- [ ] **Step 3: Add the builders to `write-bodies.ts`**

Append to `src/tools/write-bodies.ts`:

```ts
export type LineItemKind = "labor" | "materials" | "fixed discount";

export function deriveServiceType(serviceItemId: string): string {
  if (serviceItemId.startsWith("olit_")) return "OrganizationalLineItemTemplate";
  if (serviceItemId.startsWith("pbmat_")) return "Pricebook::Material";
  if (serviceItemId.startsWith("pbsd_")) return "Pricebook::StandardDiscount";
  return "OrganizationalLineItemTemplate";
}

/**
 * Build the POST /alpha/jobs/{id}/line_items body. Ported verbatim from
 * grizzly-hcp src/hcp/estimates.ts addLineItem. Prices arrive in DOLLARS and
 * are stored in CENTS. clientSideId is passed in (not generated here) so the
 * builder stays pure and deterministic for tests.
 */
export function buildLineItemBody(
  input: {
    estimateUuid: string;
    name: string;
    description?: string;
    unitPrice: number;   // dollars
    unitCost?: number;   // dollars
    quantity: number;
    kind: LineItemKind;
    taxable?: boolean;
    serviceItemId?: string;
    serviceItemType?: string;
    orderIndex?: number;
    materialDetail?: Record<string, unknown>;
  },
  clientSideId: string
): Record<string, unknown> {
  const unitPriceCents = Math.round(input.unitPrice * 100);
  const unitCostCents = Math.round((input.unitCost ?? 0) * 100);
  const amountCents = unitPriceCents * input.quantity;
  const isDiscount = input.kind === "fixed discount";

  const body: Record<string, unknown> = {
    name: input.name,
    description: input.description ?? "",
    unit_price: unitPriceCents,
    unit_cost: unitCostCents,
    quantity: input.quantity,
    amount: amountCents,
    kind: input.kind,
    taxable: input.taxable ?? false,
    material_detail: input.materialDetail ?? {},
    client_side_id: clientSideId,
    expand: ["material_line_item_detail", "materials_auto_populated"],
  };

  if (!isDiscount) {
    body.job_uuid = input.estimateUuid;
    body.order_index = input.orderIndex ?? 0;
  }
  if (input.kind === "labor") {
    body.duration_in_minutes = 120;
  }
  if (input.serviceItemId) {
    body.service_item_id = input.serviceItemId;
    body.service_item_type = input.serviceItemType ?? deriveServiceType(input.serviceItemId);
  }
  return body;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "C:\Workspace\Infrastructure\housecall-pro-mcp" && node --import tsx --test test/line-item-bodies.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Rewrite the `add_line_item` tool in `jobs.ts`**

At the top of `src/tools/jobs.ts`, add imports:

```ts
import { randomUUID } from "node:crypto";
import { buildLineItemBody } from "./write-bodies.js";
```

Replace the `add_line_item` `server.tool(...)` block (lines 91-109) with:

```ts
  // ─── ADD LINE ITEM ──────────────────────────────────────────
  server.tool(
    "add_line_item",
    "Add a line item to an estimate. kind is 'labor' (service work), 'materials', or 'fixed discount'. Prices in DOLLARS (converted to cents internally).",
    {
      estimate_id: z.string().describe("Estimate/job UUID (est_xxx)"),
      name: z.string().describe("Line item name"),
      description: z.string().optional().describe("Line item description"),
      unit_price: z.number().describe("Unit price in dollars"),
      unit_cost: z.number().optional().describe("Internal unit cost in dollars (default 0)"),
      quantity: z.number().min(0).default(1).describe("Quantity"),
      kind: z.enum(["labor", "materials", "fixed discount"]).describe("HCP line item kind"),
      taxable: z.boolean().optional().describe("Default false"),
      service_item_id: z.string().optional().describe("Pricebook id (olit_/pbmat_/pbsd_)"),
      service_item_type: z.string().optional().describe("Derived from service_item_id if omitted"),
      order_index: z.number().optional().describe("Position; ignored for discounts"),
    },
    async ({ estimate_id, name, description, unit_price, unit_cost, quantity, kind, taxable, service_item_id, service_item_type, order_index }) => {
      const body = buildLineItemBody(
        {
          estimateUuid: estimate_id,
          name, description,
          unitPrice: unit_price, unitCost: unit_cost,
          quantity, kind, taxable,
          serviceItemId: service_item_id, serviceItemType: service_item_type,
          orderIndex: order_index,
        },
        randomUUID()
      );
      const res = await client.post<{ id: string; name: string; unit_price: number; quantity: number; amount: number }>(
        `/alpha/jobs/${estimate_id}/line_items`,
        body
      );
      const lineItem = { id: res.id, name: res.name, unitPrice: res.unit_price, quantity: res.quantity, amount: res.amount };
      return { content: [{ type: "text", text: JSON.stringify({ success: true, lineItem }, null, 2) }] };
    }
  );
```

- [ ] **Step 6: Build to verify types**

Run: `cd "C:\Workspace\Infrastructure\housecall-pro-mcp" && npm run build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
cd "C:\Workspace\Infrastructure\housecall-pro-mcp"
git add src/tools/write-bodies.ts src/tools/jobs.ts test/line-item-bodies.test.ts
git commit -m "Fix add_line_item: real HCP contract (cents, kind enum, required fields)"
```

---

## Task 2: Fix `update_line_item` + `bulk_update_line_items` cents (Repo A)

**Files:**
- Modify: `C:\Workspace\Infrastructure\housecall-pro-mcp\src\tools\write-bodies.ts`
- Modify: `C:\Workspace\Infrastructure\housecall-pro-mcp\src\tools\jobs.ts:111-156`
- Test: `C:\Workspace\Infrastructure\housecall-pro-mcp\test\line-item-bodies.test.ts` (extend)

**Context:** Both tools forward `unit_price` as dollars and omit `amount`/`client_side_id`/`material_detail`. Mirror grizzly's `bulkUpdateLineItems` (`estimates.ts:125-163`) and `updateLineItem` (`estimates.ts:166-180`): cents conversion, `amount = unit_price_cents * quantity`, `material_detail: {}`, per-item `client_side_id`, and `object: 'request_line_item'` for bulk.

- [ ] **Step 1: Add failing tests** — append to `test/line-item-bodies.test.ts`:

```ts
import { buildBulkUpdateLineItemsBody, buildUpdateLineItemBody } from "../src/tools/write-bodies.ts";

test("buildBulkUpdateLineItemsBody: cents + request_line_item shape", () => {
  const body = buildBulkUpdateLineItemsBody(
    [{ id: "rli_1", name: "A", unitPrice: 100, quantity: 3, kind: "materials" }],
    () => "csid-1"
  );
  assert.deepEqual(body.expand, ["material_line_item_detail", "line_item_images"]);
  const li = (body.line_items as any[])[0];
  assert.equal(li.object, "request_line_item");
  assert.equal(li.unit_price, 10000);
  assert.equal(li.amount, 30000);
  assert.equal(li.client_side_id, "csid-1");
  assert.deepEqual(li.material_detail, {});
});

test("buildUpdateLineItemBody: only provided fields + recomputed amount", () => {
  const body = buildUpdateLineItemBody("rli_9", { unitPrice: 25, quantity: 4 });
  assert.equal(body.id, "rli_9");
  assert.equal(body.client_side_id, "rli_9");
  assert.deepEqual(body.material_detail, {});
  assert.equal(body.unit_price, 2500);
  assert.equal(body.quantity, 4);
  assert.equal(body.amount, 10000);
  assert.equal("name" in body, false, "unset fields are omitted");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd "C:\Workspace\Infrastructure\housecall-pro-mcp" && node --import tsx --test test/line-item-bodies.test.ts`
Expected: FAIL — new builders not exported.

- [ ] **Step 3: Add builders to `write-bodies.ts`:**

```ts
export function buildBulkUpdateLineItemsBody(
  items: Array<{
    id: string;
    name?: string;
    description?: string;
    unitPrice: number;   // dollars
    unitCost?: number;   // dollars
    quantity: number;
    kind: string;
    taxable?: boolean;
    serviceItemId?: string;
    serviceItemType?: string;
    orderIndex?: number;
  }>,
  newClientSideId: () => string
): Record<string, unknown> {
  const line_items = items.map((item) => {
    const priceCents = Math.round(item.unitPrice * 100);
    return {
      object: "request_line_item",
      id: item.id,
      name: item.name ?? "",
      description: item.description ?? "",
      unit_price: priceCents,
      unit_cost: Math.round((item.unitCost ?? 0) * 100),
      quantity: item.quantity,
      amount: priceCents * item.quantity,
      kind: item.kind,
      taxable: item.taxable ?? false,
      order_index: item.orderIndex ?? 0,
      service_item_id: item.serviceItemId ?? null,
      service_item_type: item.serviceItemType ?? null,
      material_detail: {},
      client_side_id: newClientSideId(),
    };
  });
  return { expand: ["material_line_item_detail", "line_item_images"], line_items };
}

export function buildUpdateLineItemBody(
  lineItemId: string,
  changes: { name?: string; unitPrice?: number; quantity?: number; kind?: string }
): Record<string, unknown> {
  const body: Record<string, unknown> = { id: lineItemId, client_side_id: lineItemId, material_detail: {} };
  if (changes.name !== undefined) body.name = changes.name;
  if (changes.unitPrice !== undefined) body.unit_price = Math.round(changes.unitPrice * 100);
  if (changes.quantity !== undefined) body.quantity = changes.quantity;
  if (changes.kind !== undefined) body.kind = changes.kind;
  if (changes.unitPrice !== undefined && changes.quantity !== undefined) {
    body.amount = Math.round(changes.unitPrice * 100) * changes.quantity;
  }
  return body;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd "C:\Workspace\Infrastructure\housecall-pro-mcp" && node --import tsx --test test/line-item-bodies.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Rewrite the two tools in `jobs.ts`**

Replace the `update_line_item` handler body (lines 126-129) with one that builds via `buildUpdateLineItemBody`, and change its `unit_price` input to dollars semantics. Replace the `bulk_update_line_items` block so its zod `line_items` array carries `unitPrice`/`unitCost` (dollars) + `kind`/`quantity`/`orderIndex`, and the handler calls:

```ts
    async ({ estimate_id, line_items }) => {
      const body = buildBulkUpdateLineItemsBody(
        line_items.map((li) => ({
          id: li.id, name: li.name, description: li.description ?? undefined,
          unitPrice: li.unit_price, unitCost: li.unit_cost, quantity: li.quantity ?? 1,
          kind: li.kind ?? "materials", taxable: li.taxable, orderIndex: li.order_index,
        })),
        () => randomUUID()
      );
      const result = await client.post(`/alpha/jobs/${estimate_id}/line_items/bulk_update`, body);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, result }, null, 2) }] };
    }
```

Update the `bulk_update_line_items` zod schema so each item has `id: z.string()`, `name: z.string().optional()`, `description: z.string().nullable().optional()`, `unit_price: z.number()` (dollars), `unit_cost: z.number().optional()`, `quantity: z.number().optional()`, `kind: z.string().optional()`, `taxable: z.boolean().optional()`, `order_index: z.number().optional()`. Update the `update_line_item` handler:

```ts
    async ({ estimate_id, line_item_id, name, unit_price, quantity, kind }) => {
      const body = buildUpdateLineItemBody(line_item_id, { name, unitPrice: unit_price, quantity, kind });
      const result = await client.patch(`/alpha/jobs/${estimate_id}/line_items/${line_item_id}`, body);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, result }, null, 2) }] };
    }
```

Keep `update_line_item`'s zod `unit_price` as `z.number().optional()` but update its `.describe()` to "in dollars".

- [ ] **Step 6: Build** — `npm run build` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/tools/write-bodies.ts src/tools/jobs.ts test/line-item-bodies.test.ts
git commit -m "Fix update_line_item + bulk_update_line_items: cents + required fields"
```

---

## Task 3: Add `search_customer` MCP tool (Repo A)

**Files:**
- Create: `C:\Workspace\Infrastructure\housecall-pro-mcp\src\tools\customer-search-body.ts`
- Modify: `C:\Workspace\Infrastructure\housecall-pro-mcp\src\tools\search.ts`
- Test: `C:\Workspace\Infrastructure\housecall-pro-mcp\test\customer-search-body.test.ts`

**Context:** grizzly's `searchCustomer` (`estimates.ts:247-283`) queries `GET /alpha/customers?q=…&page=1&page_size=10&…&expand[]=addresses` and returns `{ id, name, addressId, address }` (first match or null). `createEstimate` needs that `addressId`. The daemon's `global_search` hits a different endpoint and lacks the address id, so add a dedicated tool mirroring grizzly's query exactly. Keep the query-param construction in a pure builder for testing.

- [ ] **Step 1: Write the failing test** — `test/customer-search-body.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCustomerSearchParams } from "../src/tools/customer-search-body.ts";

test("buildCustomerSearchParams mirrors grizzly's query", () => {
  const p = buildCustomerSearchParams("Jane Doe");
  assert.equal(p.get("q"), "Jane Doe");
  assert.equal(p.get("page"), "1");
  assert.equal(p.get("page_size"), "10");
  assert.equal(p.get("sort_by"), "display_name");
  assert.equal(p.get("sort_direction"), "asc");
  assert.deepEqual(p.getAll("expand[]"), ["addresses"]);
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test test/customer-search-body.test.ts` → FAIL.

- [ ] **Step 3: Create `src/tools/customer-search-body.ts`:**

```ts
/** Pure query-param builder for customer search. Mirrors grizzly-hcp searchCustomer. */
export function buildCustomerSearchParams(name: string): URLSearchParams {
  const params = new URLSearchParams({
    q: name,
    page: "1",
    page_size: "10",
    contractor: "false",
    has_email: "false",
    sort_by: "display_name",
    sort_direction: "asc",
    for_franchise: "false",
  });
  params.append("expand[]", "addresses");
  return params;
}
```

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Add the tool to `search.ts`**

Add imports at top of `src/tools/search.ts`:

```ts
import { buildCustomerSearchParams } from "./customer-search-body.js";
```

Inside `registerSearchTools`, add:

```ts
  // ─── SEARCH CUSTOMER (by name, with address) ────────────────
  server.tool(
    "search_customer",
    "Find a customer by name and return { id, name, addressId, address } for the best match, or null. Use this (not global_search) when you need the service address id to create an estimate.",
    {
      name: z.string().min(1).describe("Customer name to search for"),
    },
    async ({ name }) => {
      const params = buildCustomerSearchParams(name);
      const res = await client.get<{
        data?: Array<{ id: string; display_name: string; addresses?: { data?: Array<{ id: string; street: string }> } }>;
      }>(`/alpha/customers?${params.toString()}`);
      const match = res.data?.[0];
      const customer = match
        ? {
            id: match.id,
            name: match.display_name,
            addressId: match.addresses?.data?.[0]?.id ?? "",
            address: match.addresses?.data?.[0]?.street ?? "",
          }
        : null;
      return { content: [{ type: "text", text: JSON.stringify({ success: true, customer }, null, 2) }] };
    }
  );
```

- [ ] **Step 6: Build** — `npm run build` → exit 0.

- [ ] **Step 7: Run the full test suite** — `npm test` → all tests pass (15 existing + new).

- [ ] **Step 8: Commit**

```bash
git add src/tools/customer-search-body.ts src/tools/search.ts test/customer-search-body.test.ts
git commit -m "Add search_customer tool (name -> {id,name,addressId,address})"
```

---

## Task 4: MCP-client wrapper (Repo B) — `src/hcp/mcp-client.ts`

**Files:**
- Modify: `C:\Workspace\Active\grizzly-hcp\package.json` (add dependency)
- Create: `C:\Workspace\Active\grizzly-hcp\src\hcp\mcp-client.ts`
- Create: `C:\Workspace\Active\grizzly-hcp\src\hcp\mcp-client.check.ts`

**Context:** Expose the **same signatures and return shapes** as the retired direct functions so consumers swap by import path. Reuse grizzly's existing interfaces (`HcpCustomer`, `HcpEstimate`, `HcpCreatedLineItem`, `HcpLineItem` from `./estimates.js`; `HcpPriceBookItem` from `./price-book.js`) by importing the **types** only. The wrapper unwraps the daemon's `{ success, <entity> }` envelopes (Tasks 1 & 3 above + Plan-1 `writes.ts`):
- `search_customer` → `{ success, customer: HcpCustomer | null }`
- `create_customer` → `{ success, customer: HcpCustomer }`
- `create_estimate` → `{ success, estimate: { estimateId, uuid } }`
- `add_line_item` → `{ success, lineItem: { id, name, unitPrice, quantity, amount } }`
- `assign_technician` → `{ success, assigned: number }`
- `set_deposit` → `{ success, result }` (daemon `set_deposit` takes `deposit_amount` dollars, `deposit_type: "fixed"|"percentage"`, `deposit_due_date`)
- `create_pricebook_item` → `{ success, item: HcpPriceBookItem }`

**Signature parity notes:**
- grizzly `setDeposit(estimateUuid, flatAmountDollars, type: 'percent'|'flat', dueDateDaysFromNow=30)`. The daemon tool wants an explicit `deposit_due_date` and `deposit_type: "fixed"|"percentage"`. The wrapper computes the due date from `dueDateDaysFromNow` and maps `'percent'→"percentage"`, `'flat'→"fixed"`. (commit-estimate calls `setDeposit(uuid, depositPercent, 'percent')` — but note grizzly's direct `setDeposit` treats arg 2 as a flat dollar amount even when type is 'percent'. **Preserve that existing behavior exactly**: pass the number straight through as `deposit_amount` and let `deposit_type` be the label. Do not reinterpret.)
- grizzly `createPriceBookItem({ name, description?, unitPrice, unitCost?, taxable?, unitOfMeasure?, category?, categoryUuid? })`. The daemon tool takes `category_uuid` (optional, looked up if absent) and **does not** accept a category *name*. The wrapper passes `categoryUuid` through and **ignores `category`** for the API call (the name is only used by grizzly's CSV/RAG bookkeeping, which Task 5 moves into `commit-estimate.ts`).

- [ ] **Step 1: Add the dependency**

Run: `cd "C:\Workspace\Active\grizzly-hcp" && npm install @modelcontextprotocol/sdk@^1.29.0`
Expected: `@modelcontextprotocol/sdk` added to `dependencies`.

- [ ] **Step 2: Create `src/hcp/mcp-client.ts`:**

```ts
/**
 * MCP-client wrapper around the housecall-pro-mcp HTTP daemon. Exposes the same
 * signatures as src/hcp/estimates.ts + price-book.ts so consumers swap by import
 * path. Selected at runtime by gateway.ts when HCP_VIA_MCP=true.
 *
 * ponytail: one lazy singleton Client per process, reused across calls (the
 * daemon is stateless Streamable-HTTP, so one connect serves many callTool's).
 * Short-lived spawn scripts connect on first call and exit without closing.
 * Upgrade path: add an explicit close()/health-check if a long-lived consumer
 * needs reconnect-on-drop.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HcpCustomer, HcpEstimate, HcpCreatedLineItem, HcpLineItem } from "./estimates.js";
import type { HcpPriceBookItem } from "./price-book.js";

let clientPromise: Promise<Client> | null = null;

function getClient(): Promise<Client> {
  if (clientPromise) return clientPromise;
  const url = process.env.HCP_MCP_URL || "http://127.0.0.1:7332/";
  const token = process.env.HCP_MCP_TOKEN;
  if (!token) throw new Error("HCP service unavailable: HCP_MCP_TOKEN is required when HCP_VIA_MCP=true");
  clientPromise = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "grizzly-hcp", version: "1.0.0" });
    await client.connect(transport);
    return client;
  })().catch((e) => {
    clientPromise = null; // allow retry on next call
    throw new Error(`HCP service unavailable: ${e instanceof Error ? e.message : String(e)}`);
  });
  return clientPromise;
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const client = await getClient();
  const res: any = await client.callTool({ name, arguments: args });
  const text: string = res?.content?.[0]?.text ?? "";
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (res?.isError || parsed?.success === false) {
    throw new Error(`HCP ${name} failed: ${text}`);
  }
  return parsed as T;
}

export async function searchCustomer(name: string): Promise<HcpCustomer | null> {
  const { customer } = await callTool<{ customer: HcpCustomer | null }>("search_customer", { name });
  return customer;
}

export async function createCustomer(opts: { name: string; email: string; phone?: string }): Promise<HcpCustomer> {
  const { customer } = await callTool<{ customer: HcpCustomer }>("create_customer", opts);
  return customer;
}

export async function createEstimate(customerId: string, addressId: string): Promise<HcpEstimate> {
  const { estimate } = await callTool<{ estimate: HcpEstimate }>("create_estimate", {
    customer_id: customerId,
    address_id: addressId,
  });
  return estimate;
}

export async function addLineItem(
  estimateUuid: string,
  item: HcpLineItem,
  orderIndex = 0
): Promise<HcpCreatedLineItem> {
  const { lineItem } = await callTool<{ lineItem: HcpCreatedLineItem }>("add_line_item", {
    estimate_id: estimateUuid,
    name: item.name,
    description: item.description,
    unit_price: item.unitPrice,
    unit_cost: item.unitCost,
    quantity: item.quantity,
    kind: item.kind,
    taxable: item.taxable,
    service_item_id: item.serviceItemId,
    service_item_type: item.serviceItemType,
    order_index: item.orderIndex ?? orderIndex,
  });
  return lineItem;
}

export async function assignTechnician(estimateUuid: string, employeeUuids: string[]): Promise<void> {
  await callTool("assign_technician", { estimate_uuid: estimateUuid, employee_uuids: employeeUuids });
}

export async function setDeposit(
  estimateUuid: string,
  flatAmountDollars: number,
  type: "percent" | "flat" = "percent",
  dueDateDaysFromNow = 30
): Promise<void> {
  const due = new Date();
  due.setDate(due.getDate() + dueDateDaysFromNow);
  await callTool("set_deposit", {
    estimate_id: estimateUuid,
    deposit_amount: flatAmountDollars,
    deposit_type: type === "percent" ? "percentage" : "fixed",
    deposit_due_date: due.toISOString().slice(0, 10),
  });
}

export async function createPriceBookItem(item: {
  name: string;
  description?: string;
  unitPrice: number;
  unitCost?: number;
  taxable?: boolean;
  unitOfMeasure?: string;
  category?: string;     // ignored for the API call (bookkeeping only — see commit-estimate.ts)
  categoryUuid?: string;
}): Promise<HcpPriceBookItem> {
  const { item: created } = await callTool<{ item: HcpPriceBookItem }>("create_pricebook_item", {
    name: item.name,
    unit_price: item.unitPrice,
    description: item.description,
    unit_cost: item.unitCost,
    taxable: item.taxable,
    unit_of_measure: item.unitOfMeasure,
    category_uuid: item.categoryUuid,
  });
  return created;
}
```

- [ ] **Step 3: Confirm the daemon `set_deposit` signature**

Read `C:\Workspace\Infrastructure\housecall-pro-mcp\src\tools\jobs.ts` `set_deposit` (lines 159-172). Confirm its inputs are `estimate_id`, `deposit_amount` (dollars), `deposit_due_date`, `deposit_type: "fixed"|"percentage"`. If the daemon enum differs, align the wrapper's mapping. (It is `["fixed","percentage"]` per the current source.)

- [ ] **Step 4: Typecheck**

Run: `cd "C:\Workspace\Active\grizzly-hcp" && npx tsc --noEmit`
Expected: no errors in `src/hcp/mcp-client.ts`. (If the repo has no `tsc` typecheck wired, run `npx tsx --eval "import('./src/hcp/mcp-client.ts').then(()=>console.log('ok'))"` from the repo root to confirm it imports without throwing at module load.)

- [ ] **Step 5: Create the smoke self-check `src/hcp/mcp-client.check.ts`:**

```ts
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
```

- [ ] **Step 6: Commit**

```bash
cd "C:\Workspace\Active\grizzly-hcp"
git add package.json package-lock.json src/hcp/mcp-client.ts src/hcp/mcp-client.check.ts
git commit -m "Add MCP-client wrapper for HCP daemon (same signatures as direct client)"
```

---

## Task 5: Flag gateway + bookkeeping move + route commit-estimate (Repo B)

**Files:**
- Create: `C:\Workspace\Active\grizzly-hcp\src\hcp\gateway.ts`
- Create: `C:\Workspace\Active\grizzly-hcp\src\hcp\pricebook-bookkeeping.ts`
- Modify: `C:\Workspace\Active\grizzly-hcp\src\agent\workflows\private-hcp-writes\commit-estimate.ts`
- Modify (or create): `C:\Workspace\Active\grizzly-hcp\.env.example`

**Context:** `commit-estimate.ts` currently imports `searchCustomer, createCustomer, createEstimate, addLineItem, assignTechnician, setDeposit` from `../../../hcp/estimates.js` and `createPriceBookItem` from `../../../hcp/price-book.js`. We introduce `gateway.ts` that re-exports those 7 functions, choosing direct vs. MCP impl by `HCP_VIA_MCP`. Because the MCP `createPriceBookItem` is a thin passthrough with no CSV/RAG side effects, we extract grizzly's existing CSV-append + RAG-index logic into `recordNewPricebookItem(...)` and call it in `commit-estimate.ts` after the create — so the bookkeeping runs identically under both impls.

- [ ] **Step 1: Inspect the existing side-effect code to extract**

Read `C:\Workspace\Active\grizzly-hcp\src\hcp\price-book.ts:243-263` (the `appendToCsv(...)` + `indexPriceBookItem(...)` calls inside `createPriceBookItem`) and its imports (`appendToCsv` from `../rag/price-book.js`, `indexPriceBookItem` from `../rag/client.js`). These are the exact calls to relocate.

- [ ] **Step 2: Create `src/hcp/pricebook-bookkeeping.ts`:**

```ts
/**
 * Grizzly-local bookkeeping for a newly created pricebook item: append to the
 * local CSV cache + index in RAG. Extracted from price-book.ts so it runs after
 * EITHER the direct or the MCP createPriceBookItem (the MCP wrapper is a pure
 * HCP passthrough with no local side effects).
 *
 * ponytail: RAG indexing is best-effort (non-blocking) — a RAG outage must not
 * fail an estimate. Upgrade path: a retry queue if missed indexings matter.
 */
import { appendToCsv } from "../rag/price-book.js";
import { indexPriceBookItem } from "../rag/client.js";

export async function recordNewPricebookItem(args: {
  uuid: string;
  name: string;
  description: string;
  price: number;          // dollars
  category?: string;
  unitOfMeasure?: string;
}): Promise<void> {
  const category = args.category ?? "Uncategorized";
  const unitOfMeasure = args.unitOfMeasure ?? "Each";
  try {
    appendToCsv({
      category,
      uuid: args.uuid,
      name: args.name,
      description: args.description,
      price: args.price,
      priceStr: `$${args.price.toFixed(2)}`,
      unitOfMeasure,
    });
  } catch (e) {
    console.error("[pricebook-bookkeeping] CSV append failed (non-fatal):", e);
  }
  try {
    await indexPriceBookItem({
      uuid: args.uuid,
      name: args.name,
      description: args.description,
      price: args.price,
      category,
      unitOfMeasure,
    });
  } catch (e) {
    console.error("[pricebook-bookkeeping] RAG index failed (non-fatal):", e);
  }
}
```

> **Implementer note:** Match the exact argument shapes that `appendToCsv` and `indexPriceBookItem` expect (read their signatures in `src/rag/price-book.ts` and `src/rag/client.ts`). The fields above mirror `price-book.ts:243-263`; adjust property names if the real signatures differ. Do **not** change `price-book.ts`'s own `createPriceBookItem` in this task (it stays intact for the deferred direct path and the export scripts) — we are *adding* a callable, not removing the inline one. The inline side effects in `price-book.ts` remain for the `HCP_VIA_MCP=false` path; `commit-estimate.ts` must therefore call `recordNewPricebookItem` **only when `HCP_VIA_MCP` is true** to avoid double-writing. Expose the flag from the gateway (Step 3) as `HCP_VIA_MCP` boolean for this conditional.

- [ ] **Step 3: Create `src/hcp/gateway.ts`:**

```ts
/**
 * HCP write-spine gateway. Selects the direct cookie client or the MCP daemon
 * wrapper by the HCP_VIA_MCP flag, so commit-estimate.ts imports from one place
 * and flips implementation by env. Default off = unchanged direct behavior.
 */
import * as direct from "./estimates.js";
import { createPriceBookItem as directCreatePriceBookItem } from "./price-book.js";
import * as mcp from "./mcp-client.js";

export const HCP_VIA_MCP = process.env.HCP_VIA_MCP === "true";

export const searchCustomer      = HCP_VIA_MCP ? mcp.searchCustomer      : direct.searchCustomer;
export const createCustomer       = HCP_VIA_MCP ? mcp.createCustomer       : direct.createCustomer;
export const createEstimate       = HCP_VIA_MCP ? mcp.createEstimate       : direct.createEstimate;
export const addLineItem          = HCP_VIA_MCP ? mcp.addLineItem          : direct.addLineItem;
export const assignTechnician     = HCP_VIA_MCP ? mcp.assignTechnician     : direct.assignTechnician;
export const setDeposit           = HCP_VIA_MCP ? mcp.setDeposit           : direct.setDeposit;
export const createPriceBookItem  = HCP_VIA_MCP ? mcp.createPriceBookItem  : directCreatePriceBookItem;
```

> **Type note:** `mcp.setDeposit` and `direct.setDeposit` must have compatible signatures. grizzly's `direct.setDeposit(estimateUuid, flatAmountDollars, type?, dueDateDaysFromNow?)` matches the wrapper's. Likewise `direct.createPriceBookItem` and `mcp.createPriceBookItem` accept the same option bag. If `tsc` flags a structural mismatch, align the wrapper's parameter types to the direct function's exported types (import them) rather than loosening to `any`.

- [ ] **Step 4: Repoint `commit-estimate.ts` imports**

In `src/agent/workflows/private-hcp-writes/commit-estimate.ts`, replace the two HCP import blocks (lines 15-24):

```ts
import {
  searchCustomer,
  createCustomer,
  createEstimate,
  addLineItem,
  assignTechnician,
  setDeposit,
  createPriceBookItem,
} from '../../../hcp/gateway.js';
import type { HcpLineItem } from '../../../hcp/estimates.js';
import { HCP_VIA_MCP } from '../../../hcp/gateway.js';
import { recordNewPricebookItem } from '../../../hcp/pricebook-bookkeeping.js';
```

(Keep the `HcpLineItem` *type* import from `estimates.js` — types are erased and carry no runtime client.)

- [ ] **Step 5: Run bookkeeping after MCP-created pricebook items**

In the new-pricebook-items loop (around `commit-estimate.ts:151-174`), immediately after the `createPriceBookItem(...)` call returns its `created` item, add:

```ts
        if (HCP_VIA_MCP) {
          // The MCP wrapper is a pure HCP passthrough; replicate the CSV+RAG
          // bookkeeping the direct price-book.ts does inline. (Direct path still
          // does it itself, so only run here when routing through the daemon.)
          await recordNewPricebookItem({
            uuid: created.uuid,
            name: item.name,
            description: item.description,
            price: item.price,
            category: item.category,
            unitOfMeasure: item.unitOfMeasure,
          });
        }
```

> **Implementer note:** bind the create result to `created` (e.g. `const created = await createPriceBookItem({...})`) and use the `NewPricebookItem` loop variable `item` for name/description/price/category. Preserve the existing `newItemUuids[name] = created.uuid` mapping and the `data/new-pricebook.jsonl` audit append exactly as they are.

- [ ] **Step 6: Document the flag in `.env.example`**

Append (create the file if it doesn't exist):

```
# Route HCP writes through the housecall-pro-mcp daemon instead of the built-in
# cookie client. Default off. When true, the daemon must be running and these set:
HCP_VIA_MCP=false
HCP_MCP_URL=http://127.0.0.1:7332/
HCP_MCP_TOKEN=
```

- [ ] **Step 7: Typecheck + DRY-RUN smoke (flag OFF — must be unchanged)**

Run: `cd "C:\Workspace\Active\grizzly-hcp" && npx tsc --noEmit` → no new errors.
Then a flag-off DRY-RUN through the chat path to confirm zero behavior change:
`echo '{"scope":"install 2 outlets","customerName":"ZZ Test"}' | npx tsx src/automations/estimates/from-chat.ts --dry-run`
Expected: same dry-run output as before this task (no HCP writes; flag defaults off → direct path).

- [ ] **Step 8: Commit**

```bash
git add src/hcp/gateway.ts src/hcp/pricebook-bookkeeping.ts src/agent/workflows/private-hcp-writes/commit-estimate.ts .env.example
git commit -m "Route commit-estimate write spine through HCP_VIA_MCP gateway"
```

---

## Task 6: Live test-customer verification gate (Phase 3) — controller-run, NOT a subagent

**Files:** none modified — this is an integration gate, run interactively by the controller (like Plan 1's Task 12). Do not dispatch a subagent.

**Context:** Prove the full Slack/email estimate path works end-to-end through the daemon with `HCP_VIA_MCP=true`, against a disposable test customer, and that the result matches a direct-client build.

- [ ] **Step 1: Rebuild + restart the daemon with the Task 1-3 fixes**

The running daemon (PID from Plan 1) holds the *old* `add_line_item`. Stop it, rebuild, restart:
```bash
cd "C:\Workspace\Infrastructure\housecall-pro-mcp"
npm run build
# stop the old process, then:
# (HTTP mode, bearer-gated; .env supplies HCP_MCP_TOKEN)
set HCP_MCP_TRANSPORT=http && node dist/index.js
```

- [ ] **Step 2: Smoke the wrapper** — with the daemon up and env set:
`cd "C:\Workspace\Active\grizzly-hcp" && npx tsx src/hcp/mcp-client.check.ts` → prints the ✓ line.

- [ ] **Step 3: Flag-on DRY-RUN** — `HCP_VIA_MCP=true` with `--dry-run` through `from-chat.ts`; confirm it resolves customers via the daemon (`search_customer`) and reports the planned line items without writing.

- [ ] **Step 4: One LIVE estimate to a disposable "ZZ Test" customer** with `HCP_VIA_MCP=true` (no `--dry-run`), including at least one labor item, one material item, a new custom pricebook item, a technician assignment, and a deposit. Open the resulting estimate in the HCP UI and confirm: line items have correct prices (cents rendered as dollars), the new pricebook item exists, the tech is assigned, and the deposit is set. Confirm the CSV + RAG bookkeeping ran (check `data/` CSV + RAG index).

- [ ] **Step 5: Parity check** — build the same estimate with `HCP_VIA_MCP=false` (direct client) and confirm the two estimates match field-for-field.

- [ ] **Step 6: Cleanup note** — record the "ZZ Test" customers + pricebook items created so they can be deleted in the HCP UI (no delete tool exposed).

**Gate pass criteria:** live MCP-routed estimate is byte-equivalent (modulo ids/timestamps) to the direct-client estimate, with correct cents, kind, tech, deposit, and bookkeeping. On pass, Plan 2 is complete; flipping `HCP_VIA_MCP=true` as the default and deleting `client.ts` are the deferred Phase-4 follow-up.

---

## Self-Review

**Spec coverage (against `2026-06-28-hcp-mcp-consolidation-design.md`):**
- A-side line-item correctness (the gate-discovered `add_line_item` defect) → Tasks 1-2. ✔
- B1 MCP wrapper with same signatures → Task 4. ✔
- B3 write workflow routed through wrapper → Task 5 (commit-estimate, covering from-chat + from-email). ✔
- B4 grizzly-side CSV/RAG bookkeeping moved out of the passthrough → Task 5 (`recordNewPricebookItem`). ✔
- `search_customer` parity (spec assumed `global_search`; corrected) → Task 3. ✔
- Phased, reversible, test-customer gate → Task 6 + `HCP_VIA_MCP` default-off. ✔
- B2 agent reads, B5 `from-proposal`, B6 deletions → **explicitly deferred** in Scope with reasons. ✔ (gap surfaced, not silently dropped)

**Placeholder scan:** No TBD/TODO. Every code step shows full code. Implementer notes flag the two places that require reading real signatures (`appendToCsv`/`indexPriceBookItem` shapes; daemon `set_deposit` enum) — these are verification steps, not placeholders.

**Type consistency:** Wrapper functions reuse grizzly's exported interfaces (`HcpCustomer`, `HcpEstimate`, `HcpCreatedLineItem`, `HcpLineItem`, `HcpPriceBookItem`). Gateway re-exports must structurally match direct + MCP; Step notes call out aligning to the direct function's types if `tsc` complains. Daemon return envelopes (`{success, customer|estimate|lineItem|item}`) match what Tasks 1/3 and Plan-1 `writes.ts` emit.

---

## Execution Handoff

Per the standing rule, this plan executes via **superpowers:subagent-driven-development** (fresh subagent per task, spec-then-quality review between tasks). Tasks 1-5 are subagent-implementable (mechanical, well-specified, 1-3 files each). **Task 6 is controller-run** (interactive live verification against the real HCP account — not a subagent task), mirroring Plan 1's Task 12.
