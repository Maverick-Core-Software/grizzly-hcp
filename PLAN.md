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
     module-level constant array so it is auditable in one place. Seed it with the verified
     literal prefixes the exporters + `sync-estimates.ts` pass to `hcpGet` (confirmed by
     reading all five files):
     - `/alpha/estimates` — export-estimates line-item fetch (`/alpha/estimates/{id}/line_items`)
     - `/beta/estimates` — export-estimates paginated list (`/beta/estimates?...`). **Distinct
       from `/alpha/estimates`; do not collapse them** — export-estimates uses `/beta/` for the
       list and `/alpha/` for line items.
     - `/alpha/customers` — export-customers
     - `/alpha/pricebook` — export-pricebook (covers `/services`, `/materials`, `/industries`,
       `/categories`, `/material_categories`)
     - `/alpha/jobs` — export-jobs + sync-estimates (list + `/alpha/jobs/{id}/line_items`)

     All five are static literals (query strings and path params are dynamic; the prefixes
     are not).

     **Scope constraint:** `HCP_VIA_MCP=true` is set ONLY on the AIWA sync host, where this
     five-prefix set is the complete `hcpGet` surface. Other `hcpGet` callers in the repo do
     not run on AIWA (`estimates.ts` → `/api/estimates/{id}`, `/alpha/estimate_templates/...`;
     `src/agent/tools/reads/*` → `/pro/jobs`, `/pro/estimates`) and stay on the direct cookie
     path. If the flag is ever set elsewhere, expand the allowlist to cover every `hcpGet`
     prefix in the repo first — the export set is not sufficient in a broader environment.
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

## Operator Session O2 — Deploy + enable the daemon route on AIWA/CT102

> **NOT dispatched to Qwen.** Live-state operations on AIWA and CT102 requiring Carter's
> explicit per-item consent and an elevated shell. Listed here so the plan is complete.
> Run after Sessions 1–4 verify and **before O1's PC daemon removal** — the sync jobs must
> be proven on the daemon route before any PC remnant is touched.

This is the step that actually achieves the plan's goal. Sessions 1–4 build the code; without
this operator step the AIWA weekly jobs keep using `auth/hcp-cookies.json`, because (verified
on aiwa-host 2026-07-28) both sync env files currently set `HCP_COOKIES_FILE` and none of
`HCP_VIA_MCP` / `HCP_MCP_URL` / `HCP_MCP_TOKEN`. Reachability is already fine: aiwa-host
reaches `192.168.1.14:7332` (TCP + HTTP 401 bearer-gate confirmed).

1. **Build and deploy the daemon** (repo `housecall-pro-mcp`) to CT102: `npm run build`,
   ship `dist/` into the CT102 `hcp-mcp.service` working tree, restart `hcp-mcp.service`.
   Confirm `http://192.168.1.14:7332/` still returns 401 to an anonymous probe.
2. **Build and deploy the grizzly sync bundles** to aiwa-host: `npm run build:sync-catalog`
   and `npm run build:sync-estimates`, then ship `dist/sync-catalog.mjs` →
   `/opt/hcp-catalog-sync/` and `dist/sync-estimates.mjs` → `/opt/hcp-estimates-sync/`.
   These bundles carry the new `hcpGet` daemon branch and the preflight call.
3. **Provision `HCP_MCP_TOKEN` to aiwa-host** via a secure channel (Carter's consent; never
   committed, never printed, never pasted into chat). Same token CT102's daemon validates.
4. **Add to BOTH env files** (`/opt/hcp-estimates-sync/hcp-estimates-sync.env` and
   `/opt/hcp-catalog-sync/hcp-catalog-sync.env`):
   - `HCP_VIA_MCP=true`
   - `HCP_MCP_URL=http://192.168.1.14:7332/`
   - `HCP_MCP_TOKEN=<provisioned value>`

   Leave the existing `HCP_COOKIES_FILE` line in place for now — it is harmless fallback
   (the direct path is dead code while `HCP_VIA_MCP=true`). Remove it only after step 6.
5. **Verify before the next weekly fire:** run the preflight on aiwa-host against the
   deployed bundle (env sourced from the file). Expect exit 0 and the `ok via=daemon`
   summary. An exit 1 with `HCP_AUTH_PREFLIGHT_FAIL` means abort and recheck token / URL /
   daemon health before the timer fires.
