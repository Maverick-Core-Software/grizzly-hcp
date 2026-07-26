# AIWA Deployment — HCP Estimates Sync

> **⚠️ Every step that changes the running server below requires explicit human
> approval before it is performed. Do not automate or rush these steps.**

This document describes how to install the `hcp-estimates-sync` weekly job on a
headless Debian server. The job pulls new and updated job data from the Housecall
Pro external API, writes a CSV, clears stale Qdrant points over HTTP, and copies
the CSV into the RAG ingest directory.

## 1. What is being installed and why

A single-file Node.js bundle (`sync-estimates.mjs`) runs once per week via a
systemd timer to keep Grizzly's RAG knowledge base synchronized with the latest
HCP job data. It replaces the previous manual PC-run approach with a reliable,
auditable server-side schedule.

## 2. Pre-flight checklist

Before installing, confirm the following on the target server:

- **Node.js** is installed. Run `command -v node` and `node --version` — the bundle
  is built for **node20 or later**, and the service unit hardcodes the absolute path
  `/usr/bin/node`. If node lives elsewhere, correct `ExecStart` before installing.
- **Ingest directory** exists and is writable: `ls -ld /mnt/samsung-sata/mav-rag/hcp-exports`.
- **Qdrant** is reachable at `http://localhost:6333`. Run `curl -s http://localhost:6333/` and verify a response.
- **Qdrant collection** exists: run `curl -s http://localhost:6333/collections/grizzly_hcp` and confirm the collection is reported.

If any of these checks fail, resolve them before proceeding.

**Verified on the target host 2026-07-26 (read-only check through Orca):**

| Check | Result |
| --- | --- |
| Node | `/usr/bin/node`, v22.23.1 |
| Host timezone | `America/Chicago` — so the timer fires Sunday 03:30 Central |
| Ingest directory | present |
| Qdrant | answers on `localhost:6333`; `grizzly_hcp` collection exists |

## 3. File layout

Create the following directory structure on the server:

```
/opt/hcp-estimates-sync/
├── sync-estimates.mjs          ← the bundle (from this repo)
├── hcp-estimates-sync.env      ← environment file (see Section 4)
└── secrets/
    └── hcp-cookies.json        ← credentials (see Section 5)
```

Set ownership and permissions:

```bash
sudo chown -R root:root /opt/hcp-estimates-sync/
sudo chmod 755 /opt/hcp-estimates-sync/
sudo chmod 644 /opt/hcp-estimates-sync/hcp-estimates-sync.env
sudo chmod 700 /opt/hcp-estimates-sync/secrets/
sudo chmod 600 /opt/hcp-estimates-sync/secrets/hcp-cookies.json
```

The cookies file and its parent directory must be owner-only (700 / 600) because
they contain API session credentials.

## 4. Creating the environment file

Copy the template from this repo and place it on the server:

```bash
sudo cp deploy/aiwa/hcp-estimates-sync.env.example \
       /opt/hcp-estimates-sync/hcp-estimates-sync.env
```

Edit `/opt/hcp-estimates-sync/hcp-estimates-sync.env` and verify all values match
the server layout (Qdrant URL, ingest directory paths, CSV path). Do **not** change
the `HCP_COOKIES_FILE` path — it points to the secrets directory.

## 5. Producing and transferring the cookies file

The cookies file authenticates the job to the HCP external API. It expires and must
be refreshed periodically.

**On the Windows PC:**
1. Log into the HCP portal in a browser (Chrome recommended).
2. Export the session cookies to JSON using the browser's cookie export tool or
   an appropriate browser extension. Save the output as `hcp-cookies.json`.
3. Verify the file contains valid JSON with cookie entries.

**Transfer to the server:**
1. Transfer `hcp-cookies.json` to `/opt/hcp-estimates-sync/secrets/hcp-cookies.json`
   through **Orca** — the sanctioned channel for every AIWA action. Open a terminal
   in the `aiwa-host` environment and write the file there; do not reach the host
   any other way.
2. **DO NOT send the cookies file with `scp` and an SSH key.** Eliminating that key's
   use is the entire point of this relocation — using it here would defeat it.
3. After transfer, set permissions on the server:
   ```bash
   sudo chmod 600 /opt/hcp-estimates-sync/secrets/hcp-cookies.json
   sudo chown root:root /opt/hcp-estimates-sync/secrets/hcp-cookies.json
   ```

## 6. Manual test run

Before enabling the timer, run the job once manually to verify it works:

```bash
sudo -E node /opt/hcp-estimates-sync/sync-estimates.mjs
```

Or use the systemd service directly:

```bash
sudo systemctl start hcp-estimates-sync.service
```

**Healthy output** includes:
- Console messages showing jobs being pulled from the API
- CSV file written to `ESTIMATES_CSV_PATH` (default: `/opt/hcp-estimates-sync/estimates.csv`)
- Qdrant point deletion messages for stale data
- CSV copy confirmation to the ingest directory
- Exit code 0

If the job fails, check the journal (Section 8) before retrying.

## 7. Enabling and starting the timer

