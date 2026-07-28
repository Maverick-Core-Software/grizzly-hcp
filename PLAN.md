# HCP Catalog + Estimates Sync → AIWA — Build Plan

**Created:** 2026-07-28 by Claude (Opus 5, build-handoff planner)
**Revised:** 2026-07-28 — estimates export added (see `## Revisions`)
**Target repo:** `C:\Workspace\Active\grizzly-hcp`
**Branch:** `sync-estimates-aiwa`

## Codebase Primer

*(Orchestrator context only — Qwen never reads this section. Everything a session
needs is restated inside that session.)*

- **Environment:** Windows 11, Node 24 on PATH, npm, TypeScript run through `tsx`.
  Repo root `C:\Workspace\Active\grizzly-hcp`. Tests are `*.test.js` files next to
  their source; there is no jest/vitest. They import the TypeScript module under
  its `.js` specifier, so they must be run through the tsx loader —
  `npx tsx --test <file>`, **not** bare `node --test` (which fails
  `ERR_MODULE_NOT_FOUND`).
- **What this build does:** two things at once.
  1. Relocates the weekly HCP → RAG exports (price book + customers) off the
     Windows PC so they run natively on the AIWA Proxmox host, killing the last
     PC-side uses of the passphrase-less deploy key for these feeds.
  2. Adds a **genuine HCP estimates export**, which does not exist today.
- **The naming trap — read this before anything else.** `src/hcp/sync-estimates.ts`
  does **not** export estimates. It calls `/alpha/jobs`, the same endpoint
  `src/hcp/export-jobs.ts` uses, over all pages and all statuses, and writes an
  identical 10-column header. The only difference is the `line_items` column:
  sync-estimates fetches the real per-item breakdown from
  `/alpha/jobs/{id}/line_items`, while export-jobs writes only `job.description`.
  **sync-estimates is a strict superset of export-jobs.** Jobs are therefore
  already exported weekly on AIWA by the deployed `hcp-estimates-sync` unit; only
  the unit's name is wrong. Carter decided the name stays — note the misnomer in
  the docs, do not rename it.
- **Proven template to copy:** `src/hcp/sync-estimates.ts` + `src/hcp/rag-publish.ts`
  + `deploy/aiwa/hcp-estimates-sync.{service,timer,env.example}` +
  `docs/AIWA-DEPLOY-sync-estimates.md`.
- **Key folders:** `src/hcp/` (HCP API clients and exporters), `scripts/` (legacy
  bash/PowerShell wrappers, most of which this build deletes), `deploy/aiwa/`
  (systemd artifacts), `docs/` (runbooks), `memory/` (HANDOFF + JOURNAL).
- **Gotchas:**
  - `data/*.csv` and `dist/` are gitignored — never commit generated CSVs or bundles.
  - A guard hook rejects any command text containing the literal tokens `ssh` or
    `scp`, **including git commit messages**. Say "deploy key" or "remote copy".
    Every commit message below already complies.
  - Never run `git add -A`. Stage files by name.
  - Sessions 1–3 and 5–7 touch only this repo. Session 4 produces a deployment
    artifact for a *different* system; nothing in any session touches AIWA
    directly. All live changes are approval-gated orchestrator work afterward.

### Ground truth verified 2026-07-28 (read-only)

**AIWA host:** node `v22.23.1` at `/usr/bin/node`; Qdrant collections `pricebook`
(392 points, green) and `grizzly_hcp` (2120 points, green); ingest dir
`/mnt/samsung-sata/mav-rag/hcp-exports` drained.

**mav-rag ingest** (`/opt/mav-rag/ingest/main.py`) routes CSVs **by header
content**, not filename, and is **upsert-only — no delete calls anywhere**.
`detect_type` recognizes exactly three types:

| returns | condition |
|---|---|
| `"job"` | header contains any of `invoice_number`, `job_number`, `total_amount`, `completed_at` |
| `"pricebook_materials"` | `unit_of_measure` present **and** none of `mobile_number`, `invoice_number`, `job_number` |
| `"customer"` | otherwise (fallback) |

There is **no estimate type** — that is the gap Session 4 fills.

`deleteJobPoints` in `src/hcp/rag-publish.ts` deletes on filter `type == "job"`,
so points written with `type == "estimate"` are untouched by the weekly jobs sync.

**`/opt/mav-rag` is NOT a git repository and has no local source copy** — it is
untracked live source. That is why Session 4 works from a tracked snapshot plus a
tracked modified copy committed in this repo before anything is applied. Getting
mav-rag under version control is a real follow-up, out of scope here.

**HCP estimates API — discovered by live probe and by mining `data/hcp-api-calls.json`:**

- List: `GET /beta/estimates?page=<n>&page_size=100&sort_by=most_relevant&expand[]=canceled_options&expand[]=options.notes`
  - Response: `{ object, page, page_size, total_pages_count, total_count, data: [...], url }`
  - The field is **`total_pages_count`** — note the spelling, it differs from
    `/alpha/jobs`'s `total_page_count`.
  - `total_count` = **810** with `expand[]=canceled_options`, 742 without.
  - Estimate fields: `id` (`best_…`), `estimate_uuid`, `invoice_number` (number),
    `customer_uuid`, `customer_name`, `customer_billable_email`,
    `customer_phone_number`, `request_address`, `address`, `description`,
    `value` (cents), `outcome` (`open` | `won` | `lost`), `created_at`,
    `completed_at`, `scheduled_date`, `discount`, `notes`,
    `assigned_pros[]` (each with `full_name`), `options[]`.
  - Option fields: `id` (`est_…`), `name`, `option_number`, `option_description`,
    `sub_total`, `total_amount` (cents), `status` (`UNSCHEDULED`,
    `Awaiting Approval`, `approved`, `expired`, `pro approved`),
    `notes.data[].content`.
