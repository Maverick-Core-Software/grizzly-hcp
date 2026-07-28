# HCP Catalog Sync → AIWA Relocation — Build Plan

**Created:** 2026-07-28 by Claude (Opus 5, build-handoff planner)
**Target repo:** `C:\Workspace\Active\grizzly-hcp`
**Branch:** `sync-estimates-aiwa`

## Codebase Primer

*(Orchestrator context only — Qwen never reads this section. Everything a session
needs is restated inside that session.)*

- **Environment:** Windows 11, Node 24 on PATH, npm, TypeScript run through `tsx`.
  Repo root `C:\Workspace\Active\grizzly-hcp`. Tests are plain `node --test` files
  named `*.test.js` next to their source; there is no jest/vitest.
- **What this build does:** relocates the weekly HCP → RAG catalog exports
  (price book + customers) off the Windows PC so they run natively on the AIWA
  Proxmox host, exactly as `sync-estimates` already does. Every PC-side publish
  today uses a passphrase-less deploy key; this removes those uses.
- **Proven template to copy:** `src/hcp/sync-estimates.ts` +
  `src/hcp/rag-publish.ts` + `deploy/aiwa/hcp-estimates-sync.{service,timer,env.example}`
  + `docs/AIWA-DEPLOY-sync-estimates.md`.
- **Key folders:** `src/hcp/` (HCP API clients and exporters), `scripts/` (legacy
  bash/PowerShell wrappers, most of which this build deletes), `deploy/aiwa/`
  (systemd artifacts), `docs/` (runbooks), `memory/` (HANDOFF + JOURNAL).
- **Gotchas:**
  - `data/*.csv` is gitignored — generated CSVs must never be committed.
  - `dist/` is gitignored — the esbuild bundle is rebuilt before each deploy.
  - A guard hook rejects any command text containing the literal tokens `ssh`
    or `scp`, **including git commit messages**. Say "deploy key" or "remote
    copy" instead. Every commit message in this plan already complies.
  - Never run `git add -A`. Stage files by name.
  - Nothing in this plan touches AIWA. Deployment is a separate, human-approved
    step performed by the orchestrator through Orca after all sessions pass.
- **Ground truth gathered 2026-07-28 (read-only, from the AIWA host):** node
  `v22.23.1` at `/usr/bin/node`; Qdrant collections `pricebook` (392 points,
  green) and `grizzly_hcp` (2120 points, green); ingest dir
  `/mnt/samsung-sata/mav-rag/hcp-exports` drained; the mav-rag ingest watcher
  routes CSVs **by header content**, not filename (`unit_of_measure` present ⇒
  price-book collection), and every ingest path is **upsert-only — there are no
  delete calls anywhere in it**. That is why this job needs no Qdrant delete
  step, unlike `sync-estimates`.

---

## Session 1 — make the exporters callable and the publisher reusable

**Goal:** `export-pricebook.ts` and `export-customers.ts` can be imported and
called as functions (with env-overridable output paths) while still working as
standalone CLI scripts, and `publishCsv` can publish under a caller-chosen
destination filename. All existing tests still pass.

**Independent:** no

**Stack / decisions:**
- TypeScript, ESM, Node ≥20. No new dependencies.
- Output paths become env-overridable exactly the way `src/hcp/sync-estimates.ts`
  already does it for `ESTIMATES_CSV_PATH`: read the env var, `path.resolve` it
  if set, otherwise fall back to the existing hardcoded `data/…` default. Copy
  that pattern; do not invent a new one.
- The CLI-vs-import distinction uses the standard ESM entry check: compare
  `process.argv[1]` against `fileURLToPath(import.meta.url)`, and only invoke the
  script's `run()` + `process.exit` behavior when they match. This matters
  because Session 2 imports both modules into one bundle — an unguarded
  top-level `run()` would fire on import.
- Do **not** change any CSV column, header, ordering, or escaping. The mav-rag
  ingest watcher classifies these files by their header row; altering headers
  breaks ingest silently.

**Tasks:**

1. Modify `src/hcp/export-pricebook.ts`:
   - Make the resolved CSV path honor a `PRICEBOOK_CSV_PATH` environment
     variable, falling back to the current `data/pricebook.csv` default.
   - Export the main routine as a named async function `runPricebookExport` that
     returns a summary object (see Interfaces) instead of only logging. It must
     still log the same progress output it logs today.
   - Keep standalone CLI behavior — when the module is the process entry point,
     run the export and exit non-zero with the existing `Failed: <message>`
     error output on failure. When imported, it must do nothing on its own.

