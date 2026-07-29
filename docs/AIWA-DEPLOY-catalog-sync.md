# AIWA Deployment — HCP Catalog Sync

> **⚠️ Every step that changes the running server below requires explicit human
> approval before it is performed. Do not automate or rush these steps.**

> **All server access is through Orca in the `aiwa-host` environment.** The
> passphrase-less deploy key must not be used for any step in this document.
> Removing that key's use is the entire point of this work — reaching the host
> with it here would defeat the whole exercise.

This document describes how to install the `hcp-catalog-sync` weekly job on the
AIWA Proxmox host. The job exports Grizzly's Housecall Pro price book, customer
list, and estimates, and publishes all three CSVs into the RAG ingest directory.

## 1. What is being installed and why

A single-file Node.js bundle (`sync-catalog.mjs`, built locally by
`npm run build:sync-catalog`) runs once per week via a systemd timer. It replaces
four PC-side scripts that exported the same data on CartersPC and then copied it
to this host with the passphrase-less deploy key. Those scripts have been
**deleted** from the repository, not disabled — see Section 12.

The job performs three steps in one run, and a failure in one does not abort the
others:

| Step | Publishes | Qdrant behaviour |
| --- | --- | --- |
| Price book | `pricebook.csv` | upsert only, no deletes |
| Customers | `customers.csv` | upsert only, no deletes |
| Estimates | `estimates.csv` | deletes points with `type == "estimate"` first, so re-runs replace rather than accumulate |

The estimates step **never touches `type == "job"`**. Those points belong to the
separate jobs sync and deleting them here would destroy that job's data.

The ingest watcher picks the CSVs up from
`/mnt/samsung-sata/mav-rag/hcp-exports` and archives them to
`/mnt/samsung-sata/mav-rag/processed/` with a UTC timestamp prefix.

### A naming trap, stated plainly

The already-deployed unit named **`hcp-estimates-sync` actually syncs jobs, not
estimates.** The name is historical and is being kept deliberately so the
existing install and its runbook stay valid. **This** job — `hcp-catalog-sync` —
is the one that handles real estimates. When reading journals or timers, do not
assume the names describe the contents.

## 2. Prerequisite — the mav-rag ingest change

**The estimates half of this job does not work until the mav-rag ingest change in
`deploy/mav-rag/` has been applied.** Until then the ingest has no estimate
branch: it sees `customer_name` in the header, falls through to its `"customer"`
default, and files every estimate row as a customer. The price book and customer
halves are unaffected.

Apply the ingest change **before or together with** this job, following
`deploy/mav-rag/README.md`. That is a container rebuild, not a restart — the
image is built from source and a plain restart silently keeps running the old
code.

Confirm it is live before continuing:

```bash
docker exec mav-rag-ingest sha256sum /app/main.py
```

The hash must match `deploy/mav-rag/main.py` in this repo. If it matches
`main.py.snapshot-20260728` instead, the change is not deployed yet.

## 3. Pre-flight checklist

Before installing, confirm the following on the target server:

- **Node.js** is installed. Run `command -v node` and `node --version` — the
  bundle is built for **node20 or later**, and the service unit hardcodes the
  absolute path `/usr/bin/node`. If node lives elsewhere, correct `ExecStart`
  before installing.
- **Ingest directory** exists and is writable:
  `ls -ld /mnt/samsung-sata/mav-rag/hcp-exports`.
- **Qdrant** is reachable at `http://localhost:6333`. Run
  `curl -s http://localhost:6333/` and verify a response.
- **Collections** exist: `curl -s http://localhost:6333/collections/grizzly_hcp`
  and `curl -s http://localhost:6333/collections/pricebook`.
- **The shared cookie file** is present:
  `ls -l /opt/hcp-estimates-sync/secrets/hcp-cookies.json` (see Section 6).
- **Record the current point counts** before any run, so Section 10 has a
  baseline to compare against.

**Verified on the target host 2026-07-28 (read-only check through Orca):**

| Check | Result |
| --- | --- |
| Node | `/usr/bin/node`, v22.23.1 |
| Host timezone | `America/Chicago` — so the timer fires Sunday 04:30 Central |
| Ingest directory | present |
| Qdrant | answers on `localhost:6333` |
| `grizzly_hcp` | 2120 points |
| `pricebook` | 392 points |

If any of these checks fail, resolve them before proceeding.

## 4. File layout

Create the following directory structure on the server:

```
/opt/hcp-catalog-sync/
├── sync-catalog.mjs          ← the bundle (from this repo, dist/sync-catalog.mjs)
├── hcp-catalog-sync.env      ← environment file (see Section 5)
├── pricebook.csv             ← written by the job at runtime
├── customers.csv             ← written by the job at runtime
└── estimates.csv             ← written by the job at runtime
```