- Line items: `GET /alpha/estimates/{option_id}/line_items` — the **option's**
  `est_…` id, **not** the estimate's `best_…` id (that returns 404 "Estimate not
  found").
  - Response `{ object, data: [...] }`; items carry `name`, `description`,
    `unit_price` (cents), `unit_cost`, `quantity`, `kind`, `taxable`, `amount`,
    `unit_of_measure`, `duration_in_minutes`, `service_item_id`.

### Orchestrator pre-dispatch step (before Session 4 only)

Before dispatching Session 4, the orchestrator fetches `/opt/mav-rag/ingest/main.py`
read-only through Orca, scans it for secrets, and commits it as
`deploy/mav-rag/main.py.snapshot-20260728` — the rollback reference and the
source Qwen edits from. **Session 4 must not be dispatched before that file exists.**

---

## Session 1 — make the exporters callable and the publisher reusable

**Goal:** `export-pricebook.ts` and `export-customers.ts` can be imported and
called as functions (with env-overridable output paths) while still working as
standalone CLI scripts; `publishCsv` can publish under a caller-chosen
destination filename; Qdrant point deletion is parameterized by type. All
existing tests still pass.

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
  because a later session imports both modules into one bundle — an unguarded
  top-level `run()` would fire on import.
- Do **not** change any CSV column, header, ordering, or escaping in these two
  exporters. The mav-rag ingest classifies these files by their header row;
  altering headers breaks ingest silently.

**Tasks:**

1. Modify `src/hcp/export-pricebook.ts`:
   - Honor a `PRICEBOOK_CSV_PATH` environment variable for the output path,
     falling back to the current `data/pricebook.csv` default.
   - Export the main routine as a named async function `runPricebookExport`
     returning a summary object (see Interfaces) instead of only logging. It must
     still log the same progress output it logs today.
   - Keep standalone CLI behavior — when the module is the process entry point,
     run the export and exit non-zero with the existing `Failed: <message>`
     output on failure. When imported, it must do nothing on its own.

2. Modify `src/hcp/export-customers.ts` the same way: env var
   `CUSTOMERS_CSV_PATH` falling back to `data/customers.csv`, named export
   `runCustomersExport`, same entry-point guard.

3. Modify `src/hcp/rag-publish.ts`:
   - Give `publishCsv` an optional third parameter for the destination filename,
     defaulting to `estimates-enriched.csv` so every existing caller and test is
     unaffected. For the `local` target the file is copied into `cfg.ingestDir`
     under that name. For the `remote` target keep today's behavior exactly when
     the default name is used; when a caller passes a non-default name with a
     `remote` target, throw an `Error` naming the filename and stating that the
     remote publish path only supports the estimates CSV. Do not attempt to
     construct a remote path for it.
   - Add an exported `deletePointsByType(cfg, type)` that does what
     `deleteJobPoints` does today but with the payload `type` value supplied by
     the caller, and reimplement `deleteJobPoints(cfg)` as a thin wrapper calling
     it with `'job'`. Both target branches must keep working, and the log line
     must name the type being deleted.

4. Extend `src/hcp/rag-publish.test.js`: local publish writes to the given
   destination filename inside the ingest dir; local publish with no filename
   argument still writes `estimates-enriched.csv`; remote publish with a
   non-default filename throws; `deleteJobPoints` still sends a filter matching
   `type == "job"`. Use `node:test` + `node:assert` and the file's existing style
   (temp dirs under `os.tmpdir()`, cleaned up afterward).

**Interfaces (exact spellings):**
- `runPricebookExport(): Promise<{ csvPath: string; serviceCount: number; materialCount: number; rowCount: number }>`
- `runCustomersExport(): Promise<{ csvPath: string; customerCount: number }>`
- `publishCsv(cfg: RagConfig, localCsvPath: string, destFileName?: string): Promise<void>`
- `deletePointsByType(cfg: RagConfig, type: string): Promise<void>`
- Env vars: `PRICEBOOK_CSV_PATH`, `CUSTOMERS_CSV_PATH`

**Verification:**
- Run: `npx tsx --test src/hcp/rag-publish.test.js` — expected: all tests pass
  including the new cases, `0 fail`.
- Run: `npx tsc --noEmit` — expected: no errors. If the repo has no tsconfig
  suitable for this, say so in your report rather than inventing one.
- Confirm by inspection that neither exporter calls `run()` at module top level
  any more, and state in your report which line now guards it.

**Commit:** `refactor: make catalog exporters callable and publish helpers reusable`

---

## Session 2 — HCP estimates exporter

**Goal:** a new `src/hcp/export-estimates.ts` pulls every HCP estimate with its
options and per-option line items and writes a CSV whose header is deliberately
distinct from the jobs CSV.

**Independent:** no — follows Session 1's env-var and entry-guard conventions.

**Context you need:**
- `src/hcp/client.ts` exports `hcpGet<T>(path: string): Promise<T>` — an
  authenticated GET against `https://pro.housecallpro.com` using saved browser
  cookies. It throws on non-2xx with the status in the message.
- `src/hcp/sync-estimates.ts` is the structural model to copy: paginate, then a
  concurrency-limited parallel map (`pMap`, concurrency 5) for the per-item
  detail calls, then build and write the CSV. **Read it first.** It also has the
  `escape()` and `dollars()` helpers whose behavior you should mirror.
- Despite its name, `sync-estimates.ts` exports **jobs**. It is a structural
  reference only — do not reuse its endpoints or its CSV header.

