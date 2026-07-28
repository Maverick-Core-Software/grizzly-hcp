# Handoff — sync-estimates AIWA Relocation

**Status as of 2026-07-28: this phase is COMPLETE.** The next agent's job is the *next* phase, not
this one. Read "Start Here" and go.

---

## Start Here

### The mission behind all of this

A passphrase-less SSH deploy key on the Windows PC lets any agent reach the AIWA Proxmox host
directly. The rule against ad-hoc SSH is written into every harness's instructions, and agents
still violate it — a pi/DeepSeek agent acknowledged the rule and then used the key anyway. Soft
instructions do not hold.

The plan is therefore to make violation *impossible* rather than forbidden: **relocate every job
that needs the key so it runs natively on AIWA, then retire the key.** A key that does not exist
cannot be misused by any harness, present or future. Retiring it is the hard stop.

This is not a cleanup task. It is the enforcement mechanism.

### What is already done

`sync-estimates` — the weekly HCP estimate scraper — has been fully relocated. It now runs on the
Proxmox host as a systemd timer, publishes to Qdrant over localhost, and touches no key at all.
The PC's PM2 trigger for it is deleted. That eliminated **2 of the key's uses**.

### What to do next

Relocate the remaining key consumers, using `sync-estimates` as the proven template. In rough
order of ease:

| Consumer | Notes |
|---|---|
| `sync-pricebook` | Closest sibling to `sync-estimates`; same publish path. Do this one first. |
| `push-customers` / `push-jobs` / `push-pricebook` | Share the `rag-publish.ts` mechanism already made switchable. |
| `Watch-HCPExports` | A PC-side file watcher. Consider whether it is still needed once producers run on AIWA. |
| `index-docs` | Check whether its inputs even originate on the PC any more. |
| `sync-from-proxmox.ps1` | Pulls *from* AIWA. Likely needs a different answer than relocation. |

**Only when that list is empty** does the key-retirement step become available. Do not retire the
key early — verify each consumer is genuinely dead first, the same way `sync-estimates` was
verified (see "How this work gets verified" below).

### One item still pending on the completed phase

The timer has been validated but **has never fired autonomously**. First real fire is
**Sun 2026-08-02 03:30 CDT**.

A scheduled verification task is already registered and will run itself — you do not need to set
it up:

- **`C:\Users\carte\.claude\scheduled-tasks\verify-hcp-estimates-sync-timer\SKILL.md`**
- Fires once at **2026-08-02 03:35 CDT**, then auto-disables.
- Caveat: scheduled tasks only run while the Claude app is open. If it was closed at 03:35, the
  task runs on next launch — still valid, since all the evidence it reads is persistent.

If that check has already run by the time you read this, its result is in `memory/JOURNAL.md`.
If it reported FAIL, **that takes priority over starting new relocation work.**

---

## Required Reading Before You Touch Anything

Read these in order. Do not skip the brain vault — it holds cross-project findings that are not in
this repo.

| # | Path | Why |
|---|---|---|
| 1 | `memory/JOURNAL.md` → entries **2026-07-25** and **2026-07-27/28** | The full narrative of the relocation and cutover, including two corrections that will bite you if you don't know them. The 07-27/28 entry is the important one. |
| 2 | `C:\Workspace\Active\brain\projects\grizzly-hcp.md` → sections **2026-07-25** and **2026-07-28** | Brain vault project note. The 2026-07-28 section carries the generalizable findings (PM2 cron semantics, Windows batch traps) and the current live state. |
| 3 | `docs/AIWA-DEPLOY-sync-estimates.md` | Operator runbook. **Section 7.0** = PM2 retirement, **Section 10** = rollback. This is the template to copy for the next consumer. |
| 4 | `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md` | Design spec — the architectural rationale for the whole pattern. |
| 5 | `C:\Workspace\Active\brain\knowledge\infrastructure.md` | Host IPs, keys, services. Read it rather than memorizing from any handoff. |

Also relevant, if the enforcement side of the mission is in scope for your session:
`C:\Workspace\Shared\Agents\Hermes-Supervisor` — the cross-harness guard work lives there,
including `tools/aiwa-guard.sh`.

---

## Hard Rules For This Work

These are not suggestions. The first two are the entire point of the project.

- **Reach AIWA only through Orca.** No ssh, no scp, no ad-hoc remote shell. Environment name is
  `aiwa-host`, and **every** Orca terminal command needs `--environment aiwa-host` or it fails with
  `selector_not_found`.
- **`tools/aiwa-guard.sh` blocks any command text containing the literal tokens `ssh` or `scp`.**
  This includes git commit messages. Write around it — say "deploy key" or "remote shell".
- **Get explicit approval before changing live state** — any service start/stop/restart, timer
  action, unit reload, or PM2 operation. Verification and read-only inspection need no approval.
