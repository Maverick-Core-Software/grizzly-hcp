# Project Journal

Entries are append-only. History is never rewritten.

---

## 2026-07-25 — sync-estimates AIWA relocation

Moved the `sync-estimates` weekly job from the Windows PC to run natively on the Proxmox host
at `192.168.1.12` as a systemd timer.

Key outcomes:
- Split HCP auth module: Playwright-free half (`auth-cookies.ts`), interactive login half
  (`auth-login.ts`), compatibility shim (`auth.ts`).
- Made the Qdrant publish step switchable between `remote` (SSH+SCP, default) and `local`
  (direct HTTP to Qdrant + local file copy) via `src/hcp/rag-publish.ts`.
- esbuild bundle produces `dist/sync-estimates.mjs` — no Playwright, no node_modules on target.
- systemd units + timer under `deploy/aiwa/`.
- Operator runbook at `docs/AIWA-DEPLOY-sync-estimates.md`.
- Design spec at `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md`.
- No deployment to Proxmox has happened yet — separate human-approved step.

Purpose: run the job on the same host as RAG/Qdrant so the publish step is local, removing
the dependency on a passphrase-less SSH key (first step toward retiring that key entirely).

---

## 2026-07-27/28 — sync-estimates cutover to AIWA complete

Executed the deployment planned on 2026-07-25. The job now runs natively on the Proxmox host
and the PC has no trigger for it. Two uses of the passphrase-less deploy key are gone.

What happened, in order:

- **Staged and test-run.** Bundle, env file, and cookies placed at `/opt/hcp-estimates-sync/`,
  checksum-verified against the local build. A manual `node` run succeeded: 1073 jobs over 11
  pages, CSV 353239 bytes (same size the PC produced), Qdrant `grizzly_hcp` cleared and
  republished back to 2120. No deploy key involved anywhere in the run.
- **PC trigger retired.** PM2 entry `sync-estimates-weekly` deleted and the dump persisted
  (15 → 13 entries, no `cron_restart` remaining). Backup at
  `C:\ProgramData\pm2\dump.pm2.bak-pre-sync-estimates-delete-20260727`.
- **Timer installed and armed.** Units copied to `/etc/systemd/system/`, sha256-verified,
  `systemd-analyze verify` clean. Next elapse Sun 2026-08-02 03:30:32 CDT, `Persistent=yes`,
  5min jitter. Enabling the timer did not start the service.
- **Hardened path validated.** `systemctl start` of the real unit: `Result=success`,
  `ExecMainStatus=0`, 43s. Sandbox directives verified live from inside the process namespace,
  not inferred from the unit file. Qdrant settled at 2120 green across five consecutive samples.

Two corrections worth carrying forward:

- **`pm2 stop` would not have disarmed the job.** In PM2 7.0.3 only `deleteProcessId` and
  `restartProcessId` call `God.deleteCron()`; `stopProcessId` never does, and `God.registerCron()`
  runs before the `autostart === false` check. A `cron_restart` + `autorestart:false` entry's
  resting state *is* `stopped`, and this one fired at `created_at 2026-07-26 02:00:02` while
  showing `stopped`. Status is not a signal for whether a schedule is live — check `dump.pm2`.
  Section 7.0 of the runbook originally said `stop`; that was wrong and has been corrected.
- **Two Windows gotchas.** `gsudo cmd /c "a && b"` can drop into an interactive shell instead of
  running the chain — write a `.cmd` file and `gsudo ./file.cmd` instead. And `pm2` is a `.cmd`
  shim, so a batch file must use `call pm2 …` or control transfers and every later line is
  silently skipped. The second one caused a `pm2 save` to not run while still reporting success;
  it was caught only by checking `dump.pm2`'s mtime rather than trusting the exit code.

Remaining deploy-key consumers (not yet relocated): `sync-pricebook`, `push-customers`/`jobs`/
`pricebook`, `Watch-HCPExports`, `index-docs`, `sync-from-proxmox.ps1`. The key cannot be retired
until those are handled.

---

## 2026-07-28 — catalog + estimates sync built