**Stack / decisions:**
- TypeScript, ESM. No new dependencies.
- **List endpoint:** `GET /beta/estimates?page=<n>&page_size=100&expand[]=canceled_options&expand[]=options.notes`.
  *(Corrected 2026-07-28: an earlier draft of this line also carried
  `sort_by=most_relevant`, which makes pagination unstable — see Session 2b.)*
  Build the query with `URLSearchParams` and `params.append('expand[]', …)` the
  way `sync-estimates.ts` appends `expand[]=customer`. Paginate on
  **`total_pages_count`** — note the spelling, it differs from `/alpha/jobs`'s
  `total_page_count`. The array of estimates is the top-level `data` field.
  Expect roughly 810 estimates across ~9 pages.
- **Line items:** `GET /alpha/estimates/{optionId}/line_items` where `optionId`
  is an **option's** `est_…` id from `estimate.options[]`. Passing the estimate's
  own `best_…` id returns 404 — do not do that. The response is
  `{ object, data: [...] }`. On any error for a single option, return an empty
  list and continue; one bad option must not abort the export.
- **One CSV row per estimate option**, not per estimate — the options carry the
  money and the line items. An estimate with three options produces three rows.
  An estimate with no options still produces one row, with the option columns
  blank and `option_total` taken from the estimate's `value`.
- **Header — exact column names, in this order.** These are chosen so the file is
  unambiguous to the RAG ingest; do not rename or reorder them:
  `estimate_uuid`, `option_uuid`, `estimate_number`, `customer_name`,
  `customer_email`, `customer_phone`, `service_address`, `created_date`,
  `outcome`, `option_name`, `option_status`, `option_total`, `line_items`,
  `notes`, `assigned_pros`.
  It must contain **none** of `invoice_number`, `job_number`, `total_amount`,
  `completed_at`, or `unit_of_measure` — those exact names would make the RAG
  ingest misclassify the file as a jobs or price-book export.
- Field mapping: `estimate_uuid` = estimate `id` (`best_…`); `option_uuid` =
  option `id` (`est_…`); `estimate_number` = the `invoice_number` value;
  `service_address` prefers `request_address`, falling back to the estimate's
  `address` then the option's `address`; `created_date` = `created_at`;
  `outcome` = `outcome`; `option_total` = the option's `total_amount` formatted
  as dollars the same way `sync-estimates.ts` formats cents; `assigned_pros` =
  the `full_name` values joined with `, `.
- `line_items` formatting must match `sync-estimates.ts`'s style exactly:
  `name × quantity @ $unit_price (kind)` joined with ` | `, dropping items whose
  kind is a fixed discount or whose name is blank. When an option has no line
  items, fall back to the option's `option_description`, then the estimate's
  `description`.
- `notes` = the estimate's own notes plus each option note's `content`, joined
  with ` | `, blanks dropped.
- Output path `data/estimates-export.csv`, overridable via
  `ESTIMATES_EXPORT_CSV_PATH`. **Do not** reuse `ESTIMATES_CSV_PATH` — that
  belongs to the jobs sync, and pointing both at one file would be a data-loss bug.
- Same shape as Session 1: named export `runEstimatesExport`, entry-point guard
  for CLI use.

**Tasks:**

1. Create `src/hcp/export-estimates.ts` per the decisions above.
2. Add an npm script `export-estimates` that runs it through `tsx`.

**Interfaces (exact spellings):**
- `runEstimatesExport(): Promise<{ csvPath: string; estimateCount: number; optionCount: number; withLineItems: number }>`
- Env var: `ESTIMATES_EXPORT_CSV_PATH`

**Verification:**
- Run: `npm run export-estimates` — expected: exits 0 and writes
  `data/estimates-export.csv`. Report the estimate count, option count, row
  count, and file size. The estimate count should be in the low 800s; if it is
  742 you omitted the `expand[]=canceled_options` parameter.
- Read the first two lines of the output file and paste them into your report so
  the header and one real row can be checked.
- Confirm and state that the header contains none of `invoice_number`,
  `job_number`, `total_amount`, `completed_at`, `unit_of_measure`.
- Confirm at least one row has a non-empty `line_items` value and at least one
  row has `outcome` of `won` or `lost`.
- If this fails with an HCP authentication error, stop and report it — the PC's
  saved session expired and a human must run `npm run login`.

**Commit:** `feat: add HCP estimates exporter`

---

## Session 2b — corrections to the estimates exporter

**Goal:** fix four defects in the existing `src/hcp/export-estimates.ts`. The file
already exists and works; do not rewrite it. Make only the changes below.

**Independent:** no — corrects Session 2 and must land before Session 3.

**Context you need:**
- `src/hcp/export-estimates.ts` exists and exports `runEstimatesExport`. Read it
  first. It pulls HCP estimates and writes one CSV row per estimate option.
- Its CSV header is correct and must not change.
- `src/hcp/export-customers.ts` shows the entry-point-guard pattern this repo
  uses. Read it for reference.

**Tasks:**

1. **Remove the unstable sort.** In the list-endpoint query, delete the
   `sort_by=most_relevant` parameter entirely. Keep `page`, `page_size=100`, and
   both `expand[]` parameters exactly as they are. That sort makes the server
   reorder rows between page fetches, so a 9-page sweep returned 771 distinct
   estimates with 4 duplicates instead of all 810. Without it the same sweep
   returns 810 of 810 with no duplicates. This was verified directly against the
   live API — do not re-add the parameter.

2. **Add an entry-point guard.** The file currently calls `run()` at module load,
   so merely importing `runEstimatesExport` triggers a full export and can call
   `process.exit(1)`. Wrap the CLI invocation in the same
   `if (process.argv[1] === fileURLToPath(import.meta.url))` guard the other
   exporters use, so importing the module has no side effects. Session 3 imports
   this function, so this must be correct.

