# sync-estimates → AIWA Relocation — Design

**Date:** 2026-07-24
**Repo:** `grizzly-hcp` (branch `main`)
**Author:** Carter + Claude (brainstorming)
**Status:** Design — awaiting review before implementation plan

## Goal

Relocate the `sync-estimates` job so it runs **natively on AIWA** (Proxmox host `192.168.1.12`)
instead of on the PC. Today the job runs on the PC and reaches AIWA twice over SSH using the
passphrase-less key `C:/Users/carte/.ssh/id_ed25519_proxmox`. Running it on AIWA turns both of
those remote operations into **local** operations, eliminating this job's use of that key.

## Why this matters (context)

This is the first concrete step of a larger effort: making the PC's passphrase-less SSH key to
AIWA **unnecessary**, so it can eventually be removed/passphrase-locked as a harness-agnostic hard
stop against ad-hoc agent SSH (the `pi` / session-start-button vector). Every PC consumer of that
key is an HCP→RAG data job that reads from the Housecall Pro *cloud* API and lands data on AIWA —
none reads PC-native data — so each can move to AIWA. `sync-estimates` is the cleanest one and moves
first. **This spec does not remove the key or touch the other jobs** — it only relocates this one.

## Current state (what `sync-estimates` does today)

Source: `src/hcp/sync-estimates.ts`, run via `npm run sync-estimates` (manual, on the PC).