Built `hcp-catalog-sync`, the second job in the deploy-key relocation. It exports the HCP price
book, customers, and estimates and publishes all three into the RAG ingest directory on AIWA.
**Built and committed, not deployed** — installing the unit and applying the mav-rag ingest change
are separate human-approved steps that have not happened.

What was added:

- `src/hcp/export-estimates.ts` (`npm run export-estimates`) — the first real HCP estimates export
  that has ever existed here. Pulls `/beta/estimates`, then per-option line items from
  `/alpha/estimates/{option}/line_items`. ~810 estimates producing ~948 CSV rows, one per option,
  carrying `outcome` (open/won/lost) and per-option totals.
- `src/hcp/sync-catalog.ts` (`npm run sync-catalog`, `npm run build:sync-catalog` ->
  `dist/sync-catalog.mjs`) — one self-contained bundle running all three exports. The estimates
  step deletes Qdrant points of `type = "estimate"` before writing, so re-runs replace rather than
  accumulate; it never touches `type = "job"`.
- `export-pricebook.ts` and `export-customers.ts` became importable functions with env-overridable
  output paths. `publishCsv` takes an optional destination filename and refuses non-default names
  on the remote target. `deleteJobPoints` generalized to `deletePointsByType`.
- `deploy/aiwa/hcp-catalog-sync.{service,timer,env.example}` — weekly oneshot, Sundays 04:30
  America/Chicago, install root `/opt/hcp-catalog-sync/`, sharing the existing job's cookie file so
  one session refresh fixes both jobs.
- `deploy/mav-rag/` — a byte-exact snapshot of the live ingest plus a modified copy adding an
  `estimate` type, and a README covering apply/verify/rollback.
- `docs/AIWA-DEPLOY-catalog-sync.md` — twelve-section operator runbook.

Deleted: `scripts/sync-pricebook.sh`, `push-pricebook.sh`, `push-customers.sh`, `push-jobs.sh`,
`weekly-sync-pricebook.ps1`, and their npm entries. `weekly-sync-all.ps1` was rewritten down to the
brain-vault ingest step. Rollback for these is `git checkout f57812a~1 -- <paths>`, not re-running
a script — the scripts no longer exist.

Findings worth keeping:

- **`sync-estimates` never exported estimates.** It and `export-jobs.ts` both call `/alpha/jobs`
  with the same header; sync-estimates is a strict superset. The deployed `hcp-estimates-sync` unit
  is a jobs sync. The name is historical and was deliberately left alone, so both runbooks now say
  so explicitly. Real estimates were not exported by anything until this build.
- **The weekly scheduled task had been failing every Sunday** (last result 1) because
  `weekly-sync-all.ps1` pointed at a project directory that does not exist. The price book in the
  RAG had therefore not refreshed since 2026-06-30. Fixed as part of this work.
- **`/opt/mav-rag` is not a git repository.** The ingest image is *built* from source
  (`build: ./ingest` in its compose file), so `docker restart mav-rag-ingest` silently keeps
  running the old code — a rebuild is required. The runbook draft said "restart"; that was caught
  by reading the compose file rather than trusting the plan, and corrected.
- **Transferring a file off AIWA within the Orca-only rule.** `terminal read` returns no output for
  remote environments and `terminal show`'s preview is hard-capped at 300 characters, so there is
  no obvious way to read a 21KB file back. Compressing first solved it: `gzip -9c | base64 -w0`
  reduced 21,636 bytes to 6,199 characters, retrieved in 26 scripted preview reads with
  marker-delimited extraction and verified byte-exact by sha256. No listening socket, no remote
  shell, no process started on the host.
- **The estimate branch in `detect_type` is checked before the job branch on purpose.** The
  estimates export also carries a customer name and a total, and the jobs sync deletes every point
  with `type == "job"` — so a future column change must not let estimates fall through. Verified
  with an adversarial header carrying both sets of columns.

Remaining deploy-key consumers: `Watch-HCPExports`, `index-docs`, `sync-from-proxmox.ps1`. The
five publish scripts are gone from the repo but their replacement is not yet running on AIWA, so
their share of the key's uses is only retired once `hcp-catalog-sync` is deployed.