There is **no `secrets/` directory here.** This job reads the cookie file from
the jobs sync's install root instead — see Section 6.

Transfer `dist/sync-catalog.mjs` to the host through Orca, then confirm it
arrived intact before installing:

```bash
sha256sum /opt/hcp-catalog-sync/sync-catalog.mjs
```

Compare against the local `dist/sync-catalog.mjs`. A mismatch means a truncated
transfer — do not proceed.

Set ownership and permissions:

```bash
sudo chown -R root:root /opt/hcp-catalog-sync/
sudo chmod 755 /opt/hcp-catalog-sync/
sudo chmod 644 /opt/hcp-catalog-sync/hcp-catalog-sync.env
```

## 5. Creating the environment file

Copy the template from this repo and place it on the server:

```bash
sudo cp deploy/aiwa/hcp-catalog-sync.env.example \
       /opt/hcp-catalog-sync/hcp-catalog-sync.env
```

Edit `/opt/hcp-catalog-sync/hcp-catalog-sync.env` and verify the values match the
server layout. Two things to be careful about:

- **`RAG_TARGET` must be `local`.** The job runs on the same host as the RAG and
  publishes by file copy plus a direct HTTP call. It has no remote-copy path. If
  `RAG_TARGET` resolves to anything else the job refuses to run and exits 1 with
  an explanatory message — that guard is deliberate.
- **`ESTIMATES_EXPORT_CSV_PATH` is not `ESTIMATES_CSV_PATH`.** The latter belongs
  to the jobs sync, which runs on this same host. Mixing them up makes the two
  jobs fight over one file.

## 6. The shared cookie file and session refresh

This job authenticates to the HCP external API with the **same cookie file as the
jobs sync**:

```
/opt/hcp-estimates-sync/secrets/hcp-cookies.json
```

That is deliberate, not an oversight. Keeping one copy of the credential means an
expired HCP session is a single refresh that fixes both jobs, instead of two
copies that can drift out of sync. Do not create a second copy under
`/opt/hcp-catalog-sync/`.

Because the bundle resolves its default cookie path relative to its own
directory, **`HCP_COOKIES_FILE` is mandatory, not optional**, for the bundled
job. Without it the run fails with `No HCP session found`.

Permissions on the shared file stay owner-only:

```bash
sudo chmod 700 /opt/hcp-estimates-sync/secrets/
sudo chmod 600 /opt/hcp-estimates-sync/secrets/hcp-cookies.json
```

Refreshing the session is covered in Section 11.

## 7. Manual test run

Before enabling the timer, run the job once manually (**approval required** — this
writes to Qdrant and the ingest directory):

```bash
sudo systemctl start hcp-catalog-sync.service
```

**Healthy output** includes, in order:

- `HCP catalog sync` followed by the resolved ingest directory and Qdrant URL
- a `── Price book ──` section, then `── Customers ──`, then `── Estimates ──`
- a `══ Summary ══` block with `OK` on all three lines and row counts
- `Done. RAG will re-index automatically.`
- Exit code 0

A run where one step fails still reports the others and exits 1, with a
`FAIL  <step>: <message>` line in the summary. That is working as designed —
read the summary rather than assuming a non-zero exit means nothing happened.

Expected magnitudes as of 2026-07-28: price book ~267 rows (195 services + 72
materials), customers ~973, estimates ~810 estimates producing ~948 option rows.

## 8. Installing and enabling the timer

> **Done on 2026-07-28.** The timer is installed and enabled; next elapse
> Sun 2026-08-02 04:33:05 CDT. This section is retained for rebuilds and for
> verifying the installed state — re-running it is not required.
>
> **Amended 2026-07-28 (ref `0e89f1a`).** Both `.service` units gained a finite
> `TimeoutStartSec` — 1200s here, 900s on `hcp-estimates-sync`. `Type=oneshot`
> defaults it to infinity, so a run that completes its work but fails to release
> the MCP transport would wedge the unit in `activating` forever. Installed via
> `git show <ref>:deploy/aiwa/<unit>.service > /etc/systemd/system/<unit>.service`
> plus `systemctl daemon-reload`; no restart was needed (both units inactive).
> Previous unit files are backed up on AIWA as
> `/etc/systemd/system/<unit>.service.bak-20260729T042100Z` — that is the rollback.
>
> **Gap closed 2026-07-29.** Both units are now monitored by the Hermes
> supervisor (`hermes-triage` on AIWA, commit `1425783` on `hermes-supervisor`).
> Its `check_sync_jobs()` sensor reports two independent signals:
>
> - `hcp_sync_job_failed` (**critical**) — `systemctl show -p ActiveState -p Result`
>   per unit. `Result=` is meaningful between runs, unlike `is-active`, which is
>   `inactive` ~100% of the time for a healthy timer-driven `Type=oneshot`. The
>   `TimeoutStartSec` above turns a hung success into `Result=timeout`, so a hang
>   lands here instead of hiding in `activating`.
> - `hcp_sync_job_stale` (**warning**) — worst per-kind mtime of
>   `*_{pricebook,customers,estimates}.csv` in `/mnt/samsung-sata/mav-rag/processed`,
>   8-day threshold (one missed weekly run). Catches a unit that reports success
>   but wrote nothing the RAG could ingest. Deliberately not sourced from systemd
>   timestamps — `LastTriggerUSec` / `InactiveEnterTimestamp` / `ExecMainExitTimestamp`
>   were verified empty after a `daemon-reload`, so they carry no durable history.
>
> Live at 00:00:45 CDT 2026-07-29; first observation after restart read
> `{"failed": false, "stale": false, "oldest_csv_age_days": 0.65}`.
> Nothing greps `HCP_AUTH_PREFLIGHT_FAIL` on either host — the fail marker is
> still write-only, and the unit exit status is what actually alarms.