- **Never stage `.env.bak-pre-lxc-20260721-130527`.** It is untracked, contains real credentials,
  and sits in this repo's root. Check `git status` before every `git add`; stage files by name,
  never `git add -A`.
- **Do not develop against live state.** `/opt/hcp-estimates-sync/` on AIWA is a deployment target.
  Author changes here, commit, push, then deploy the reviewed commit.

---

## Two Findings That Will Cost You Hours If You Don't Know Them

Both were discovered the hard way during this cutover.

### `pm2 stop` does NOT disarm a `cron_restart` job

In PM2 7.0.3, `God.deleteCron()` is called from only `deleteProcessId` and `restartProcessId`.
`stopProcessId` never touches `God.CronJobs`. Worse, `God.registerCron()` runs *before* the
`autostart === false` check, so an entry that never started still has an armed cron.

A `cron_restart` + `autorestart:false` entry's **resting state is `stopped`** — so the CLI status
tells you nothing about whether the schedule is live. This entry showed `stopped` and fired anyway
at `created_at 2026-07-26 02:00:02`, exactly matching its cron.

**Only `pm2 delete` disarms it. Verify against `C:\ProgramData\pm2\dump.pm2`, not the CLI table.**

### Two Windows batch traps

- `gsudo cmd /c "a && b"` can drop into an *interactive* cmd instead of running the chain. Write a
  `.cmd` file and run `gsudo ./file.cmd` instead.
- `pm2` is a `.cmd` shim, so a batch file must use **`call pm2 …`**. Without `call`, control
  transfers away and every later line is silently skipped — while still reporting success. This
  caused a `pm2 save` to not run; it was caught only by checking `dump.pm2`'s mtime rather than
  trusting the exit code.

---

## How This Work Gets Verified

The standard the last phase was held to. Match it.

- **Run the real thing, don't reason about it.** The systemd sandbox was proven by executing the
  actual unit and inspecting the live process namespace with `nsenter -t <pid> -m`, not by reading
  the unit file.
- **Exit 0 is not proof of success.** Check the journal for actual work done — job counts, rows
  written, points cleared.
- **Sample metrics repeatedly.** A single Qdrant reading can catch a mid-reindex value that
  coincidentally looks right. Take 5 consecutive samples and require a plateau.
- **Distrust agent claims, including your own earlier ones.** Every number in this document was
  read off the host.

---

## Current Live State

### On AIWA (Proxmox host, `192.168.1.12`, Orca env `aiwa-host`)

| Item | Value |
|---|---|
| Timer | `hcp-estimates-sync.timer` — enabled/active, next elapse **Sun 2026-08-02 ~03:30 CDT**, `Persistent=yes`, `RandomizedDelaySec=5min` |
| Units | `/etc/systemd/system/hcp-estimates-sync.{service,timer}`, root:root 644, sha256-verified against repo copies |
| Payload | `/opt/hcp-estimates-sync/` — `sync-estimates.mjs`, `hcp-estimates-sync.env`, `secrets/hcp-cookies.json` |
| Service | `inactive` (correct — oneshot at rest) |
| Host TZ | `America/Chicago` (CDT, -0500) |
| Qdrant | `grizzly_hcp` at 2120 points, green |

### On CartersPC

| Item | Value |
|---|---|
| PM2 `sync-estimates-weekly` | **DELETED.** Dump went 15 → 13 entries, no `cron_restart` remaining |
| Dump backup | `C:\ProgramData\pm2\dump.pm2.bak-pre-sync-estimates-delete-20260727` (565,917 bytes, 15 entries) |
| Rollback | **Recreate** the PM2 entry — full definition in Section 10 of the runbook. `pm2 start` will NOT work; the entry no longer exists. |

Note: `pm2 save` also pruned `customer-chat-server` from the dump. That is expected, not a loss —
that service was already relocated to AIWA as part of Carter's ongoing PM2 migration. Expect more
such dump/live gaps while that migration continues.

---

## Evidence From the Completed Phase

Kept for audit. Skip if you only need to start the next task.

### Manual run (unsandboxed, 2026-07-28 03:04 UTC)

Exit 0. 1073 jobs over 11 pages, line items on 1065/1073, CSV 353239 bytes — the same size the PC
produced the prior Sunday. Archived to `processed/20260728_030851_estimates-enriched.csv`. Qdrant
went 2120 → 1147 (stale cleared) → walked back to **2120 exactly** and held.

### Hardened path validation (2026-07-28 04:19 UTC)

`systemctl start hcp-estimates-sync.service` → `Result=success`, `ExecMainStatus=0`, 43s wall,
1.901s CPU, 75.9M peak. Identical pipeline behavior: 1073 jobs, 1065/1073 with line items, CSV
353239 bytes.

Every sandbox directive verified live from inside the running process, not inferred from the unit
file:

