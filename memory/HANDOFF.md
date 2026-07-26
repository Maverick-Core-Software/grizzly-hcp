# Handoff — sync-estimates AIWA Relocation

## What Changed

The `src/hcp/sync-estimates.ts` job (weekly, scrapes completed HCP estimates and syncs them
to Qdrant) has been relocated from the Windows PC to run natively on the Proxmox host
at `192.168.1.12` as a systemd timer.

### Code changes

| File | What it does |
|------|-------------|
| `src/hcp/auth-cookies.ts` | Playwright-free half of HCP auth (reads cookies from env). Split from the old monolith. |
| `src/hcp/auth-login.ts` | Interactive login using Playwright. Only runs when someone invokes `npm run login`. |
| `src/hcp/auth.ts` | Compatibility shim — exports `{ auth }` from the old `src/hcp/auth.ts` API so nothing else needs to change. |
| `src/hcp/rag-publish.ts` | Makes the publish step switchable: `remote` target (original SSH+SCP to AIWA, default) or `local` target (direct HTTP to Qdrant + local file copy). |
| `dist/sync-estimates.mjs` | esbuild self-contained bundle — no Playwright, no node_modules needed on the target. |
| `deploy/aiwa/` | Systemd units (`sync-estimates.service`, `sync-estimates.timer`) and deployment artifacts for the Proxmox host. |
| `docs/AIWA-DEPLOY-sync-estimates.md` | Operator runbook for deploying and operating the relocated job. |
| `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md` | Design spec covering the full architecture rationale. |

### Design doc

Full spec at `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md`.

### Runbook

Operator instructions at `docs/AIWA-DEPLOY-sync-estimates.md` — deploy, verify, roll back.

## What Is NOT Done Yet

- **No deployment has happened.** The systemd units and bundle are in the repo but have not been
  copied to `192.168.1.12` and are not active.
- The PC-side workflow still works unchanged — that path is the rollback plan.

## Configuration

The job is configured via these environment variables (set in `deploy/aiwa/sync-estimates.env`
or passed to the systemd unit):

| Variable | Purpose |
|----------|---------|
| `HCP_COOKIE` | Housecall Pro session cookie |
| `HCP_SECRET` | Housecall Pro API secret |
| `RAG_URL` | RAG API URL (use `http://192.168.1.12:8181` on AIWA) |
| `SYNC_TARGET` | `remote` (SSH+SCP, default) or `local` (direct HTTP to Qdrant) |
| `SYNC_LOCAL_QDRANT_URL` | Qdrant URL when `SYNC_TARGET=local` |
| `SYNC_LOCAL_DOCS_DIR` | Local docs directory when `SYNC_TARGET=local` |

## Environments

- **Windows PC (current):** unchanged. Works as before via Playwright auth. Rollback path.
- **Proxmox AIWA (target):** systemd timer → `dist/sync-estimates.mjs`. No SSH key needed.
  Publish step goes `local` on this host.

## Key File Locations

| Path | Role |
|------|-----|
| `src/hcp/sync-estimates.ts` | Main job source |
| `dist/sync-estimates.mjs` | Bundled, Playwright-free binary |
| `deploy/aiwa/` | Systemd units + timer + env file |
| `docs/AIWA-DEPLOY-sync-estimates.md` | Operator runbook |
| `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md` | Design spec |