3. **Fix the service address precedence.** It is currently backwards and treats
   an empty string as a real value. The order must be: the estimate's
   `request_address` first, then the estimate's `address`, then the option's
   `address`. Treat `null`, `undefined`, and `''` alike as "absent" and keep
   falling back — `??` alone is not sufficient because the API returns empty
   strings. 55 of 910 rows came out with a blank address because of this.

4. **Stop asserting that an option exists.** The line-item fetch uses a non-null
   assertion on the option (`eo.option!.id`). An estimate with no options is
   represented with a `null` option, and that expression will throw and abort the
   whole export when one appears. Skip the line-item fetch for a null option and
   use an empty list instead, so the row is still produced with blank option
   columns as intended.

**Do not change:** the CSV header, the column order, the field mappings other
than `service_address`, the output path, the env var, the line-item endpoint, or
the `runEstimatesExport` return-type shape.

**Verification:**
- Run: `npm run export-estimates` — expected: exits 0.
- Report the estimate count printed by the run. It must be **810**, not 771.
- Load the CSV and report: total row count, the number of distinct
  `option_uuid` values, and the number of rows whose `service_address` is blank.
  Distinct `option_uuid` count must equal the row count minus the number of rows
  with a blank `option_uuid` (i.e. no duplicate options). The blank-address count
  must be lower than 55.
- Confirm and state that the header is unchanged and still contains none of
  `invoice_number`, `job_number`, `total_amount`, `completed_at`,
  `unit_of_measure`.
- Run: `npx tsc --noEmit` — expected: the only errors are the two pre-existing
  ones in `src/automations/estimates/from-proposal.ts` and
  `src/hcp/mine-pricebook-candidates.ts`. No new errors, and none in
  `export-estimates.ts`.
- If this fails with an HCP authentication error, stop and report it — the PC's
  saved session expired and a human must run `npm run login`.

**Commit:** `fix: complete and correct the HCP estimates exporter`

---

## Session 3 — single AIWA entry point and its bundle

**Goal:** one script exports the price book, customers, and estimates and
publishes all three CSVs into the RAG ingest directory in one run, and
`npm run build:sync-catalog` produces a self-contained `dist/sync-catalog.mjs`
with no Playwright in it.

**Independent:** no — requires Sessions 1 and 2.