### 8.1 Confirm there is no collision with the 03:30 timer

`hcp-estimates-sync.timer` fires **Sundays 03:30** and its downstream
re-embedding runs for several minutes. This job is scheduled for **04:30** to
stay clear of it. Both write into the same ingest directory, so overlapping runs
are the failure mode this gap prevents.

Before enabling, confirm the existing timer's schedule has not been moved:

```bash
sudo systemctl list-timers --all | grep hcp-
```

If `hcp-estimates-sync.timer` no longer fires at 03:30, re-check that the two
schedules still have at least an hour between them before continuing.

### 8.2 Install the units (approval required)

```bash
sudo cp deploy/aiwa/hcp-catalog-sync.service /etc/systemd/system/
sudo cp deploy/aiwa/hcp-catalog-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hcp-catalog-sync.timer
```

Verify the timer is active and check the next scheduled run:

```bash
sudo systemctl list-timers --all | grep hcp-catalog-sync
sudo systemctl status hcp-catalog-sync.timer
```

The timer runs **weekly on Sundays at 04:30** server local time with a randomized
delay of up to 5 minutes. `Persistent=true` means that if the machine is powered
off at the scheduled time, the job fires on next boot.

## 9. Reading job logs

All job output goes to the systemd journal under the identifier
`hcp-catalog-sync`:

```bash
# Follow output in real time (if the job is currently running)
sudo journalctl --identifier=hcp-catalog-sync --follow

# View the last run's output
sudo journalctl --identifier=hcp-catalog-sync -n 80 --no-pager

# View the full history of runs
sudo journalctl --identifier=hcp-catalog-sync --no-pager
```

Use `--identifier`, not `--unit`, when you want the job's own stdout — the
`SyslogIdentifier` is what separates this job's output from the jobs sync's.

## 10. Verifying the Qdrant point counts

After a run, confirm the estimates landed with the right type and that the jobs
were not disturbed:

```bash
curl -s http://localhost:6333/collections/grizzly_hcp/points/count \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"key":"type","match":{"value":"estimate"}}]}}'
```

Repeat with `"job"` and `"customer"`. What to expect:

- **`estimate`** — roughly one point per estimate option (948 as of
  2026-07-28). A count of 0 after a successful run means the mav-rag ingest
  change is not live: check Section 2.
- **`job`** — **unchanged** from the pre-run baseline taken in Section 3. If this
  dropped, something deleted job points and must be investigated before the next
  run.
- **`customer`** — grows toward the customer count, never shrinks; this path is
  upsert-only.

Verified baseline, immediately after the 2026-07-28 manual run: `estimate` 948,
`job` 1073, `customer` 1130, `grizzly_hcp` total 3151, `pricebook` 395. The three
type counts sum exactly to the total, so any future total that exceeds the sum of
the three means points are being written with an unexpected `type`.

**Counts are not 1:1 with exported rows** — 973 customers produced 1130 customer
points and 267 price book rows produced 395 `pricebook` points, because records
are chunked. Do not treat that mismatch as a fault.

### 10.1 The better check for "`job` unchanged"

The count comparison above only works if someone remembered to take a per-type
baseline *before* the run, and even then equal counts can hide a delete followed
by a reinsert. Prefer this instead — it needs no baseline and cannot be fooled:

```bash
cat > /tmp/s.json <<'EOF'
{"limit":3,"with_payload":["ingested_at","source"],
 "filter":{"must":[{"key":"type","match":{"value":"job"}}]}}
EOF
curl -s http://localhost:6333/collections/grizzly_hcp/points/scroll \
  -H 'Content-Type: application/json' --data-binary @/tmp/s.json \
  | grep -oE '"ingested_at":"[^"]{16}'
```

