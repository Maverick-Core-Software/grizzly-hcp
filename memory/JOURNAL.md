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
