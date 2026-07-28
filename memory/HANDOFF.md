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

- **Timer installed and armed 2026-07-27 23:13 CDT.** Units copied to `/etc/systemd/system/`
  (root:root 644; sha256 verified against the repo copies — service `74189778…`, timer `8c81ff1f…`),
  `systemd-analyze verify` clean, `systemctl enable --now hcp-estimates-sync.timer` rc=0. State is
  `enabled`/`active`, next elapse **Sun 2026-08-02 03:30:32 CDT**, `Persistent=yes`,
  `RandomizedDelaySec=5min`. Host timezone confirmed `America/Chicago`. Enabling the timer did not
  start the service (`hcp-estimates-sync.service` remained `inactive`), as intended.

**The cutover is complete: AIWA now owns the schedule and the PC has no trigger.**

## Hardened Path Validated (2026-07-28)

The earlier test run was a plain `node` process, so the systemd sandbox had never actually been
exercised. Since the PC fallback is gone, a sandbox failure would have surfaced only as a silent
miss on Sunday 03:30. `systemctl start hcp-estimates-sync.service` was run to settle it with
evidence rather than reasoning.

**Result: `Result=success`, `ExecMainStatus=0`**, 23:19:54 → 23:20:37 CDT (43s wall, 1.901s CPU,
75.9M peak). The pipeline behaved identically to the unsandboxed run: 1073 jobs, line items on
1065/1073, CSV 353239 bytes, Qdrant points cleared and republished.

Each directive was verified live from inside the running process (`nsenter -t <pid> -m`) rather
than assumed from the unit file:

| Directive | Evidence |
|---|---|
| sandbox applied at all | job mount ns `4026533296` ≠ PID 1 `4026531832` |
| `NoNewPrivileges=yes` | `/proc/<pid>/status` → `NoNewPrivs: 1` |
| `ProtectSystem=full` | `touch /usr/_probe` and `/etc/_probe` → `Read-only file system` |
| `ProtectHome=yes` | `/home` 0 entries; `/root` empty |
| `PrivateTmp=yes` | `/tmp` 0 entries (host `/tmp` is not empty) |
| required write paths | `/opt/hcp-estimates-sync` and the ingest dir both writable |

Downstream confirmed: CSV mtime `23:20:37.364` matches `ExecMainExitTimestamp` exactly; ingest
archived it to `processed/20260728_042403_estimates-enriched.csv` and drained the ingest dir;
Qdrant `grizzly_hcp` read **2120 green on five consecutive 15s samples**, proving a settled
plateau rather than a coincidental mid-reindex reading.

Note the 43s runtime is the job alone. The ~4 minutes observed on the earlier run spanned job
start through downstream ingest and re-embedding, which is a different measurement.

## What Is NOT Done Yet

- Nothing blocking. The timer is armed and the exact execution path it will use has been proven
  end to end.

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

`pm2 save` also dropped `customer-chat-server` from the dump, because it was in the dump but not
in the live process list. That is correct, not a loss: Carter has relocated that service to AIWA
as part of an ongoing migration of PC PM2 entries. Expect further such gaps between the dump and
the live list while that migration continues — a stale dump entry is the normal footprint of an
already-migrated service, so re-saving the dump prunes them.

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