| Directive | Evidence |
|---|---|
| sandbox applied at all | job mount ns `4026533296` ≠ PID 1 `4026531832` |
| `NoNewPrivileges=yes` | `/proc/<pid>/status` → `NoNewPrivs: 1` |
| `ProtectSystem=full` | `touch /usr/_probe`, `/etc/_probe` → `Read-only file system` |
| `ProtectHome=yes` | `/home` 0 entries, `/root` empty |
| `PrivateTmp=yes` | `/tmp` 0 entries (host `/tmp` is not empty) |
| required write paths | `/opt/hcp-estimates-sync` and ingest dir both writable |

Downstream: CSV mtime `23:20:37.364` matched `ExecMainExitTimestamp` exactly; ingest archived to
`processed/20260728_042403_estimates-enriched.csv` and drained the dir; Qdrant read **2120 green on
five consecutive 15s samples**.

The 43s runtime is the job alone. An earlier "~4 minutes" figure spanned job start through
downstream re-embedding — a different measurement, not a regression.

---

## Architecture Reference

### Code changes that made relocation possible

| File | What it does |
|------|-------------|
| `src/hcp/auth-cookies.ts` | Playwright-free half of HCP auth. Reads cookie JSON at `HCP_COOKIES_FILE`, returns a `Cookie:` header. |
| `src/hcp/auth-login.ts` | Interactive login via Playwright. Only runs on `npm run login`. |
| `src/hcp/auth.ts` | Compatibility shim re-exporting both halves so existing importers are unchanged. |
| `src/hcp/rag-publish.ts` | Makes publish switchable: `remote` (original key-based path) or `local` (direct HTTP to Qdrant + file copy). **This is the key abstraction to reuse for the next consumer.** |
| `dist/sync-estimates.mjs` | esbuild self-contained bundle (`npm run build:sync-estimates`) — no Playwright, no `node_modules` on target. Gitignored; rebuild before deploying. |
| `deploy/aiwa/` | `hcp-estimates-sync.{service,timer,env.example}`, validated with `systemd-analyze verify`. |

### Configuration

Config is entirely environment variables. On AIWA they come from
`/opt/hcp-estimates-sync/hcp-estimates-sync.env` (template: `deploy/aiwa/hcp-estimates-sync.env.example`).
On the PC, from `.env`.

| Variable | AIWA value | Purpose |
|----------|-----------|---------|
| `RAG_TARGET` | `local` | `local` = direct Qdrant HTTP + local copy. `remote` = original key-based path. |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint when `RAG_TARGET=local`. |
| `QDRANT_COLLECTION` | `grizzly_hcp` | Collection whose stale `type=job` points get cleared. |
| `RAG_INGEST_DIR` | `/mnt/samsung-sata/mav-rag/hcp-exports` | Watched dir; the ingest service archives from here. |
| `ESTIMATES_CSV_PATH` | `/opt/hcp-estimates-sync/estimates.csv` | Where the CSV is written before publishing. |
| `HCP_COOKIES_FILE` | `/opt/hcp-estimates-sync/secrets/hcp-cookies.json` | **Secret — never committed.** |

`RAG_TARGET=remote` also honors `SSH_KEY`, `PROXMOX`, `REMOTE_PATH`. Those exist only for the PC
rollback path and must not be set on AIWA.

### Ingest mechanism

`mav-rag` runs a `watchdog.observers.Observer` on `/data/hcp-exports`, bind-mounted from
`/mnt/samsung-sata/mav-rag/hcp-exports`. Dropping a file is sufficient — no API call needed. Files
are archived to `/mnt/samsung-sata/mav-rag/processed/` with a UTC-timestamp prefix.

### HCP auth model

Browser-session cookies, not an API key. Runtime is a plain `fetch` with a `Cookie:` header.
Expiry surfaces as a 401 and requires a manual `npm run login` (Playwright) on the PC, then
re-copying the cookie file to AIWA. **This is the most likely real-world failure mode for the
weekly run.**

---

## Repo Facts

- Repo: `C:\Workspace\Active\grizzly-hcp`
- Branch: `sync-estimates-aiwa`, pushed to `https://github.com/Maverick-Core-Software/grizzly-hcp.git`
- Relevant commits: `790998f` (test run + PM2 retirement), `0220317` (timer cutover),
  `06dbe06` (hardened path validation + journal)
- Brain vault commit: `f9b80d9` in `C:\Workspace\Active\brain`
- `git status` should show only `?? .env.bak-pre-lxc-20260721-130527` — leave it untracked.

## Loose Ends (non-urgent, unrelated to the mission)

- `weekly-sync-all.ps1` has a stale `$ProjectDir = "C:\Users\carte\Grizzly-HCP"` that breaks that
  scheduled task every Sunday.
- Credentials in `.env.bak-pre-lxc-20260721-130527` are worth rotating.