1. Pulls all HCP jobs (paginated) + per-job line items (5 concurrent) from the HCP internal API.
2. Writes `data/estimates-enriched.csv` locally.
3. **[key use #1]** `ssh -i <key> root@192.168.1.12 "curl -s -X POST http://localhost:6333/collections/grizzly_hcp/points/delete ..."`
   — deletes stale `type=job` points from the Qdrant collection `grizzly_hcp`.
4. **[key use #2]** `scp -i <key> data/estimates-enriched.csv root@192.168.1.12:/mnt/samsung-sata/mav-rag/hcp-exports/estimates-enriched.csv`
5. The mav-rag ingest watcher on AIWA picks up the new CSV and re-indexes automatically.

### HCP authentication (the real constraint)

HCP auth is a **browser session, not an API key** (`src/hcp/auth.ts`, `src/hcp/client.ts`):

- `npm run login` opens a **visible** browser (Playwright), the human logs in **manually**, and a
  headless pass saves cookies (including `csrf_token`) to `auth/hcp-cookies.json`.
- Runtime API calls are plain `fetch` with a `Cookie:` header — **no browser needed at runtime**,
  only the saved cookie file.
- On expiry the API returns 401 → the fix is "run `npm run login`" (a human, interactive step).

Implication: the compute and I/O relocate perfectly, but the **cookie file is produced by a manual,
interactive login that only the human can perform in a real browser.** That step stays on the PC; the
cookie file must reach AIWA by a sanctioned channel and be refreshed on expiry.

## Target design

### Runtime home — host systemd timer on `.12`

- A **systemd service + timer** on the Proxmox host runs the job as a one-shot, **weekly**.
- On the host, `localhost:6333` is Qdrant and `/mnt/samsung-sata/mav-rag/hcp-exports/` is the ingest
  directory (confirmed by the existing script, which already `ssh`es to the host and targets exactly
  these). So on the host both operations are genuinely local.
- Schedule: **weekly**, early morning America/Chicago (UTC-5). Exact `OnCalendar` set in the plan.

### Language / runtime — keep TypeScript, ship a self-contained JS bundle

- Keep the existing TS logic (it encodes hard-won HCP quirks: pagination, line-item key fallbacks,
  CSV escaping). Porting to Python to "match the mav-rag stack" is risk with no payoff.
- Build a **self-contained JS bundle** locally (esbuild, `--platform=node --bundle`) so AIWA needs
  only a Node runtime — no `node_modules`, no `tsx`, no Playwright on the host.
- **Node runtime on the host is a Phase-0 verification** (below). If Node is not present and Carter
  prefers not to install it on the host, the fallback is a pinned `node:22-alpine` container invoked
  by the same timer (`docker run --rm -v …`). Host-Node is the default; the decision is recorded
  after Phase 0.

### Code changes (small, testable, keep one source of truth)

1. **Split auth so the runtime path carries no Playwright.**
   - New `src/hcp/auth-login.ts` — the Playwright interactive login (`loginAndSave`), PC-only, invoked
     by `npm run login`.
   - New `src/hcp/auth-cookies.ts` — `getCookieHeader()` (+ `COOKIES_FILE`), runtime-only, no
     Playwright import.
   - `client.ts` imports from `auth-cookies.ts`. `auth.ts` is retained as a thin re-export shim so
     existing callers/scripts don't break.
2. **Branch the publish step on an env flag** so the same code serves both environments:
   - `RAG_TARGET=remote` (default — current PC behavior: `ssh` Qdrant delete + `scp` CSV). This keeps
     the PC job working unchanged as the rollback path.
   - `RAG_TARGET=local` (AIWA): Qdrant delete becomes `fetch('http://localhost:6333/…')`; the CSV
     publish becomes a local `fs.copyFile` to the ingest path. No `ssh`, no `scp`, no key.
   - Both paths behind one small `publishToRag()` function; no logic duplication.
   - Config knobs (env): `RAG_TARGET`, `QDRANT_URL` (default `http://localhost:6333`),
     `RAG_INGEST_DIR` (default `/mnt/samsung-sata/mav-rag/hcp-exports`).

### HCP cookie provisioning + refresh (no scp, no key)

- Carter runs `npm run login` on the PC (unchanged, interactive browser).
- The resulting `auth/hcp-cookies.json` is placed onto AIWA **through Orca** (the sanctioned channel)
  into the job's private cookie path on the host (e.g. `/opt/hcp-estimates-sync/secrets/hcp-cookies.json`,
  mode `600`). Never committed, never `scp`ed with the AIWA key.
- The job's env points `COOKIES_FILE` at that path.
- On a 401 / expired-session, the job **exits non-zero with a loud, specific message**
  ("HCP session expired — run `npm run login` on the PC and re-place the cookie file via Orca"), and
  the systemd unit surfaces the failure (journal + optional `OnFailure` alert). No silent stale runs.

### Deployment mechanism

- Author everything in this repo (bundle build script, systemd unit + timer, deploy runbook).
- Deploy artifacts to AIWA **via Orca** into `/opt/hcp-estimates-sync/` on the host:
  `app.js` (the bundle), `hcp-estimates-sync.service`, `hcp-estimates-sync.timer`, an `EnvironmentFile`
  with the `RAG_TARGET=local` config (no secrets in git), and the Orca-placed cookie file.
- Nothing about the mav-rag stack (`/opt/mav-rag`, Qdrant, ingest watcher) is modified.

## Phase 0 — AIWA-side verification (read-only, in the Orca sandbox first)

Confirm before building the live artifacts; record findings in the plan:

1. Node runtime present on the host (`node --version`)? If absent, switch to the pinned-container
   fallback.
2. `/mnt/samsung-sata/mav-rag/hcp-exports/` exists and is the watched ingest dir; the ingest watcher's
   trigger (file-drop vs container restart — the current PC watcher restarts `mav-rag-ingest`; confirm
   whether a plain file drop is enough or a restart signal is needed).
3. Qdrant reachable at `localhost:6333`; collection `grizzly_hcp` exists; the points-delete filter
   shape is current.
4. A safe **non-prod validation target** for the destructive points-delete (a scratch collection or a
   sandbox Qdrant) so the delete+reindex is proven without touching live `grizzly_hcp` first.

## Testing

- **Local unit tests** (PC, no network): `publishToRag()` selects the right branch per `RAG_TARGET`;
  local branch computes the correct Qdrant URL + ingest path and performs `copyFile`; remote branch
  preserves the exact existing `ssh`/`scp` commands; auth split — `client.ts` runtime path imports no
  Playwright (assert via bundle inspection / import graph).
- **Bundle smoke test** (PC): build `app.js`, run with `RAG_TARGET=local` against a local throwaway
  Qdrant + temp dir, assert CSV written + points-delete issued.
- **Sandbox validation** (Orca AIWA sandbox): run the bundle against the non-prod Qdrant target from
  Phase 0; verify CSV lands, delete+reindex behaves, row counts sane.

## Release path (per AIWA / Proxmox standard — non-negotiable)

1. Build + test locally; commit the reviewed candidate; note the exact commit + a rollback ref.
2. Validate that exact ref in the **Orca sandbox** against the non-prod Qdrant target.
3. **Carter-gated apply** to live `.12` via Orca: place artifacts + cookie file, `systemctl daemon-reload`,
   enable the timer. Each unit action is an explicit approval moment. No process on `.12` is
   restarted/stopped without approval.
4. First live run: trigger once manually (Carter-approved), verify against ground truth (Qdrant point
   counts, ingest log, a RAG query for a known recent estimate), then let the weekly timer take over.
5. Record evidence in `memory/` (grizzly-hcp) and the brain vault; keep the PC job as the rollback path.

## Rollback

- The PC `npm run sync-estimates` remains fully functional (default `RAG_TARGET=remote`, key + scripts
  untouched). If the AIWA job misbehaves, disable the timer and run the PC job as before.
- No key removal, no deletion of PC scripts in this spec — that is a later, separately-gated step once
  **all** key consumers have moved.

## Success criteria

- The weekly systemd timer on `.12` runs `sync-estimates` end-to-end with **zero** SSH/SCP and **zero**
  use of `id_ed25519_proxmox`.
- Live `grizzly_hcp` Qdrant reflects a fresh enriched-estimates index after a run; a RAG query returns
  current line-item detail.
- HCP session expiry produces a clear, actionable failure (no silent stale data).
- The PC rollback path still works unchanged.

## Out of scope

- Removing / passphrase-locking `id_ed25519_proxmox` (the enforcement hard-stop — later, gated on all
  consumers moving).
- The other key consumers: `push-customers/jobs/pricebook`, `sync-pricebook`, `mav-rag-build/hcp-scraper`,
  `sync-from-proxmox.ps1`.
- Full grizzly-hcp relocation to AIWA.
- Any change to the mav-rag stack, the ingest watcher, or Qdrant configuration.
- The soft-layer enforcement rollout (mirror pointers, Hermes rule, `orca` banner) — tracked separately.

## Open items

- HCP session-cookie expiry cadence (how often relogin is actually needed) — measure and document;
  drives how annoying the manual refresh is and whether it needs a reminder.
- Ingest trigger mechanism (file-drop sufficient vs restart signal) — resolved in Phase 0.