6. **Watch the first weekly fire** after the flip (Sun 03:34 / 04:34 CDT timers). Confirm
   both complete and the journals show no `HCP_AUTH_PREFLIGHT_FAIL`. Only after a clean
   weekly fire is the cookie file truly dead on AIWA — then remove `HCP_COOKIES_FILE` from
   both env files.

---

## Operator Session O1 — PC remnant cleanup

> **NOT dispatched to Qwen.** These are live-state operations on Carter's PC requiring his
> explicit per-item consent and an elevated shell. Listed here so the plan is complete.
> Run after Sessions 1–4 verify **AND after O2 has proven the daemon route on AIWA** — do
> not remove the PC daemon until the AIWA sync jobs are confirmed running through CT102.

**Relogin is settled — no sequencing constraint.** Verified 2026-07-28 against
`housecall-pro-mcp/deploy/MIGRATION.md`: CT102 refreshes its own session via
`hcp-mcp-relogin.timer` (06:45 America/Chicago, `xvfb-run … npm run relogin`), and the
Windows task `HCP Session Relogin` is already **disabled** by the cutover, annotated
"was PC-profile only."

The binding constraint was never the headed browser — it is the Chrome profile directory.
`relogin.ts` refreshes `USER_DATA_DIR` = `~/.hcp-mcp-browser` (`src/client.ts:24`), the same
directory the *local* daemon reads. CT102 has its own `/home/hcp-mcp/.hcp-mcp-browser`,
"fresh CT-resident; nothing copied from Windows" (MIGRATION.md:21). A PC relogin therefore
cannot refresh CT102's session, and retargeting `DAEMON_URL` alone would be worse than
useless — it would tell CT102 to release its browser, then refresh the PC's dead profile.

If CT102's automated OAuth ever fails, the interactive path is on the CT (MIGRATION.md:146):
reinstall the noVNC stack, `/root/deploy/login-start.sh`, log in, `login-stop.sh`.

1. **Confirm** CT102 `hcp-mcp.service` is serving and the PC's local 7332 listener is
   genuinely redundant for every remaining consumer.
2. **Leave the PC relogin task disabled.** The PC's `~/.hcp-mcp-browser` profile becomes
   dead weight once the PC daemon is removed; delete it with the daemon, not before.
3. **Archive then remove** the confirmed remnants — `housecall-pro-mcp` and `mav-console`.
   Move to `C:\Workspace\Archive\`, then `pm2 delete` via the elevated gsudo pattern
   followed by `pm2 save`. Requires Carter's consent per process.
   - Neither is in `CRITICAL_PM2_PROCESSES`, so Hermes will not alarm.
   - **Do not touch `homelab-agent-sensors`** — retained rollback backup.
4. **Check before acting:** `prometheus-sync`, `maverick-dashboard`, `voice-server`.
   `booking-approval-poller` was verified 2026-07-28 as already talking to CT102
   (`192.168.1.14:7332`) — effectively cut over, leave it running.

---

## Revisions

**2026-07-28 (night) — O2 steps 1, 2, 4, 5 done; step 5 caught a real defect first:**

- **Done:** O2 step 1 (daemon `production-2026-07-28` live on CT102), step 2 (both sync bundles
  rebuilt on aiwa-host and deployed), the remaining `HCP_VIA_MCP=true` half of step 4 (both env
  files, `600 root:root`, `HCP_COOKIES_FILE` retained per the step), and step 5.
- **Step 5 failed on the first attempt, and that is the whole reason it exists.** The preflight
  printed `HCP auth ok — authenticated via daemon` and then hung until killed — exit 124 at 60 s.
  Control run with `HCP_VIA_MCP=false`: same success line, exit 0 in 0.53 s. Root cause: the
  StreamableHTTP client transport in `mcp-client.ts` holds a socket open in a module-level
  singleton, and every entry point ends its success path by returning and letting the event loop
  drain (never `process.exit()`, which trips libuv's `UV_HANDLE_CLOSING` assertion on Windows).
  A transport left open means the loop never empties.
- **Blast radius had this reached the timer:** both units are `Type=oneshot` with
  `TimeoutStartUSec=infinity` and `RuntimeMaxUSec=infinity`. A fully *successful* run would have
  wedged the unit in `activating` forever and blocked every following weekly fire — with a
  success line in the journal and no `HCP_AUTH_PREFLIGHT_FAIL` for the monitor to catch. The
  failure mode was silent by construction; only step 5's explicit exit-code check surfaced it.
- **Fix:** commit `d78e249` — `closeClient()` in `mcp-client.ts`, `closeHcp()` in `client.ts`
  (dynamic import, so the cookie path never pulls the MCP SDK into its module graph), called on
  the success path of `preflight-cli.ts`, `sync-catalog.ts`, `sync-estimates.ts`. Guarded by
  `src/hcp/mcp-close.check.ts`.
- Redeployed from `d78e249`: `/opt/hcp-catalog-sync/sync-catalog.mjs` = `1e556986…` (656,719 B),
  `/opt/hcp-estimates-sync/sync-estimates.mjs` = `8f34062f…` (645,338 B), both `644 root:root`,
  backups `.bak-20260729T025450Z` hash-verified against the previous live pair before the copy.
  No unit started, stopped, restarted, or reloaded. Step 5 re-run: exit 0 in 0.57 s.
- **Remaining: step 6 only** — watch the Sun 2026-08-02 fire (estimates 03:34, catalog 04:33 CDT),
  confirm both reach `inactive (dead)` rather than sticking in `activating`, then remove
  `HCP_COOKIES_FILE` from both env files. Rollback lever until then: delete the `HCP_VIA_MCP` line
  from both env files and the cookie path resumes unchanged.

**2026-07-28 (evening) — O2 step 3 executed; step 4 deliberately split in two:**

- **Done:** O2 step 3 (provision `HCP_MCP_TOKEN` to aiwa-host) and the `HCP_MCP_URL` +
  `HCP_MCP_TOKEN` half of step 4. Both `/opt/hcp-estimates-sync/hcp-estimates-sync.env` and
  `/opt/hcp-catalog-sync/hcp-catalog-sync.env` now carry `HCP_MCP_URL=http://192.168.1.14:7332/`
  and a 64-char `HCP_MCP_TOKEN` (byte-identical in both), mode `644` → `600 root:root`,
  backups `.bak-20260728T231321Z` at `0600`. `HCP_COOKIES_FILE` untouched.
