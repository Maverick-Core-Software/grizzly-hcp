# Handoff — sync-estimates AIWA Relocation

## What Changed

The `src/hcp/sync-estimates.ts` job (weekly, scrapes completed HCP estimates and syncs them
to Qdrant) has been relocated from the Windows PC to run natively on the Proxmox host
at `192.168.1.12` as a systemd timer.

### Code changes

| File | What it does |
|------|-------------|
| `src/hcp/auth-cookies.ts` | Playwright-free half of HCP auth. Reads the cookie JSON file at `HCP_COOKIES_FILE` (default `auth/hcp-cookies.json`) and returns a `Cookie:` header. Exports `COOKIES_FILE` and `getCookieHeader()`. |
| `src/hcp/auth-login.ts` | Interactive login using Playwright. Exports `SESSION_DIR` and `loginAndSave()`. Only runs when someone invokes `npm run login`. |
| `src/hcp/auth.ts` | Compatibility shim — re-exports `COOKIES_FILE`, `getCookieHeader`, `SESSION_DIR`, `loginAndSave` so existing importers are unchanged, and keeps the CLI self-invoke block that backs `npm run login`. |
| `src/hcp/rag-publish.ts` | Makes the publish step switchable: `remote` target (original SSH+SCP to AIWA, still the default) or `local` target (direct HTTP to Qdrant + local file copy). Exports `resolveRagConfig()`, `deleteJobPoints()`, `publishCsv()`. |
| `dist/sync-estimates.mjs` | esbuild self-contained bundle (`npm run build:sync-estimates`) — no Playwright, no `node_modules` needed on the target. Gitignored; rebuild before deploying. |
| `deploy/aiwa/` | `hcp-estimates-sync.service`, `hcp-estimates-sync.timer`, `hcp-estimates-sync.env.example`. Units validated with `systemd-analyze verify`. |
| `docs/AIWA-DEPLOY-sync-estimates.md` | Operator runbook for deploying and operating the relocated job. |
| `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md` | Design spec covering the full architecture rationale. |

### Design doc

Full spec at `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md`.

### Runbook

Operator instructions at `docs/AIWA-DEPLOY-sync-estimates.md` — deploy, verify, roll back.

## What Is NOT Done Yet

- **No deployment has happened.** The systemd units and bundle are in the repo but have not been
  copied to `192.168.1.12` and are not active.
- The PC-side workflow still runs unchanged — that path is the rollback plan.
- **The PC schedule must be stopped as part of the cutover.** It is not a manual job: PM2 entry
  `sync-estimates-weekly` (cwd `C:\Workspace\Active\grizzly-hcp`, `cron_restart: 0 2 * * 0`) runs it
  Sundays at 02:00 America/Chicago. The AIWA timer fires Sunday 03:30, so leaving both enabled
  double-runs the job against the `grizzly_hcp` collection every week. See Section 7.0 of
  `docs/AIWA-DEPLOY-sync-estimates.md`. Stopping a PM2 process requires Carter's explicit approval.

## Configuration

The job is configured entirely through environment variables. On AIWA they come from
`/opt/hcp-estimates-sync/hcp-estimates-sync.env`, whose committed template is
`deploy/aiwa/hcp-estimates-sync.env.example`. On the PC they come from `.env`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `RAG_TARGET` | `remote` | `remote` = original SSH+SCP path; `local` = direct HTTP to Qdrant + local file copy. AIWA sets `local`. |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint used when `RAG_TARGET=local`. |
| `QDRANT_COLLECTION` | `grizzly_hcp` | Collection whose stale `type=job` points get cleared. |
| `RAG_INGEST_DIR` | `/mnt/samsung-sata/mav-rag/hcp-exports` | Directory the enriched CSV is copied into when `RAG_TARGET=local`. |
| `ESTIMATES_CSV_PATH` | repo-relative | Where the job writes the CSV before publishing it. |
| `HCP_COOKIES_FILE` | `auth/hcp-cookies.json` | HCP session cookie JSON. **Secret — never committed.** |

`RAG_TARGET=remote` additionally honors `SSH_KEY`, `PROXMOX`, and `REMOTE_PATH`; those exist
only to keep the PC rollback path working and should not be set on AIWA.

## Environments

- **Windows PC (current):** unchanged. Playwright login still works, `RAG_TARGET` still defaults
  to `remote`. This is the rollback path.
- **Proxmox AIWA (target):** systemd timer → `/usr/bin/node /opt/hcp-estimates-sync/sync-estimates.mjs`,
  Sundays 03:30 America/Chicago. With `RAG_TARGET=local` both remote operations become local,
  so the job needs no SSH key at all.

Verified read-only on the host 2026-07-26: node `/usr/bin/node` v22.23.1, TZ `America/Chicago`,
ingest directory present, Qdrant answering with the `grizzly_hcp` collection.

## Key File Locations

| Path | Role |
|------|-----|
| `src/hcp/sync-estimates.ts` | Main job source |
| `dist/sync-estimates.mjs` | Bundled, Playwright-free output (gitignored — rebuild before deploying) |
| `deploy/aiwa/` | `hcp-estimates-sync.{service,timer,env.example}` |
| `docs/AIWA-DEPLOY-sync-estimates.md` | Operator runbook |
| `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md` | Design spec |