### 7.0 First: retire the PC-side trigger (REQUIRED — approval needed)

The job is **not** run by hand from the PC. It is scheduled by a PM2 entry on
CartersPC:

| Field | Value |
| --- | --- |
| PM2 name | `sync-estimates-weekly` |
| Script | `node_modules\tsx\dist\cli.mjs` with `src/hcp/sync-estimates.ts` |
| cwd | `C:\Workspace\Active\grizzly-hcp` |
| `cron_restart` | `0 2 * * 0` — Sundays 02:00 America/Chicago |

Verified 2026-07-26: that entry produced `data\estimates-enriched.csv` (353239 bytes)
at 02:01, and the byte-identical file was ingested on AIWA at 07:04:23 UTC.

**Both schedules writing the same Qdrant collection is the failure mode this step
prevents.** The AIWA timer fires Sunday 03:30 Central, 90 minutes after the PM2
entry. Enabling the timer while the PM2 entry is still active means the estimates
are pulled, the collection's stale points deleted, and the CSV republished twice
every Sunday.

Stop the PM2 entry **before** enabling the timer. This changes a running process,
so it requires Carter's explicit approval and must use the elevated PM2 pattern —
never user-space `pm2`:

```bash
"/c/Program Files/gsudo/Current/gsudo.exe" cmd /c "set PM2_HOME=C:\ProgramData\pm2 && pm2 stop sync-estimates-weekly && pm2 save"
```

Use `pm2 stop`, not `pm2 delete` — keeping the entry in the dump is what makes the
rollback in Section 10 a one-command operation.

### 7.1 Install the units

Install the unit files, timer, and environment file on the server (these come from
this repo):

```bash
sudo cp deploy/aiwa/hcp-estimates-sync.service /etc/systemd/system/
sudo cp deploy/aiwa/hcp-estimates-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hcp-estimates-sync.timer
```

Verify the timer is active:

```bash
sudo systemctl list-timers --all | grep hcp-estimates-sync
```

The timer is set to run **weekly on Sundays at 03:30** server local time with a
randomized delay of up to 5 minutes. The `Persistent=true` setting ensures that if
the machine is powered off during the scheduled time, the job fires on next boot.

Confirm the next run:

```bash
sudo systemctl status hcp-estimates-sync.timer
```

## 8. Reading job logs

All job output goes to the systemd journal with the identifier `hcp-estimates-sync`:

```bash
# Follow output in real time (if the job is currently running)
sudo journalctl --unit=hcp-estimates-sync.service --follow

# View the last run's output
sudo journalctl --unit=hcp-estimates-sync.service -n 50 --no-pager

# View the full history of runs
sudo journalctl --unit=hcp-estimates-sync.service --no-pager
```

## 9. Expired session — symptoms and recovery

The HCP API session (stored in the cookies file) eventually expires. The job will
fail and the journal will show an authentication error or an API response indicating
invalid or expired credentials.

**Recovery steps:**

1. **On the Windows PC**, log into the HCP portal again in a browser to refresh the
   session.
2. **Export** the new cookies to JSON as described in Section 5.
3. **Transfer** the new `hcp-cookies.json` to `/opt/hcp-estimates-sync/secrets/`
   through Orca, as in Section 5 — never with `scp` and an SSH key.
4. **Restore permissions**:
   ```bash
   sudo chmod 600 /opt/hcp-estimates-sync/secrets/hcp-cookies.json
   ```
5. **Run the job manually** to confirm it succeeds:
   ```bash
   sudo systemctl start hcp-estimates-sync.service
   ```
6. **Check the journal** for clean output:
   ```bash
   sudo journalctl --unit=hcp-estimates-sync.service -n 30 --no-pager
   ```

No timer or service changes are needed — only a fresh cookies file.

## 10. Rollback

Rollback has **two halves**, and the PC half is the one that actually restores
service. Do both.

**1. Stop the AIWA timer** (leave the files in place — that makes re-cutover cheap):

```bash
sudo systemctl disable --now hcp-estimates-sync.timer
```

The bundle, env file, and cookies file at `/opt/hcp-estimates-sync/` remain intact.
Only remove the units if you are abandoning the relocation entirely:

```bash
sudo rm /etc/systemd/system/hcp-estimates-sync.timer
sudo rm /etc/systemd/system/hcp-estimates-sync.service
sudo systemctl daemon-reload
```

**2. Restart the PC-side PM2 entry** (requires Carter's explicit approval):

```bash
"/c/Program Files/gsudo/Current/gsudo.exe" cmd /c "set PM2_HOME=C:\ProgramData\pm2 && pm2 start sync-estimates-weekly && pm2 save"
```

This restores the Sunday 02:00 schedule described in Section 7.0. Note that the
PC path uses the passphrase-less deploy key over SSH — rolling back re-introduces
that key use, which is the exact dependency this relocation removes. Treat rollback
as temporary and re-attempt the cutover once the blocking issue is fixed.

Confirm exactly one schedule is active afterward: the timer stopped on AIWA
(`systemctl list-timers --all | grep hcp-estimates-sync` shows nothing active) and
the PM2 entry `online`.