2. Modify `src/hcp/export-customers.ts` the same way:
   - Env var `CUSTOMERS_CSV_PATH`, same fallback rule to `data/customers.csv`.
   - Named export `runCustomersExport` returning its own summary object.
   - Same entry-point guard.

3. Modify `src/hcp/rag-publish.ts`:
   - Give `publishCsv` an optional third parameter for the destination filename,
     defaulting to `estimates-enriched.csv` so every existing caller and test is
     unaffected.
   - For the `local` target, the file is copied into `cfg.ingestDir` under that
     destination filename.
   - For the `remote` target, keep today's behavior exactly when the default
     filename is used. When a caller passes a non-default filename with a
     `remote` target, throw an `Error` naming the filename and stating that the
     remote publish path only supports the estimates CSV — the catalog job is
     local-only by design. Do not attempt to construct a remote path for it.

4. Extend `src/hcp/rag-publish.test.js` with cases covering the new parameter:
   local publish writes to the destination filename inside the ingest dir; local
   publish with no filename argument still writes `estimates-enriched.csv`;
   remote publish with a non-default filename throws. Use `node:test` +
   `node:assert` and the file's existing style (temp dirs under `os.tmpdir()`,
   cleaned up afterward).

**Interfaces (exact spellings):**
- `runPricebookExport(): Promise<{ csvPath: string; serviceCount: number; materialCount: number; rowCount: number }>`
- `runCustomersExport(): Promise<{ csvPath: string; customerCount: number }>`
- `publishCsv(cfg: RagConfig, localCsvPath: string, destFileName?: string): Promise<void>`
- Env var names: `PRICEBOOK_CSV_PATH`, `CUSTOMERS_CSV_PATH`

**Verification:**
- Run: `node --test src/hcp/rag-publish.test.js` — expected: all tests pass,
  including the three new cases, `0 fail`.
- Run: `npx tsc --noEmit` — expected: no errors (if the repo has no tsconfig
  suitable for this, say so in your report rather than inventing one).
- Run: `node -e "import('./src/hcp/export-pricebook.ts')"` is **not** a valid
  check — instead confirm by inspection that neither exporter calls `run()` at
  module top level any more, and state in your report which line now guards it.

**Commit:** `refactor: make catalog exporters callable and publishCsv filename-aware`

---

## Session 2 — single AIWA entry point and its bundle

**Goal:** a new script `src/hcp/sync-catalog.ts` exports the HCP price book and
customers and publishes both CSVs into the RAG ingest directory in one run, and
`npm run build:sync-catalog` produces a self-contained `dist/sync-catalog.mjs`
with no Playwright in it.

**Independent:** no — requires Session 1's exports.