Job points must still carry `ingested_at` timestamps from the **03:30 jobs run**,
not from the catalog run that just finished. On 2026-07-28 the catalog run
executed 13:29–13:38 and job points still read `2026-07-28T04:22`–`04:23`, which
proves they were neither rewritten nor deleted. Swap `"job"` for `"customer"` or
`"estimate"` and the timestamps should instead fall *inside* the run window.

Corroborate from the ingest log — for a healthy catalog run it contains exactly
three upserts and **no delete and no job-typed operation at all**:

```bash
docker logs --tail 4000 mav-rag-ingest 2>&1 | grep -i upsert | tail -3
```

Also confirm the collection totals and that the CSVs were consumed:

```bash
curl -s http://localhost:6333/collections/grizzly_hcp | head -c 400
curl -s http://localhost:6333/collections/pricebook | head -c 400
ls -l /mnt/samsung-sata/mav-rag/processed/ | tail -5
```

The three CSVs should have moved out of `hcp-exports/` into `processed/` with a
UTC timestamp prefix.

## 11. Expired session — symptoms and recovery

The HCP API session stored in the cookie file eventually expires. When it does,
all three steps fail in the same run and the summary reports the failure. The job
detects this case and prints an explicit hint about refreshing the session rather
than leaving a bare HTTP error.

**Recovery steps:**

1. **On the Windows PC**, log into the HCP portal again to refresh the session:
   ```bash
   npm run login
   ```
2. **Transfer** the refreshed `hcp-cookies.json` to
   `/opt/hcp-estimates-sync/secrets/hcp-cookies.json` **through Orca** — never
   with the passphrase-less deploy key.
3. **Restore permissions**:
   ```bash
   sudo chmod 600 /opt/hcp-estimates-sync/secrets/hcp-cookies.json
   ```
4. **Run the job manually** to confirm it succeeds (Section 7).
5. **Check the journal** for clean output (Section 9).

Because the file is shared, this one refresh also fixes the jobs sync. No timer
or unit changes are needed.

## 12. Rollback

**This rollback differs from the jobs sync's.** There is no PC-side script to
re-enable: the four publish scripts were **deleted from the repository**, not
disabled. `npm run push-pricebook` and friends no longer exist, and running them
will simply fail with "missing script". Restoring the PC path means restoring
deleted files from git history.

**1. Stop the AIWA timer** (leave the files in place — that makes re-cutover
cheap):

```bash
sudo systemctl disable --now hcp-catalog-sync.timer
```

The bundle and env file at `/opt/hcp-catalog-sync/` remain intact. Only remove
the units if abandoning the relocation entirely:

```bash
sudo rm /etc/systemd/system/hcp-catalog-sync.timer
sudo rm /etc/systemd/system/hcp-catalog-sync.service
sudo systemctl daemon-reload
```

**2. Restore the deleted PC-side scripts** (requires Carter's explicit approval).

They were removed in commit **`f57812a`**
(`feat: add hcp-catalog-sync deploy artifacts and retire PC publish scripts`).
Confirm that is still the deletion commit, then restore the files from the commit
**before** it:

```bash
git log --oneline --diff-filter=D -- scripts/push-pricebook.sh
git checkout f57812a~1 -- scripts/sync-pricebook.sh scripts/push-pricebook.sh scripts/push-customers.sh scripts/push-jobs.sh scripts/weekly-sync-pricebook.ps1
```

The `<commit>~1` is the important part — at the deletion commit itself the files
are already gone. Then re-add the matching `scripts` entries to `package.json`
(`sync-pricebook`, `push-pricebook`, `push-customers`, `push-jobs`) and restore
the export-and-push sections of `scripts/weekly-sync-all.ps1`, which was rewritten
in the same commit to keep only the brain-vault re-ingest.

Be aware of what this re-introduces: **those scripts reach this host with the
passphrase-less deploy key**, which is the exact dependency this relocation
removes. Treat rollback as temporary and re-attempt the cutover once the blocking
issue is fixed.

**3. The mav-rag ingest rollback is separate.** It is not undone by any of the
above — the estimate branch is inert without an estimates CSV to classify.
Roll it back only if the ingest itself is the problem, following the rollback
section of `deploy/mav-rag/README.md`, which restores
`main.py.snapshot-20260728` and rebuilds the container.

Confirm afterward that exactly one schedule is active: the timer stopped on AIWA
(`systemctl list-timers --all | grep hcp-catalog-sync` shows nothing active) and,
if the PC path was restored, its Task Scheduler entry running.
