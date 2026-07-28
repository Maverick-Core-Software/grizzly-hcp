# PLAN — HCP credential consolidation: repoint sync exports at the CT102 daemon

**Goal:** Delete `hcp-cookies.json` as a credential store. After this plan, the Sunday
export jobs authenticate through the CT102 `hcp-mcp` daemon's browser session — the same
session `relogin.ts` refreshes — instead of carrying their own copy of HCP cookies onto AIWA.

**Companion plan:** `C:\Workspace\Shared\Agents\Hermes-Supervisor\PLAN.md` adds the alert
routing and timer monitoring. This plan deliberately has **no** Twilio/Slack dependency: the
preflight check here exits non-zero and prints a machine-greppable marker; the Hermes plan
owns turning that into an SMS. Neither plan blocks the other.

---

## Codebase Primer (orchestrator context — Qwen never sees this)

**Repos touched by this plan**

| Repo | Path | Role here |
|---|---|---|
| `housecall-pro-mcp` | `C:\Workspace\Infrastructure\housecall-pro-mcp` | The MCP daemon. Session 1 adds one read-only tool. |
| `grizzly-hcp` | `C:\Workspace\Active\grizzly-hcp` | The sync jobs. Sessions 2–4. |

**Current architecture**

- `grizzly-hcp/src/hcp/client.ts` is the single HTTP chokepoint. Every exporter
  (`export-estimates.ts`, `export-customers.ts`, `export-pricebook.ts`, `export-jobs.ts`)
  reaches HCP through `hcpGet<T>(path)` in that file. `hcpGet` attaches a `Cookie:` header
  built from `auth-cookies.ts` → `auth/hcp-cookies.json`.
- `grizzly-hcp/src/hcp/gateway.ts` already flips the **write** spine between the direct
  cookie client and the daemon via `HCP_VIA_MCP=true`, using `src/hcp/mcp-client.ts`.
  **The read/export path was never included in that flip.** This plan finishes it.
- The daemon exposes ~85 semantic tools (`get_customer`, `list_pricebook_services`, …) but
  **none** correspond to the bulk paginated list endpoints the exporters walk. That is why
  a passthrough tool is needed rather than tool-by-tool porting.
- The daemon authenticates from a persistent Chrome profile (`~/.hcp-mcp-browser`), not a
  cookie file. Routing exports through it is what collapses two credential stores into one.

**Gotchas**

- `hcpGet` returns parsed JSON typed as `T`. The passthrough must preserve that exactly —
  the exporters' interfaces (`HcpEstimate`, `HcpOption`, …) depend on the raw HCP shape.
  Do not reshape, unwrap, or camelCase anything.
- `client.ts` caches `_cookieHeader` / `_csrfToken` in module state and nulls them on 401.
  The daemon path has no cookies or CSRF; keep that branch entirely separate rather than
  threading nulls through the existing code.
- `mcp-client.ts` holds one lazy singleton `Client` per process and never closes it. Reuse
  that same `callTool` helper — do not open a second connection.
- `sync-catalog.ts` hard-fails unless `RAG_TARGET=local`. Leave that guard alone.
- `sync-catalog.ts` has an `isAuthFailure()` regex and prints "run npm run login … place the
  refreshed cookie file on this host through Orca". That advice becomes wrong after this
  plan and Session 3 must update it.
- Windows dev box; the deployed target is AIWA/CT-side Linux. Keep paths POSIX-safe.

**Rollback:** every change is gated behind `HCP_VIA_MCP`. Unset it and the direct cookie
path returns unchanged. Preserve that property in every session.

---

## Session 1 — Read-only HCP GET passthrough tool on the daemon

**Independent: yes** (different repo, no shared files with Sessions 2–4)

**Repo:** `C:\Workspace\Infrastructure\housecall-pro-mcp`

### Goal

Add exactly one new MCP tool that performs an authenticated **GET** against HCP's internal
API using the daemon's existing browser session, and returns the response body verbatim.

### Why this shape

The bearer token that reaches this daemon **already** authorizes ~85 tools including
destructive writes (`create_estimate`, `create_customer`, `add_line_item`,
`create_pricebook_item`). A GET-only passthrough is strictly *less* privileged than what the
token already grants, so it adds no new authority — it only avoids duplicating pagination
logic that already exists in `grizzly-hcp`.

### Tasks

1. **Create** `src/tools/passthrough.ts`, following the exact registration style used by the
   sibling files in `src/tools/` (look at `src/tools/reporting.ts` — it is the smallest
   example of the pattern). Register one tool:

   - Tool name: `hcp_api_get`
   - Single required argument: `path` (string) — an HCP API path beginning with `/`
   - Returns: the raw JSON response body, JSON-stringified into the standard MCP
     `content[0].text` envelope the other tools already use