**Context you need (Session 1's result):**
- `src/hcp/export-pricebook.ts` exports
  `runPricebookExport(): Promise<{ csvPath: string; serviceCount: number; materialCount: number; rowCount: number }>`
  and honors `PRICEBOOK_CSV_PATH`.
- `src/hcp/export-customers.ts` exports
  `runCustomersExport(): Promise<{ csvPath: string; customerCount: number }>`
  and honors `CUSTOMERS_CSV_PATH`.
- `src/hcp/rag-publish.ts` exports `resolveRagConfig(env?)` returning a
  `RagConfig` with fields `target`, `qdrantUrl`, `collection`, `ingestDir`, and
  `publishCsv(cfg, localCsvPath, destFileName?)`.

**Stack / decisions:**
- TypeScript, ESM. No new dependencies. esbuild is already installed.
- The job is **local-target only**. On startup, resolve the RAG config and, if
  `target` is not `local`, fail immediately with a clear message telling the
  operator to set `RAG_TARGET=local`. This job has no deploy-key path and must
  never grow one.
- **No Qdrant delete step.** The mav-rag ingest is upsert-only for both of these
  file types, and today's PC-side publish does nothing but copy the file. Match
  that behavior exactly — do not call `deleteJobPoints`.
- Destination filenames in the ingest directory must be exactly `pricebook.csv`
  and `customers.csv`. These are the names the current PC-side publish uses and
  the names the ingest watcher has been consuming; anything else is a silent
  regression.
- Both exports run in one process, sequentially, price book first. If the price
  book step fails, still attempt the customers step, then exit non-zero. A single
  expired HCP session will fail both — that is expected and fine; the point is
  that one export's failure is reported alongside the other's rather than hiding
  it.
- Follow the logging shape of `src/hcp/sync-estimates.ts`: progress lines during
  work, then a short summary block at the end listing what was exported and
  published. On a failed HCP session, the error text must tell the operator to
  run `npm run login` on the PC and re-place the cookie file through Orca.

**Tasks:**

1. Create `src/hcp/sync-catalog.ts` — the AIWA entry point. It imports
   `dotenv/config`, resolves the RAG config, enforces the local-only rule, runs
   the two exports, publishes each resulting CSV under its required destination
   filename, prints a summary (row counts and both published paths), and exits
   non-zero if either half failed. Study `src/hcp/sync-estimates.ts` first and
   mirror its structure and error handling.

2. Add an npm script `build:sync-catalog` to `package.json` that bundles
   `src/hcp/sync-catalog.ts` to `dist/sync-catalog.mjs`. Copy the existing
   `build:sync-estimates` script verbatim and change only the entry file and the
   outfile — the platform, target, format and `createRequire` banner flags must
   match exactly, because that combination is what makes the bundle run under
   plain `node` on the server.

3. Add an npm script `sync-catalog` that runs `tsx src/hcp/sync-catalog.ts`, so
   the job can be exercised on the PC without building.

**Verification:**
- Run: `npm run build:sync-catalog` — expected: exits 0 and
  `dist/sync-catalog.mjs` exists.
- Run a search of the built bundle for the string `playwright` — expected: **no
  matches**. Report the exact command you used and its output.
- Run: `npm run build:sync-estimates` — expected: still exits 0 and
  `dist/sync-estimates.mjs` exists (proves the shared modules were not broken).
- Run `dist/sync-catalog.mjs` with `RAG_TARGET` set to `remote` — expected: a
  non-zero exit and the local-only error message, with no network calls to HCP.
- **Full live smoke test** (this reads the HCP cloud API and writes only to a
  throwaway directory — it does not touch AIWA): create a temp directory, then
  run `dist/sync-catalog.mjs` with `RAG_TARGET=local`, `RAG_INGEST_DIR` pointed
  at that temp directory, and `PRICEBOOK_CSV_PATH` / `CUSTOMERS_CSV_PATH`
  pointed at files inside it. Expected: exit 0, and the temp directory ends up
  containing both `pricebook.csv` and `customers.csv`, each with a header row
  plus many data rows. Report the byte size and row count of each file. If this
  fails with an HCP authentication error, stop and report it — it means the PC's
  saved session expired and a human must run `npm run login`.

**Commit:** `feat: add sync-catalog entry point and bundle for AIWA`

---

## Session 3 — deploy artifacts and retirement of the PC-side publish path

**Goal:** systemd unit, timer and env template exist for the new job, and every
PC-side script that reaches AIWA with the deploy key for these exports is gone
from the repo.

**Independent:** no — the deploy artifacts describe Session 2's bundle.

**Context you need:** Session 2 produced `dist/sync-catalog.mjs`, a
self-contained bundle whose configuration is entirely environment variables:
`RAG_TARGET`, `RAG_INGEST_DIR`, `PRICEBOOK_CSV_PATH`, `CUSTOMERS_CSV_PATH`,
`HCP_COOKIES_FILE`.

**Stack / decisions:**
- The three new files under `deploy/aiwa/` must mirror the existing
  `hcp-estimates-sync.{service,timer,env.example}` files in that same folder.
  Read all three before writing anything, and keep the hardening block, the
  comment style, and the "no `[Install]` section in the service" convention
  identical.
- Install root on the server is `/opt/hcp-catalog-sync/`, unit name
  `hcp-catalog-sync`, `SyslogIdentifier=hcp-catalog-sync`.
- `ExecStart` is `/usr/bin/node /opt/hcp-catalog-sync/sync-catalog.mjs`.
  `/usr/bin/node` is v22.23.1 on the target — verified.
- **Schedule: `OnCalendar=Sun *-*-* 04:30:00`**, `Persistent=true`,
  `RandomizedDelaySec=300`. It must NOT be 03:30 — that is when
  `hcp-estimates-sync.timer` fires, and its downstream re-embedding runs for
  several minutes. 04:30 leaves an hour of margin. Note in a comment that the
  host timezone is `America/Chicago`.
- The env template sets `RAG_TARGET=local`,
  `RAG_INGEST_DIR=/mnt/samsung-sata/mav-rag/hcp-exports`,
  `PRICEBOOK_CSV_PATH=/opt/hcp-catalog-sync/pricebook.csv`,
  `CUSTOMERS_CSV_PATH=/opt/hcp-catalog-sync/customers.csv`, and
  `HCP_COOKIES_FILE=/opt/hcp-estimates-sync/secrets/hcp-cookies.json`.
  That last one is deliberate: this job **shares the existing estimates cookie
  file** rather than keeping a second copy of the same secret, so a session
  refresh is a single operation. Put a comment in the template saying so.
  `ReadWritePaths` must include the ingest directory, exactly as the estimates
  unit does.
- Deleting the scripts below is intentional and approved. Their only purpose was
  copying CSVs to AIWA with the passphrase-less deploy key, which this build
  replaces. `scripts/sync-pricebook.sh` additionally pulled a file that has not
  been regenerated on the server since 2026-06-12.

**Tasks:**

1. Create `deploy/aiwa/hcp-catalog-sync.service`,
   `deploy/aiwa/hcp-catalog-sync.timer`, and
   `deploy/aiwa/hcp-catalog-sync.env.example` per the decisions above.

2. Delete these five files with `git rm`:
   `scripts/sync-pricebook.sh`, `scripts/push-pricebook.sh`,
   `scripts/push-customers.sh`, `scripts/push-jobs.sh`,
   `scripts/weekly-sync-pricebook.ps1`.
   Then remove the now-dangling `sync-pricebook`, `push-pricebook`,
   `push-customers` and `push-jobs` entries from the `scripts` block of
   `package.json`. Leave `export-pricebook`, `export-customers` and
   `export-jobs` in place — those only write local CSVs and stay useful.

3. Rewrite `scripts/weekly-sync-all.ps1`. Its price-book, customers and jobs
   sections all move to AIWA, so remove them. What remains is the brain-vault
   re-ingest step that runs `scripts/ingest-brain-vault.py` inside
   `C:\Workspace\Infrastructure\agent-os`. While rewriting, fix the stale
   `$ProjectDir` value at the top: it currently points at
   `C:\Users\carte\Grizzly-HCP`, a path that does not exist, and it must be
   `C:\Workspace\Active\grizzly-hcp`. Update the file's header comment to say
   the HCP exports now run on AIWA and this script only re-ingests the brain
   vault. Keep the logging helper and log-file behavior as they are.

**Verification:**
- Run: `git status --short` — expected: exactly the intended adds, deletes and
  modifications, and **no** untracked `.env` or backup files staged. Report the
  full output.
- Run: `npm run build:sync-catalog` — expected: still exits 0 (proves the
  package.json edit did not break the scripts block).
- Confirm by reading the files that no remaining file under `scripts/` mentions
  the deploy key path `id_ed25519_proxmox`. Search the whole `scripts/`
  directory and report what, if anything, still matches — `scripts/index-docs.ts`
  is a known separate consumer and is expected to still match; nothing else
  should.
- Note: the systemd unit files cannot be validated on Windows. Do not attempt
  it; the orchestrator validates them on the server before install.

**Commit:** `feat: add hcp-catalog-sync deploy artifacts and retire PC publish scripts`

---

## Session 4 — operator runbook

**Goal:** a deployment and rollback runbook for the new job exists, matching the
depth and structure of the existing estimates runbook.

**Independent:** no — documents Sessions 2 and 3.

**Context you need:** the new job is a weekly systemd oneshot named
`hcp-catalog-sync` installed at `/opt/hcp-catalog-sync/` on the AIWA Proxmox
host, running `/usr/bin/node /opt/hcp-catalog-sync/sync-catalog.mjs` from a
bundle built locally by `npm run build:sync-catalog`. It exports the HCP price
book and customer list and copies `pricebook.csv` and `customers.csv` into
`/mnt/samsung-sata/mav-rag/hcp-exports`, where the mav-rag ingest watcher picks
them up and archives them to `/mnt/samsung-sata/mav-rag/processed/` with a UTC
timestamp prefix. It authenticates with the shared cookie file at
`/opt/hcp-estimates-sync/secrets/hcp-cookies.json`. Its timer fires Sundays
04:30 America/Chicago. Qdrant on the host holds `pricebook` (392 points as of
2026-07-28) and `grizzly_hcp` (2120 points), and ingest for these file types is
upsert-only — no points are deleted by this job.

**Stack / decisions:**
- Read `docs/AIWA-DEPLOY-sync-estimates.md` in full first and follow its section
  structure closely. It is the proven template and the operator already knows it.
- Every step that changes server state must be marked as requiring explicit human
  approval, exactly as the estimates runbook does.
- All server access is through Orca in the `aiwa-host` environment. State plainly
  that the deploy key must not be used for any step, since removing its use is
  the entire point of this work.
- The rollback section is different from the estimates one and must say so: the
  PC-side publish scripts were **deleted**, not disabled, so rollback means
  restoring them from git history at a named commit — not re-running an npm
  script that no longer exists. Give the operator the concrete git command shape
  for restoring a deleted file from a prior commit.

**Tasks:**

1. Create `docs/AIWA-DEPLOY-catalog-sync.md` covering, in this order: what is
   being installed and why; pre-flight checks on the server; the file layout and
   ownership/permission commands under `/opt/hcp-catalog-sync/`; the environment
   file; the shared cookie file and how a session refresh works; a manual test
   run; installing and enabling the timer including the check that it does not
   collide with the 03:30 estimates timer; reading the journal by
   `SyslogIdentifier`; expired-session symptoms and recovery; and rollback.

2. Update the "Key Scripts" table in `CLAUDE.md`: remove the rows for the npm
   scripts deleted in Session 3 if any appear there, and add a row for
   `npm run build:sync-catalog` describing it as the AIWA catalog-sync bundle
   build. Change nothing else in that file.

**Verification:**
- Confirm `docs/AIWA-DEPLOY-catalog-sync.md` contains every section listed in
  task 1, and that the rollback section explicitly describes restoring deleted
  files from git history rather than re-running deleted scripts.
- Run: `git status --short` — expected: only the two intended files changed.

**Commit:** `docs: add AIWA catalog-sync runbook and update key scripts table`

---

## Session 5 (final) — docs + brain-write

**Goal:** project memory and the brain vault reflect this build. **All three
targets below are REQUIRED — updating only two fails this session.**

**Independent:** no

**Context you need — what this build changed:**
- Added `src/hcp/sync-catalog.ts` plus `npm run sync-catalog` and
  `npm run build:sync-catalog`, producing `dist/sync-catalog.mjs`: a
  self-contained bundle that exports the HCP price book and customers and writes
  `pricebook.csv` / `customers.csv` straight into the RAG ingest directory.
- `src/hcp/export-pricebook.ts` and `src/hcp/export-customers.ts` are now
  importable functions with env-overridable output paths
  (`PRICEBOOK_CSV_PATH`, `CUSTOMERS_CSV_PATH`); `publishCsv` in
  `src/hcp/rag-publish.ts` takes an optional destination filename and refuses
  non-default filenames on the remote target.
- Added `deploy/aiwa/hcp-catalog-sync.{service,timer,env.example}` — weekly
  oneshot, Sundays 04:30 America/Chicago, install root `/opt/hcp-catalog-sync/`,
  sharing the estimates job's cookie file.
- Deleted `scripts/sync-pricebook.sh`, `scripts/push-pricebook.sh`,
  `scripts/push-customers.sh`, `scripts/push-jobs.sh` and
  `scripts/weekly-sync-pricebook.ps1`, and removed their npm entries. Rewrote
  `scripts/weekly-sync-all.ps1` down to the brain-vault ingest step and fixed its
  stale project directory.
- Added `docs/AIWA-DEPLOY-catalog-sync.md`.
- **Not yet deployed.** Installing the unit on AIWA is a separate human-approved
  step. Say so explicitly in all three documents — do not describe this as live.
- Findings worth recording: the scheduled task "Grizzly Weekly Sync + Brain Vault
  Ingest" had been failing every Sunday (last result 1) because of the stale
  project directory, so the price book in RAG had not been refreshed since
  2026-06-30; `export-jobs` produces the same CSV header as `sync-estimates`, so
  its publish path was retired rather than relocated — `sync-estimates` already
  publishes a strictly richer file to the same collection.

**Tasks:**

1. Update `memory/HANDOFF.md` to describe the state after this build: the
   catalog-sync work is built and committed but not deployed, what the next
   agent must do to deploy it, and an updated remaining-consumer list for the
   deploy key (`index-docs`, `Watch-HCPExports`, `sync-from-proxmox.ps1`
   remain). Keep the document's existing "start here" shape.

2. Append a dated `## 2026-07-28 — catalog sync relocation built` entry to
   `memory/JOURNAL.md`. The file is append-only — never edit or reorder existing
   entries.

3. Update the brain vault project note at
   `C:\Workspace\Active\brain\projects\grizzly-hcp.md` — append a dated section
   in the same style as its existing `## 2026-07-28 — Cutover complete` section.
   **This file is outside the repo. It is not optional; skipping it fails this
   session.** Do not commit it as part of the repo commit — report that it was
   written and leave committing the vault to the orchestrator.

**Verification:**
- All three files contain today's date and describe this build.
- Run: `git status --short` — expected: only `memory/HANDOFF.md` and
  `memory/JOURNAL.md` modified in the repo.
- Report the absolute path of the brain vault file you wrote and quote the
  heading line you added to it.

**Commit:** `docs: update handoff, journal and brain note for catalog sync build`

---

## Revisions

*(empty at plan creation)*