- **Deliberately NOT done:** `HCP_VIA_MCP=true`. Step 4 as written sets all three keys at once,
  but steps 1–2 (deploy the daemon to CT102, ship the rebuilt sync bundles) have not run.
  Setting the flag now would point the Sunday 03:34/04:34 CDT timers at a daemon that does not
  exist and break two currently-working jobs. **Provisioning a credential and cutting over are
  separate approvals.** The remaining work of step 4 is one line per env file.
- The credential moved by encrypted transport, not by paste: `tools/pack-secret.ps1` +
  `tools/install-hcp-mcp-token.sh` in the **Hermes-Supervisor** repo (commits `2637068`,
  `e431b0c`), documented in that repo's `docs/SECRET-TRANSFER-RUNBOOK.md`. Re-running the
  installer with `--enable` is how step 4 gets finished; it replaces rather than appends.
- **The identical token must be configured on the CT102 daemon in step 1.** Carter holds it in
  his password manager — it exists in plaintext nowhere else, and cannot be recovered from the
  env files without root on aiwa-host.
- No scope or design change; sessions 1–4 and O1 are untouched.

**2026-07-28 — orchestrator verification pass (read-only; did not execute):**
- Claims 2–8 verified by direct file/state inspection; all hold.
- Claim 1 (live reachability): reachability **CONFIRMED** (TCP `CONNECT_OK` + HTTP 401
  bearer-gate from aiwa-host to `192.168.1.14:7332`). But `HCP_MCP_URL`, `HCP_MCP_TOKEN`,
  and `HCP_VIA_MCP` are **ABSENT** from both AIWA sync env files, which still set
  `HCP_COOKIES_FILE`. The plan as previously written built the code but had no operator
  step to flip AIWA onto the daemon route — so the stated goal would not have been reached.
  Added **Operator Session O2** to deploy + flip the env. This is the load-bearing change.
- Session 1 allowlist: enumerated the five verified prefixes explicitly — including
  `/beta/estimates` (export-estimates uses `/beta/` for its list and `/alpha/` for line
  items; collapsing them would break the Sunday estimates export) — and added the
  `HCP_VIA_MCP=true` is-AIWA-only scope constraint.
- O1 re-sequenced to run after O2 (do not remove the PC daemon until AIWA is proven on CT102).
- No changes to Sessions 1–4 code tasks; they are sound as written. Companion Plan 2
  (Hermes-Supervisor) untouched and out of scope.