2. **Enforce these guardrails inside the handler**, rejecting with a clear error message:
   - `path` must start with `/`. Reject absolute URLs, protocol-relative `//`, and any
     `..` segment.
   - `path` must match one of an allowlisted set of prefixes. Define the allowlist as a
     module-level constant array so it is auditable in one place. Seed it with the prefixes
     the exporters actually use — determine these by reading the four exporters in
     `C:\Workspace\Active\grizzly-hcp\src\hcp\` (`export-estimates.ts`, `export-customers.ts`,
     `export-pricebook.ts`, `export-jobs.ts`) and collecting every literal path passed to
     `hcpGet`. Do not guess; read them.
   - The method is hardcoded GET. There is no method argument.

3. **Register** the new tool module wherever the other `src/tools/*.ts` modules are
   registered (find the central registration site; do not create a parallel one).

4. Reuse the daemon's existing authenticated request helper — the same one the other read
   tools use. Do not open a new browser context, do not read any cookie file.

### Verification

```bash
npm run build
```
Expect: clean TypeScript compile, no new errors.

```bash
npm test
```
Expect: existing suite still passes. If the repo has no test script, say so in your report
rather than inventing one.

Then confirm by reading your own file back that: the allowlist constant exists, the method
is not parameterised, and traversal/absolute-URL rejection is present.

### Commit

```
feat(mcp): read-only hcp_api_get passthrough for bulk export paths
```

---

## Session 2 — Route grizzly-hcp reads through the daemon

**Independent: no** (Session 3 builds on this)

**Repo:** `C:\Workspace\Active\grizzly-hcp`

### Goal

When `HCP_VIA_MCP=true`, `hcpGet` reaches HCP through the daemon's `hcp_api_get` tool
instead of the local cookie file. All four exporters must work unchanged.

### Tasks

1. **Modify** `src/hcp/mcp-client.ts`: export a new function

   ```ts
   export async function apiGet<T>(path: string): Promise<T>
   ```

   It calls the daemon tool `hcp_api_get` with `{ path }` through the module's existing
   private `callTool` helper and returns the parsed body as `T`. Reuse the existing
   singleton client — do not add a second connection path.

2. **Modify** `src/hcp/client.ts`: at the top of `hcpGet<T>(path)`, branch on the same flag
   `gateway.ts` uses. When the daemon route is active, delegate to `apiGet<T>(path)` and
   return. Otherwise fall through to the existing `request('GET', path)` logic **completely
   unchanged**.

   - Read the flag the same way `gateway.ts` does (`process.env.HCP_VIA_MCP === "true"`).
     Do not import `gateway.ts` from `client.ts` — that would create an import cycle
     (`gateway.ts` → `estimates.ts` → `client.ts`). Read the env var directly.
   - Do **not** change `hcpPost`, `hcpPostForm`, `hcpPut`, `hcpPatch`, `hcpDelete`, or
     `closeClient`. Writes already have their own daemon route through `gateway.ts`.
   - Do **not** touch the `_cookieHeader` / `_csrfToken` cache or the 401 handling on the
     direct path.

3. **Create** `src/hcp/mcp-read.check.ts` following the existing `*.check.ts` convention in
   this repo (read `src/hcp/mcp-client.check.ts` for the established shape). It must assert:
   - With the flag unset, `hcpGet` takes the direct path (no daemon call attempted).
   - With the flag set, `hcpGet` delegates and returns the daemon's body verbatim —
     specifically, a nested object round-trips without any key renaming or unwrapping.

### Design constraints

- Behaviour with the flag unset must be byte-for-byte identical to today. This is the
  rollback lever.
- Do not add a new dependency. `@modelcontextprotocol/sdk` is already present.

### Verification

```bash
npx tsc --noEmit
```
Expect: no errors.

```bash
npx tsx src/hcp/mcp-read.check.ts
```
Expect: all assertions pass, process exits 0.

### Commit

```
feat(hcp): route hcpGet through the MCP daemon when HCP_VIA_MCP=true
```

---

## Session 3 — Preflight auth check on both sync entry points

**Independent: no** (depends on Session 2)

**Repo:** `C:\Workspace\Active\grizzly-hcp`

### Goal

Both weekly sync jobs verify the HCP session is alive **before** doing any export work, and
fail fast with a distinctive marker a monitor can grep for.

### Tasks

1. **Create** `src/hcp/preflight-auth.ts` exporting

   ```ts
   export async function checkHcpAuth(): Promise<{ ok: boolean; via: 'daemon' | 'cookies'; detail: string }>
   ```

   - It performs one cheap authenticated read through `hcpGet` — pick the lightest path
     available from the allowlist you built in Session 1 (a single-record or settings
     endpoint, not a paginated list).
   - `via` reports which route was actually used, read from the same env flag.
   - It never throws. A thrown error becomes `{ ok: false, detail: <message> }`.

2. **Create** `src/hcp/preflight-cli.ts` — a standalone entry point that calls
   `checkHcpAuth()`, prints a one-line human summary, and:
   - exits **0** when ok
   - exits **1** when not ok, and prints on its own line the exact literal marker
     `HCP_AUTH_PREFLIGHT_FAIL` followed by a space and the detail

   The marker string must appear verbatim and nowhere else in the repo, because the Hermes
   monitor greps the journal for it.

3. **Add** an npm script `preflight-auth` pointing at that entry point, matching how the
   other CLI entry points in `package.json` are declared.

4. **Modify** `src/hcp/sync-catalog.ts`:
   - Call `checkHcpAuth()` immediately after the `RAG_TARGET` guard and before the first
     export step. If not ok, print the `HCP_AUTH_PREFLIGHT_FAIL` marker line and
     `process.exit(1)` without running any export.
   - Update the stale remediation text near the end of `run()`. It currently tells the
     operator to run `npm run login` and "place the refreshed cookie file on this host
     through Orca". When `via === 'daemon'` that is wrong — the correct remedy is to run the
     relogin on the PC, which refreshes the daemon's browser profile; no file is copied
     anywhere. Make the message conditional on `via`.

5. **Modify** the jobs sync entry point the same way. Find it first — it is the entry point
   the `hcp-estimates-sync` systemd unit runs, and it is a sibling of `sync-catalog.ts` in
   `src/hcp/`. Read it before editing; do not assume its filename.

6. **Create** `src/hcp/preflight-auth.check.ts` asserting that a failing auth check produces
   the exact marker string and a non-zero exit, and that a passing one exits 0.

### Design constraints

- The preflight must add well under a second to a healthy run. One request, no retries.
- Do not import anything from the Hermes-Supervisor repo. The contract between the two is
  the marker string and the exit code — nothing else.

### Verification

```bash
npx tsc --noEmit
```
Expect: no errors.

```bash
npx tsx src/hcp/preflight-auth.check.ts
```
Expect: all assertions pass, exit 0.

```bash
npm run preflight-auth
```
Expect: exits 0 with an "ok" summary if a session is currently valid, or exits 1 with the
marker line if not. **Either outcome is a pass for this session** — you are verifying the
plumbing, not the live session. Report which one you saw.

### Commit

```
feat(hcp): preflight auth check with fail marker on both sync entry points
```

---

## Session 4 — Documentation and brain-write triad

**Independent: no** (must run last)

**Repo:** `C:\Workspace\Active\grizzly-hcp`

### Goal

Record the new credential architecture. **All three writes below are required** — a report
that updates only HANDOFF and JOURNAL is an incomplete session.

### Tasks

1. **Modify** `memory/HANDOFF.md` — update the current-state section to say:
   - The sync exports authenticate through the CT102 `hcp-mcp` daemon when
     `HCP_VIA_MCP=true`; `auth/hcp-cookies.json` is now the fallback path only.
   - The session is refreshed by the relogin task on the PC, which refreshes the daemon's
     Chrome profile. No cookie file is transported to AIWA.
   - Both sync entry points run a preflight auth check and emit
     `HCP_AUTH_PREFLIGHT_FAIL` on a dead session.
   - Rollback: unset `HCP_VIA_MCP`.
   - Required env on the AIWA sync host: `HCP_VIA_MCP=true`, `HCP_MCP_URL`, `HCP_MCP_TOKEN`.
     **Name the variables only. Never write a token value into any file.**

2. **Append** a dated entry to `memory/JOURNAL.md` in the existing format, summarising the
   four sessions and naming the files changed.

3. **Modify** the brain vault project note at
   `C:\Workspace\Active\brain\projects\grizzly-hcp.md` — add a dated section covering the
   same credential-architecture change and the rollback lever. Match the note's existing
   heading style.

### Verification

Read all three files back and confirm each contains the new dated content. Report the three
paths explicitly in your completion report.

### Commit

```
docs: record HCP daemon credential consolidation
```

---

## Operator Session O1 — PC remnant cleanup and relogin enable

> **NOT dispatched to Qwen.** These are live-state operations on Carter's PC requiring his
> explicit per-item consent and an elevated shell. Listed here so the plan is complete.
> Run only after Sessions 1–4 verify.

**Sequencing matters:** the relogin script talks to a daemon on `127.0.0.1:7332`. Do the
relogin decision before deleting the PC daemon.

1. **Confirm** CT102 `hcp-mcp.service` is serving and the PC's local 7332 listener is
   genuinely redundant for every remaining consumer.
2. **Relogin stays on the PC** (Carter's decision). Its Chrome profile `~/.hcp-mcp-browser`
   remains on the PC. Confirm what the refreshed profile must reach after the PC daemon is
   removed, and adjust its target before, not after, the deletion.
3. **Enable** the HCP relogin scheduled task. Requires Carter's consent.
4. **Archive then remove** the confirmed remnants — `housecall-pro-mcp` and `mav-console`.
   Move to `C:\Workspace\Archive\`, then `pm2 delete` via the elevated gsudo pattern
   followed by `pm2 save`. Requires Carter's consent per process.
   - Neither is in `CRITICAL_PM2_PROCESSES`, so Hermes will not alarm.
   - **Do not touch `homelab-agent-sensors`** — retained rollback backup.
5. **Still unverified, check before acting:** `prometheus-sync`, `maverick-dashboard`,
   `voice-server`, `booking-approval-poller`.

---

## Revisions

_(none yet)_
