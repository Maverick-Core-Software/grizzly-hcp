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

## Cutover Status (2026-07-27)

**Staged and test-run on AIWA; timer not yet enabled.**

Done:

- Bundle, env file, and cookies staged at `/opt/hcp-estimates-sync/` and checksum-verified
  against the local build (`sync-estimates.mjs` sha256 `fc8f05f9…`, cookies sha256 `5e2ce512…`).
- **Manual run succeeded 2026-07-28 03:04 UTC.** Exit 0; 1073 jobs pulled from the HCP API over
  11 pages; CSV written at 353239 bytes — the same size the PC path produced; ingest archived it
  to `processed/20260728_030851_estimates-enriched.csv`; Qdrant `grizzly_hcp` went 2120 → 1147
  (stale points cleared) → back to **2120 exactly** and held. No deploy key was used anywhere
  in the run, which was the point of the relocation.
- **PC-side trigger retired 2026-07-27 23:03.** PM2 entry `sync-estimates-weekly` deleted and the
  dump persisted; dump went 15 → 13 entries with no `cron_restart` remaining.

## What Is NOT Done Yet

- **The systemd units are not installed.** `/etc/systemd/system/` has no `hcp-estimates-sync.*`,
  so nothing is scheduled on AIWA. Combined with the PM2 deletion, the job currently has **no
  schedule on either host** — it will not run again until the timer is enabled.
- Enabling the timer requires Carter's explicit approval (Section 7.1 of the runbook).

## PM2 Retirement — Why `delete`, Not `stop`

`pm2 stop` would **not** have worked. In PM2 7.0.3 only `deleteProcessId` and `restartProcessId`
call `God.deleteCron()`; `stopProcessId` never does. `God.registerCron()` also runs before the
`autostart === false` check, so a never-started entry still has an armed cron. This entry's
resting state *is* `stopped` (`autorestart: false`), and it fired at `created_at 2026-07-26
02:00:02` while showing `stopped` — so status is not a usable signal for whether the schedule is
live. Verify against `C:\ProgramData\pm2\dump.pm2`, not the CLI table.

Rollback definition and the two Windows gotchas that bit during the cutover (`gsudo cmd /c "a && b"`
dropping to an interactive shell; a batch file needing `call pm2 …` or later lines are silently
skipped) are recorded in Sections 7.0 and 10 of `docs/AIWA-DEPLOY-sync-estimates.md`.

Pre-cutover dump backup: `C:\ProgramData\pm2\dump.pm2.bak-pre-sync-estimates-delete-20260727`.
Note `pm2 save` also dropped `customer-chat-server` from the dump — it was in the dump but not in
the live process list. It survives only in that backup.

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