**Context you need (prior sessions' results):**
- `src/hcp/export-pricebook.ts` exports
  `runPricebookExport(): Promise<{ csvPath: string; serviceCount: number; materialCount: number; rowCount: number }>`
  and honors `PRICEBOOK_CSV_PATH`.
- `src/hcp/export-customers.ts` exports
  `runCustomersExport(): Promise<{ csvPath: string; customerCount: number }>`
  and honors `CUSTOMERS_CSV_PATH`.
- `src/hcp/export-estimates.ts` exports
  `runEstimatesExport(): Promise<{ csvPath: string; estimateCount: number; optionCount: number; withLineItems: number }>`
  and honors `ESTIMATES_EXPORT_CSV_PATH`.
- `src/hcp/rag-publish.ts` exports `resolveRagConfig(env?)` returning a
  `RagConfig` with fields `target`, `qdrantUrl`, `collection`, `ingestDir`;
  `publishCsv(cfg, localCsvPath, destFileName?)`; and
  `deletePointsByType(cfg, type)`.

**Stack / decisions:**
- TypeScript, ESM. No new dependencies. esbuild is already installed.
- The job is **local-target only**. On startup resolve the RAG config and, if
  `target` is not `local`, fail immediately with a clear message telling the
  operator to set `RAG_TARGET=local`. This job has no deploy-key path and must
  never grow one.
- **Order: price book, then customers, then estimates.** Estimates last because
  it is by far the slowest step.
- **Destination filenames in the ingest directory must be exactly**
  `pricebook.csv`, `customers.csv`, and `estimates.csv`. The first two are the
  names the retired PC-side scripts used and the ingest has been consuming;
  anything else is a silent regression.
- **Qdrant deletes:** the price book and customer steps must **not** delete
  anything — the ingest is upsert-only for those and today's PC-side publish does
  nothing but copy the file. The estimates step **must** call
  `deletePointsByType(cfg, 'estimate')` before publishing, so re-runs replace
  rather than accumulate. It must never delete type `job` — that belongs to the
  already-deployed jobs sync and deleting it here would destroy 2120 points.
- Each of the three steps runs even if an earlier one failed; collect the
  failures, print them together in the summary, and exit non-zero if any failed.
  A single expired HCP session will fail all three — that is expected. The error
  text must tell the operator to run `npm run login` on the PC and re-place the
  cookie file through Orca.
- Follow the logging shape of `src/hcp/sync-estimates.ts`: progress lines during
  work, then a short summary block naming each export's row count and each
  published path.

**Tasks:**

1. Create `src/hcp/sync-catalog.ts` — the AIWA entry point implementing the
   above. It imports `dotenv/config`, resolves the RAG config, enforces the
   local-only rule, runs the three exports, publishes each CSV under its required
   destination filename, prints the summary, and exits non-zero if any half
   failed. Study `src/hcp/sync-estimates.ts` first and mirror its structure and
   error handling.
2. Add an npm script `build:sync-catalog` bundling `src/hcp/sync-catalog.ts` to
   `dist/sync-catalog.mjs`. Copy the existing `build:sync-estimates` script
   verbatim and change only the entry file and the outfile — the platform,
   target, format and `createRequire` banner flags must match exactly, because
   that combination is what makes the bundle run under plain `node` on the server.
3. Add an npm script `sync-catalog` running `tsx src/hcp/sync-catalog.ts`.

**Verification:**
- Run: `npm run build:sync-catalog` — expected: exits 0, `dist/sync-catalog.mjs`
  exists.
- Search the built bundle for the string `playwright` — expected: **no matches**.
  Report the exact command used and its output.
- Run: `npm run build:sync-estimates` — expected: still exits 0 (proves the
  shared modules were not broken).
- Run `dist/sync-catalog.mjs` with `RAG_TARGET=remote` — expected: non-zero exit
  and the local-only error message, with no network calls to HCP.
- **Full live smoke test** (reads the HCP cloud API, writes only to a throwaway
  directory, touches no server): create a temp directory, then run
  `dist/sync-catalog.mjs` with `RAG_TARGET=local`, `RAG_INGEST_DIR` pointed at
  it, `QDRANT_URL` pointed at a port with nothing listening, and the three
  `*_CSV_PATH` variables pointed at files inside it. Expected: the price book and
  customer halves succeed and write `pricebook.csv` and `customers.csv`; the
  estimates half fails at the Qdrant delete with a connection error; the process
  exits non-zero having still reported the other two. Report each file's size and
  row count and paste the summary block. This proves both the happy path and the
  partial-failure reporting.

**Commit:** `feat: add sync-catalog entry point and bundle for AIWA`

---

## Session 4 — mav-rag ingest support for estimates

**Goal:** a reviewed, tracked modification to the mav-rag ingest that recognizes
the estimates CSV and stores its rows as `type = "estimate"` in the `grizzly_hcp`
Qdrant collection, together with the snapshot it was derived from so it can be
rolled back exactly.

**Independent:** no — depends on Session 2's CSV header.

**Context you need:**
- `deploy/mav-rag/main.py.snapshot-20260728` in this repo is a read-only copy of
  `/opt/mav-rag/ingest/main.py` as it runs today on the AIWA Proxmox host. That
  service is **not** under version control on the host, so this snapshot is the
  only rollback reference. **Never modify the snapshot file** — it must stay a
  byte-exact record of the deployed version.
- The ingest is a Python watchdog observer over a directory of CSVs. Its
  `detect_type(headers)` function classifies a CSV by its header row and returns
  one of `"job"`, `"pricebook_materials"`, or `"customer"`; `"customer"` is the
  fallback when nothing else matches. Each type has its own `process_*_csv`
  function that builds Qdrant points and upserts them. Every ingest path is
  upsert-only — there are no delete calls, and you must not add any.
- The new estimates CSV has exactly this header: `estimate_uuid`, `option_uuid`,
  `estimate_number`, `customer_name`, `customer_email`, `customer_phone`,
  `service_address`, `created_date`, `outcome`, `option_name`, `option_status`,
  `option_total`, `line_items`, `notes`, `assigned_pros` — one row per estimate
  option.

**Stack / decisions:**
- Python 3, matching whatever style and libraries the snapshot already uses. Add
  no new dependencies.
- Produce a **complete modified copy** of the file at `deploy/mav-rag/main.py`,
  derived from the snapshot with the smallest change that works. Also write
  `deploy/mav-rag/README.md`.
- `detect_type` gains an estimate branch returning `"estimate"` when
  `estimate_uuid` is present in the headers. **It must be checked before the
  existing job branch**, so a future column change cannot make an estimates file
  fall through to `"job"`.
- Add a `process_estimates_csv` modeled directly on the existing job processor:
  same collection (`grizzly_hcp`), same embedding call, same upsert call, same
  logging style, same skip-and-count behavior for unusable rows. The payload must
  set `type` to `"estimate"` — that is what keeps the weekly jobs sync, which
  deletes on `type == "job"`, from destroying these points.
- Point IDs must be **deterministic and derived from `option_uuid`**, using the
  same id-construction approach the existing processors use. Re-ingesting the
  same file must overwrite rather than duplicate.
- The embedded text for each row should read like a natural description of the
  estimate — customer, address, outcome, option status, total, and the line items
  — because this collection is what the RAG's estimating endpoint retrieves from.
  Follow the phrasing style the job processor already uses.
- Wire the new branch into whatever dispatch the file already has, so an
  `"estimate"` file is routed to the new processor and still archived to the
  processed directory the same way the other types are.
- **You cannot run this code.** There is no Python environment or mav-rag source
  on this machine, and the service runs in a container on another host.
  Verification is by inspection only. Do not attempt to install Python packages,
  start a container, or reach the server.

**Tasks:**

1. Create `deploy/mav-rag/main.py` — the snapshot with the estimate branch,
   `process_estimates_csv`, and the dispatch wiring added, and nothing else
   changed.
2. Create `deploy/mav-rag/README.md` — what changed and why, the exact apply
   steps through Orca (copy into place, restart the ingest container, confirm it
   picks up an estimates file), the rollback steps using the snapshot, and a
   plain statement that mav-rag is not under version control on the host so this
   directory is the only record.

**Verification:**
- Report a unified diff of `deploy/mav-rag/main.py` against
  `deploy/mav-rag/main.py.snapshot-20260728` and confirm the changes are limited
  to the estimate branch, the new processor, and the dispatch wiring.
- Confirm and state that the snapshot file is unmodified.
- Confirm and state that no `delete` call was added anywhere.
- Confirm and state that the new branch is evaluated before the job branch.
- Confirm the payload `type` value is exactly `estimate`.

**Commit:** `feat: add estimates ingest support artifact for mav-rag`

---

## Session 5 — deploy artifacts and retirement of the PC-side publish path

**Goal:** systemd unit, timer and env template exist for the new job, and every
PC-side script that reaches AIWA with the deploy key for these exports is gone
from the repo.

**Independent:** no — the deploy artifacts describe Session 3's bundle.

**Context you need:** Session 3 produced `dist/sync-catalog.mjs`, a
self-contained bundle whose configuration is entirely environment variables:
`RAG_TARGET`, `RAG_INGEST_DIR`, `QDRANT_URL`, `PRICEBOOK_CSV_PATH`,
`CUSTOMERS_CSV_PATH`, `ESTIMATES_EXPORT_CSV_PATH`, `HCP_COOKIES_FILE`.

**Stack / decisions:**
- The three new files under `deploy/aiwa/` must mirror the existing
  `hcp-estimates-sync.{service,timer,env.example}` files in that same folder.
  Read all three before writing anything and keep the hardening block, the
  comment style, and the "no `[Install]` section in the service" convention
  identical.
- Install root on the server is `/opt/hcp-catalog-sync/`, unit name
  `hcp-catalog-sync`, `SyslogIdentifier=hcp-catalog-sync`, `ExecStart` is
  `/usr/bin/node /opt/hcp-catalog-sync/sync-catalog.mjs`. `/usr/bin/node` is
  v22.23.1 on the target — verified.
- **Schedule: `OnCalendar=Sun *-*-* 04:30:00`**, `Persistent=true`,
  `RandomizedDelaySec=300`. It must NOT be 03:30 — that is when
  `hcp-estimates-sync.timer` fires and its downstream re-embedding runs for
  several minutes. Note in a comment that the host timezone is `America/Chicago`.
- The env template sets `RAG_TARGET=local`,
  `RAG_INGEST_DIR=/mnt/samsung-sata/mav-rag/hcp-exports`,
  `QDRANT_URL=http://localhost:6333`, the three CSV paths under
  `/opt/hcp-catalog-sync/`, and
  `HCP_COOKIES_FILE=/opt/hcp-estimates-sync/secrets/hcp-cookies.json`. That last
  one is deliberate: this job **shares the existing jobs-sync cookie file**
  rather than keeping a second copy of the same secret, so a session refresh is a
  single operation. Put a comment in the template saying so. `ReadWritePaths`
  must include the ingest directory, exactly as the existing unit does.
- Deleting the scripts below is intentional and approved. Their only purpose was
  copying CSVs to the server with the passphrase-less deploy key, which this
  build replaces. `scripts/sync-pricebook.sh` additionally pulled a file that has
  not been regenerated on the server since 2026-06-12.
- `src/hcp/export-jobs.ts` and its `export-jobs` npm script **stay** as a
  local-only tool. Only its publish script is removed — the already-deployed jobs
  sync on the server produces a strictly richer version of the same data.

**Tasks:**

1. Create `deploy/aiwa/hcp-catalog-sync.service`,
   `deploy/aiwa/hcp-catalog-sync.timer`, and
   `deploy/aiwa/hcp-catalog-sync.env.example` per the decisions above.

2. Delete these five files with `git rm`: `scripts/sync-pricebook.sh`,
   `scripts/push-pricebook.sh`, `scripts/push-customers.sh`,
   `scripts/push-jobs.sh`, `scripts/weekly-sync-pricebook.ps1`. Then remove the
   now-dangling `sync-pricebook`, `push-pricebook`, `push-customers` and
   `push-jobs` entries from the `scripts` block of `package.json`. Leave
   `export-pricebook`, `export-customers` and `export-jobs` in place.

3. Rewrite `scripts/weekly-sync-all.ps1`. Its price-book, customers and jobs
   sections all move to the server, so remove them. What remains is the
   brain-vault re-ingest step that runs `scripts/ingest-brain-vault.py` inside
   `C:\Workspace\Infrastructure\agent-os`. While rewriting, fix the stale
   `$ProjectDir` at the top: it currently points at `C:\Users\carte\Grizzly-HCP`,
   a path that does not exist, and it must be `C:\Workspace\Active\grizzly-hcp`.
   Update the header comment to say the HCP exports now run on the server and
   this script only re-ingests the brain vault. Keep the logging helper and
   log-file behavior as they are.

**Verification:**
- Run: `git status --short` — expected: exactly the intended adds, deletes and
  modifications, and **no** untracked `.env` or backup files staged. Report the
  full output.
- Run: `npm run build:sync-catalog` — expected: still exits 0 (proves the
  package.json edit did not break the scripts block).
- Search the whole `scripts/` directory for the deploy key path
  `id_ed25519_proxmox` and report what still matches. `scripts/index-docs.ts` is
  a known separate consumer and is expected to still match; nothing else should.
- Note: systemd unit files cannot be validated on Windows. Do not attempt it; the
  orchestrator validates them on the server before install.

**Commit:** `feat: add hcp-catalog-sync deploy artifacts and retire PC publish scripts`

---

## Session 6 — operator runbook

**Goal:** a deployment and rollback runbook for the new job exists, matching the
depth and structure of the existing runbook.

**Independent:** no — documents Sessions 3, 4 and 5.

**Context you need:** the new job is a weekly systemd oneshot named
`hcp-catalog-sync` installed at `/opt/hcp-catalog-sync/` on the AIWA Proxmox
host, running `/usr/bin/node /opt/hcp-catalog-sync/sync-catalog.mjs` from a
bundle built locally by `npm run build:sync-catalog`. It exports the HCP price
book, customer list, and estimates, and copies `pricebook.csv`, `customers.csv`
and `estimates.csv` into `/mnt/samsung-sata/mav-rag/hcp-exports`, where the
mav-rag ingest watcher picks them up and archives them to
`/mnt/samsung-sata/mav-rag/processed/` with a UTC timestamp prefix. The estimates
step first deletes Qdrant points with `type == "estimate"` so re-runs replace
rather than accumulate; it never touches `type == "job"`. It authenticates with
the shared cookie file at `/opt/hcp-estimates-sync/secrets/hcp-cookies.json`. Its
timer fires Sundays 04:30 America/Chicago, an hour after the existing
`hcp-estimates-sync.timer` at 03:30. Qdrant on the host holds `pricebook` (392
points as of 2026-07-28) and `grizzly_hcp` (2120 points).

Two facts the runbook must state plainly:
- The estimates half only works after the mav-rag ingest change in
  `deploy/mav-rag/` has been applied. Until then the estimates CSV is
  misclassified. The ingest change must be deployed **before or with** this job.
- The deployed unit named `hcp-estimates-sync` actually syncs **jobs**, not
  estimates — the name is historical and is deliberately being kept. This new job
  is the one that handles real estimates.

**Stack / decisions:**
- Read `docs/AIWA-DEPLOY-sync-estimates.md` in full first and follow its section
  structure closely. It is the proven template and the operator already knows it.
- Every step that changes server state must be marked as requiring explicit human
  approval, exactly as the existing runbook does.
- All server access is through Orca in the `aiwa-host` environment. State plainly
  that the deploy key must not be used for any step, since removing its use is
  the entire point of this work.
- The rollback section differs from the existing one and must say so: the PC-side
  publish scripts were **deleted**, not disabled, so rollback means restoring
  them from git history at a named commit — not re-running an npm script that no
  longer exists. Give the concrete git command shape for restoring a deleted file
  from a prior commit. The mav-rag rollback is separate: restore the snapshot
  file as described in `deploy/mav-rag/README.md`.

**Tasks:**

1. Create `docs/AIWA-DEPLOY-catalog-sync.md` covering, in this order: what is
   being installed and why; the mav-rag ingest prerequisite; pre-flight checks on
   the server; file layout and ownership/permission commands under
   `/opt/hcp-catalog-sync/`; the environment file; the shared cookie file and how
   a session refresh works; a manual test run; installing and enabling the timer
   including the check that it does not collide with the 03:30 timer; reading the
   journal by `SyslogIdentifier`; verifying the Qdrant point counts afterward;
   expired-session symptoms and recovery; and rollback.

2. Update the "Key Scripts" table in `CLAUDE.md`: remove rows for npm scripts
   deleted in Session 5 if any appear there, and add rows for
   `npm run export-estimates` and `npm run build:sync-catalog`. Change nothing
   else in that file.

**Verification:**
- Confirm `docs/AIWA-DEPLOY-catalog-sync.md` contains every section listed in
  task 1, that it states the mav-rag prerequisite, and that its rollback section
  describes restoring deleted files from git history rather than re-running
  deleted scripts.
- Run: `git status --short` — expected: only the two intended files changed.

**Commit:** `docs: add AIWA catalog-sync runbook and update key scripts table`

---

## Session 7 (final) — docs + brain-write

**Goal:** project memory and the brain vault reflect this build. **All three
targets below are REQUIRED — updating only two fails this session.**

**Independent:** no

**Context you need — what this build changed:**
- Added `src/hcp/export-estimates.ts` (+ `npm run export-estimates`): the first
  real HCP estimates export, via `/beta/estimates` plus per-option line items
  from `/alpha/estimates/{option}/line_items`. ~810 estimates, one CSV row per
  option, carrying `outcome` (open/won/lost) and per-option totals.
- Added `src/hcp/sync-catalog.ts` (+ `npm run sync-catalog`,
  `npm run build:sync-catalog` → `dist/sync-catalog.mjs`): one self-contained
  bundle that exports the price book, customers, and estimates and writes
  `pricebook.csv`, `customers.csv`, `estimates.csv` into the RAG ingest
  directory. The estimates step deletes Qdrant points of `type = "estimate"`
  first; it never touches `type = "job"`.
- `src/hcp/export-pricebook.ts` and `src/hcp/export-customers.ts` are now
  importable functions with env-overridable output paths; `publishCsv` takes an
  optional destination filename and refuses non-default names on the remote
  target; `deletePointsByType` generalizes the old `deleteJobPoints`.
- Added `deploy/aiwa/hcp-catalog-sync.{service,timer,env.example}` — weekly
  oneshot, Sundays 04:30 America/Chicago, install root `/opt/hcp-catalog-sync/`,
  sharing the existing job's cookie file.
- Added `deploy/mav-rag/` — a snapshot of the live ingest plus a modified copy
  adding an `estimate` type. mav-rag is **not** under version control on the
  host; this directory is the only record and the only rollback reference.
- Deleted `scripts/sync-pricebook.sh`, `scripts/push-pricebook.sh`,
  `scripts/push-customers.sh`, `scripts/push-jobs.sh` and
  `scripts/weekly-sync-pricebook.ps1` and removed their npm entries. Rewrote
  `scripts/weekly-sync-all.ps1` down to the brain-vault ingest step and fixed its
  stale project directory.
- Added `docs/AIWA-DEPLOY-catalog-sync.md`.
- **Not yet deployed.** Installing the unit and applying the ingest change are
  separate human-approved steps. Say so explicitly in all three documents — do
  not describe this as live.

**Findings worth recording:**
- `sync-estimates.ts` never exported estimates. It and `export-jobs.ts` both call
  `/alpha/jobs` with the same header; sync-estimates is a strict superset. The
  deployed `hcp-estimates-sync` unit is a **jobs** sync, deliberately left named
  as-is. Real estimates were not exported by anything until this build.
- The scheduled task "Grizzly Weekly Sync + Brain Vault Ingest" had been failing
  every Sunday (last result 1) because of a stale project directory, so the price
  book in the RAG had not refreshed since 2026-06-30.
- The mav-rag ingest classifies CSVs by header content into exactly three types
  and is upsert-only. `/opt/mav-rag` is not a git repository — worth fixing.

**Tasks:**

1. Update `memory/HANDOFF.md` to describe the state after this build: what is
   built and committed but not deployed, what the next agent must do to deploy it
   (both the ingest change and the timer), and an updated remaining-consumer list
   for the deploy key (`index-docs`, `Watch-HCPExports`, `sync-from-proxmox.ps1`
   remain). Keep the document's existing "start here" shape.

2. Append a dated `## 2026-07-28 — catalog + estimates sync built` entry to
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

**Commit:** `docs: update handoff, journal and brain note for catalog and estimates sync`

---

## Revisions

### 2026-07-28 — estimates export added, jobs question resolved

Carter reviewed the first draft and asked for jobs and estimates both to be
exported weekly. Investigation showed the first draft's premise was half wrong in
an important way, and the plan was rewritten before any execution:

- **Jobs are already covered.** `sync-estimates.ts` and `export-jobs.ts` call the
  same `/alpha/jobs` endpoint with the same header; the former is a strict
  superset. The deployed AIWA unit already syncs all jobs weekly. Nothing more is
  needed, and relocating `export-jobs` would have created two jobs writing
  conflicting data to the same Qdrant points.
- **Estimates were genuinely missing.** Nothing in the repo touched HCP's real
  estimates. The list endpoint was located by probing and by mining
  `data/hcp-api-calls.json`: `/beta/estimates`, ~810 records with `outcome`,
  options, and per-option line items at `/alpha/estimates/{option}/line_items`.
- **The RAG ingest cannot classify estimates today** — `detect_type` knows only
  job, pricebook_materials, and customer. A new session was added to produce a
  reviewed ingest change, complicated by `/opt/mav-rag` not being under version
  control on the host.

Scope grew from 5 sessions to 7. Carter also chose to leave the misnamed
`hcp-estimates-sync` unit alone rather than rename it on the server.

### 2026-07-28 — Session 1 verification corrections

Mechanical corrections only; no scope or design change.

- **Test runner command was wrong in the plan.** `node --test` cannot resolve a
  `*.test.js` file that imports its TypeScript module under a `.js` specifier —
  it fails with `ERR_MODULE_NOT_FOUND`. Corrected to `npx tsx --test` in the
  Codebase Primer and in Session 1's verification step. Under the corrected
  command all 8 tests pass.
- **`PRICEBOOK_CSV_PATH` was not wired.** Session 1 required both exporters to
  honour a CSV path override; `export-customers.ts` got `CUSTOMERS_CSV_PATH` but
  `export-pricebook.ts` kept its hardcoded path. Fixed by the orchestrator (B4
  rung 1 — wiring the blueprint already fully specified, mirroring the pattern
  already present in `export-customers.ts`).
- **Pre-existing typecheck failures (still true).** `npx tsc --noEmit` reports errors in
  `src/automations/estimates/from-proposal.ts` (the retired DOCX flow) and
  `src/hcp/mine-pricebook-candidates.ts`. Neither file is touched by this build.
  Later sessions must treat a clean typecheck as *"no new errors outside those
  two files"*, not a zero-error exit.

### 2026-07-28 — Session 2 verification: corrective session added

Session 2 shipped a working exporter with the correct CSV header, but
verification found four defects. They exceed a mechanical fix, so **Session 2b**
was added rather than patched by the orchestrator. No scope or design change —
the deliverable is still one exporter with the header Session 2 specified.

- **Unstable pagination — my planning error, not the executor's.** Session 2's
  endpoint spec included `sort_by=most_relevant`. Probing the live API directly
  proved the server reorders records between page requests under that sort: a
  full 9-page sweep returned 775 records, 771 distinct, 4 duplicated, and 39 of
  the 810 estimates never appeared at all. The same sweep with `sort_by` removed
  returned 810 fetched / 810 distinct / 0 duplicates. The parameter is removed
  from the Session 2 spec above and from the code in Session 2b.
- **No entry-point guard.** `run()` is invoked at module load, so importing
  `runEstimatesExport` would fire a full export and could call `process.exit(1)`.
  Session 3 imports that function, so this would have broken it.
- **`service_address` precedence reversed**, and `??` let empty strings through
  as real values, blanking the address on 55 of 910 rows.
- **Non-null assertion on a nullable option** (`eo.option!.id`) would throw and
  abort the entire export the first time an optionless estimate appears. It did
  not fire in this run only because every estimate currently has at least one
  option.

Worth recording: the executor's own Session 1 report claimed it had added the
`PRICEBOOK_CSV_PATH` override, and it had not. Reports from the executor are not
evidence — every session is verified against git, the files, and live command
output.

### 2026-07-28 — Session 3: entry guards had to be made bundle-safe

Mechanical correction found by Session 3's own verification; no scope or design
change. Recorded because it changes files Session 1 and Session 2b wrote.

- **esbuild defeats the `import.meta.url` entry-point guard.** In an ESM bundle
  `import.meta.url` resolves to the *bundle's* path, so every bundled module's
  guard compares the bundle against itself and evaluates true. The first run of
  `dist/sync-catalog.mjs` showed all three exporters firing at import time —
  "Fetching Grizzly price book from HCP…", "Fetching all customers…", "Fetching
  estimates…" all printed *before* the `RAG_TARGET` guard could reject the run.
  Each export would also have run twice per invocation. Fixed by requiring the
  script basename to match the module as well, in all three of
  `export-pricebook.ts`, `export-customers.ts` and `export-estimates.ts`.
  Re-verified: with `RAG_TARGET=remote` the bundle now exits 1 with only the
  local-only message and no HCP traffic.
- **The bundle cannot find the HCP cookie file by default.** `auth-cookies.ts`
  resolves its default relative to `__dirname`, which is `dist/` in a bundle, so
  a bundled run fails with "No HCP session found" unless `HCP_COOKIES_FILE` is
  set. This is not a defect — Session 5's env template already sets it — but the
  variable is mandatory for the bundle, not optional, and any smoke test of
  `dist/sync-catalog.mjs` must set it.
