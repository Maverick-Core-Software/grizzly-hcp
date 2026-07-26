# sync-estimates → AIWA Relocation - Build Plan

**Created:** 2026-07-25 by Claude Opus 4.8 (build-handoff planner)
**Target repo:** `C:\Workspace\Active\grizzly-hcp`
**Branch:** `main`
**Design spec:** `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md`

## Codebase Primer

*(Orchestrator-only. Qwen never reads this - session text is self-contained.)*

- **Environment:** Windows 11, PowerShell + Git Bash. Node/npm. Repo is ESM
  (`"type": "module"`), TypeScript run through `tsx` (no build step today).
  `tsconfig.json`: `moduleResolution: "bundler"`, `strict: true`, `outDir: dist`.
- **Import convention:** TS source imports use `.js` specifiers (`./auth.js` →
  `auth.ts`). Follow it exactly; deviating breaks resolution.
- **Key folders:** `src/hcp/` (HCP API client + jobs), `scripts/` (one-off tools),
  `data/` (CSV output, gitignored), `auth/` (cookies, gitignored), `dist/` (gitignored),
  `docs/superpowers/specs/` (design docs).
- **DIRTY FILES - ANOTHER PERSON'S IN-FLIGHT WORK. DO NOT STAGE, EDIT, REVERT, OR
  COMMIT:** `.serena/project.yml`, `package.json`, `src/agent/resolver.ts`,
  `.env.bak-pre-lxc-20260721-130527`, `src/automations/workflows/`. Every session
  stages only its own named files. This is why the plan is designed to require **no
  `package.json` edit until Session 3**, and Session 3's edit is called out explicitly.
- **Gotcha - `npm run login`:** `package.json` maps `login` → `tsx src/hcp/auth.ts`,
  and `auth.ts` self-invokes via a regex on `process.argv[1]`. Session 1 keeps that
  block in `auth.ts` so the script keeps working untouched.
- **Gotcha - 12 consumers:** `scripts/*.ts` (find-job, ui-*, search-hcp-js*, inspect-hcp-js,
  try-app-domain, intercept-addr-change) import `getCookieHeader` from `../src/hcp/auth.js`,
  and `scripts/hcp-relogin.ts` imports `COOKIES_FILE, SESSION_DIR`. The `auth.ts` shim must
  keep all four exports available or these break.
- **No test framework installed.** Plan uses Node's built-in `node:test` + `node:assert/strict`
  executed through the already-present `tsx`. Do not add vitest/jest.
- **Secrets:** never print cookie values or `.env` contents. `auth/` and `.env` are gitignored.

**Not in this plan:** the live AIWA deployment. Sessions produce and verify the code and
the deploy artifacts *locally only*. Applying anything to the Proxmox host (192.168.1.12)
is an Orca-mediated, Carter-approved step the orchestrator performs after all sessions are
verified, following the runbook Session 4 produces. Qwen must never touch AIWA, SSH, or Orca.

---

## Session 1 - Split auth so the runtime path carries no Playwright

**Goal:** `getCookieHeader()` lives in a Playwright-free module, the HCP client uses it, every
existing consumer of `auth.js` still works, and the cookie file path is overridable by env var.
**Independent:** no
**Stack / decisions:** TypeScript, ESM, `.js` import specifiers. No new dependencies. Move code
verbatim where possible - this is a mechanical split, not a rewrite. Keep all existing behavior,
messages, and comments.

**Context you need:** This repo is `C:\Workspace\Active\grizzly-hcp` on branch `main`. It is an
ESM TypeScript project run via `tsx`; TS files import each other with `.js` specifiers (e.g.
`import { x } from './auth.js'` resolves to `auth.ts`). Today `src/hcp/auth.ts` contains four
exports - `COOKIES_FILE`, `SESSION_DIR`, `loginAndSave()`, `getCookieHeader()` - and imports
`chromium` from `playwright` at the top of the file. Because `src/hcp/client.ts` imports from
`./auth.js`, every program that talks to the HCP API drags Playwright into its module graph.
We are going to run one of those programs on a headless Linux server that must not have
Playwright, so the split below is required.

**Tasks:**

1. **Create `src/hcp/auth-cookies.ts`** - the Playwright-free runtime half.
   - It must export a `COOKIES_FILE` string constant and an async `getCookieHeader()` function.
   - Move the existing `getCookieHeader()` implementation from `src/hcp/auth.ts` into this file
     unchanged in behavior: read the cookies JSON file, throw `'No HCP session found. Run: npm run login'`
     if the file cannot be read, throw `'HCP cookie file is empty. Run: npm run login'` if the parsed
     array is empty, filter out expired cookies (an `expires` value that is falsy or `-1` means a
     session cookie and is kept; a positive value is a Unix timestamp in seconds compared against
     `Date.now() / 1000`), throw `'HCP session has expired. Run: npm run login'` if nothing survives
     the filter, warn on stderr if no cookie named `csrf_token` survives, and return the surviving
     cookies joined as a `name=value; name=value` header string.
   - **New behavior:** `COOKIES_FILE` must honor an environment variable override. If
     `process.env.HCP_COOKIES_FILE` is set and non-empty, use it as an absolute path verbatim.
     Otherwise fall back to the current default, which is `auth/hcp-cookies.json` resolved
     relative to the repo root (today computed from `import.meta.url` as
     `path.resolve(__dirname, '../../auth/hcp-cookies.json')` - preserve that fallback exactly).
   - This file must NOT import `playwright` or anything that imports it.

2. **Create `src/hcp/auth-login.ts`** - the interactive, PC-only half.
   - Move `SESSION_DIR` and the entire `loginAndSave()` implementation here from `auth.ts`,
     including the `playwright` `chromium` import, unchanged in behavior: launch a visible
     persistent browser context for manual login, wait for the user to close it, then relaunch
     headless and poll up to 15 seconds for the `csrf_token` cookie, then write all cookies to
     the cookies file as pretty-printed JSON.
   - It must import `COOKIES_FILE` from `./auth-cookies.js` rather than redefining it, so the
     login path and the runtime path always agree on where cookies live.

3. **Rewrite `src/hcp/auth.ts` as a thin compatibility shim.**
   - It must re-export all four names so existing importers keep working: `COOKIES_FILE` and
     `getCookieHeader` from `./auth-cookies.js`, and `SESSION_DIR` and `loginAndSave` from
     `./auth-login.js`.
   - It must KEEP the existing command-line self-invocation block at the bottom of the current
     file - the one that tests `process.argv[1]` against the regex
     `/[/\\]hcp[/\\]auth\.(ts|js)$/` and calls `loginAndSave().catch(console.error)` when it
     matches. `package.json` maps `npm run login` to `tsx src/hcp/auth.ts`, and that must keep
     working without any change to `package.json`.
   - Do not edit `package.json` in this session.

4. **Modify `src/hcp/client.ts`** - change its single import of `getCookieHeader` so it comes
   from `./auth-cookies.js` instead of `./auth.js`. Change nothing else in that file.

**Interfaces (exact):**
- `src/hcp/auth-cookies.ts` exports: `COOKIES_FILE: string`, `getCookieHeader(): Promise<string>`
- `src/hcp/auth-login.ts` exports: `SESSION_DIR: string`, `loginAndSave(): Promise<void>`
- `src/hcp/auth.ts` re-exports all four of the above and retains its CLI self-invoke block
- Environment variable name, exact spelling: `HCP_COOKIES_FILE`

**Verification:**
- Run: `npx tsx -e "const m = await import('./src/hcp/auth-cookies.ts'); console.log(typeof m.getCookieHeader, typeof m.COOKIES_FILE)"`
  - expected: `function string`
- Run: `npx tsx -e "const m = await import('./src/hcp/auth.ts'); console.log(typeof m.getCookieHeader, typeof m.loginAndSave, typeof m.SESSION_DIR, typeof m.COOKIES_FILE)"`
  - expected: `function function string string`
- Run: `grep -ci playwright src/hcp/auth-cookies.ts`
  - expected: `0`
- Run: `grep -n "auth-cookies" src/hcp/client.ts`
  - expected: one line showing the import now points at `./auth-cookies.js`
- Run: `HCP_COOKIES_FILE=/tmp/does-not-exist.json npx tsx -e "const m = await import('./src/hcp/auth-cookies.ts'); console.log(m.COOKIES_FILE); await m.getCookieHeader().catch(e => console.log('ERR:', e.message))"`
  - expected: prints `/tmp/does-not-exist.json` then `ERR: No HCP session found. Run: npm run login`

**Commit:** stage ONLY `src/hcp/auth-cookies.ts`, `src/hcp/auth-login.ts`, `src/hcp/auth.ts`,
`src/hcp/client.ts`. Do NOT use `git add -A` or `git add .` - other modified files in this repo
belong to someone else's unfinished work and must stay uncommitted.
Commit message: `refactor: split HCP auth into runtime and login halves`

---

## Session 2 - RAG publish abstraction (local vs remote target)

**Goal:** `sync-estimates` publishes its results through a single configurable module that can
either reach a remote host (today's behavior) or act purely locally, with unit tests covering
the configuration and the local path.
**Independent:** no (depends on Session 1's `auth-cookies.ts` existing; do not re-create it)
**Stack / decisions:** TypeScript, ESM, `.js` import specifiers. Tests use Node's built-in
`node:test` and `node:assert/strict` - do NOT install vitest, jest, or any test library. No new
dependencies at all in this session. Use the global `fetch` (built into Node) for HTTP; do not
add axios or node-fetch.

**Context you need:** This repo is `C:\Workspace\Active\grizzly-hcp` on branch `main`, an ESM
TypeScript project run via `tsx`, where TS files import each other with `.js` specifiers.
`src/hcp/sync-estimates.ts` is a script that downloads job data from an external API, writes a
CSV to `data/estimates-enriched.csv`, and then does two things to publish it to a search backend
on a remote machine: (a) it shells out over SSH to POST a delete request to a Qdrant vector
database, clearing points whose payload field `type` equals `job`, and (b) it copies the CSV to
that machine with `scp`. Those two steps are currently written inline near the bottom of the file
using `execSync` and hardcoded constants `SSH_KEY`, `PROXMOX`, and `REMOTE_PATH`.

We are going to run this same script directly ON that remote machine, where the Qdrant database
and the destination directory are both local. So the two publish steps must become swappable:
"remote" keeps today's SSH/SCP behavior exactly, and "local" does the same work with a plain
HTTP request to localhost and an ordinary file copy. Nothing else about the script changes.

**Tasks:**

1. **Create `src/hcp/rag-publish.ts`** - the publish abstraction.
   - Export a `RagTarget` type that is the union of the two string literals `'local'` and `'remote'`.
   - Export a `RagConfig` type describing the resolved settings: the target, the Qdrant base URL,
     the Qdrant collection name, the destination directory for the CSV, and (for the remote target
     only) the SSH key path, the `user@host` string, and the full remote file path.
   - Export `resolveRagConfig(env)` which reads configuration from an environment-variable bag
     (default it to `process.env`) and returns a fully-populated `RagConfig`. Defaults when a
     variable is unset: target `remote`; Qdrant URL `http://localhost:6333`; collection
     `grizzly_hcp`; ingest directory `/mnt/samsung-sata/mav-rag/hcp-exports`. The remote-only
     values keep the constants that are in `sync-estimates.ts` today: SSH key
     `C:/Users/carte/.ssh/id_ed25519_proxmox`, host `root@192.168.1.12`, remote path
     `/mnt/samsung-sata/mav-rag/hcp-exports/estimates-enriched.csv`. Reject an unrecognized
     target value by throwing an error that names the offending value and lists the two valid ones.
   - Export `deleteJobPoints(cfg)` - clears stale points from the Qdrant collection. For the
     `local` target it issues an HTTP POST with `fetch` to the collection's points-delete endpoint
     (path shape: the collection name followed by `/points/delete`) with a JSON content type and a
     body that filters on payload key `type` matching value `job`; a non-OK response must throw an
     error including the status code and response text. For the `remote` target it must run
     byte-for-byte the same `execSync` SSH command that `sync-estimates.ts` runs today - move that
     string here unchanged so behavior is preserved.
   - Export `publishCsv(cfg, localCsvPath)` - delivers the CSV. For the `local` target it ensures
     the destination directory exists (recursive create) and copies the file to that directory
     under the name `estimates-enriched.csv`. For the `remote` target it must run byte-for-byte the
     same `execSync` scp command that `sync-estimates.ts` runs today.
   - Both functions must log a short line saying which target they are using, so the operator can
     tell from the output whether it ran locally or remotely.

2. **Create `src/hcp/rag-publish.test.ts`** - tests using `node:test` and `node:assert/strict`.
   Cover at minimum: (a) `resolveRagConfig({})` returns the documented defaults including target
   `remote`; (b) `resolveRagConfig` honors each environment variable override; (c) an invalid
   target string throws; (d) `publishCsv` with the `local` target actually creates the destination
   directory and copies a temporary source file into it with the expected name and contents. Use
   Node's `os.tmpdir()` for scratch paths and clean up what you create. Do not make any network
   calls in the tests.

3. **Modify `src/hcp/sync-estimates.ts`** - replace the two inline publish steps.
   - Delete the now-unused `SSH_KEY`, `PROXMOX`, and `REMOTE_PATH` constants and the inline
     `execSync` blocks for the Qdrant delete and the scp upload (steps 4 and 5 in the file's
     numbered flow). Replace them with a call to `resolveRagConfig()` followed by calls to
     `deleteJobPoints` and `publishCsv`, imported from `./rag-publish.js`.
   - **Also make the CSV output path overridable:** if `process.env.ESTIMATES_CSV_PATH` is set and
     non-empty use it verbatim, otherwise keep today's default of `data/estimates-enriched.csv`
     resolved relative to the repo root. This matters because when the script runs from a bundled
     single file the repo-relative default no longer points anywhere sensible.
   - Everything else in the file - the API pagination, the concurrency-limited line-item fetch,
     the CSV construction, and all console output - must stay exactly as it is. Remove the
     `execSync` import only if nothing else in the file still uses it.

**Interfaces (exact):**
- `resolveRagConfig(env?: NodeJS.ProcessEnv): RagConfig`
- `deleteJobPoints(cfg: RagConfig): Promise<void>`
- `publishCsv(cfg: RagConfig, localCsvPath: string): Promise<void>`
- Environment variable names, exact spelling: `RAG_TARGET` (values `local` | `remote`),
  `QDRANT_URL`, `QDRANT_COLLECTION`, `RAG_INGEST_DIR`, `ESTIMATES_CSV_PATH`
- Published CSV filename in the destination directory, exact spelling: `estimates-enriched.csv`

**Verification:**
- Run: `npx tsx --test src/hcp/rag-publish.test.ts`
  - expected: all tests pass, final summary shows `fail 0`
  - if `tsx --test` is rejected by your tsx version, run
    `node --import tsx --test src/hcp/rag-publish.test.ts` instead and report which one you used
- Run: `npx tsx -e "const m = await import('./src/hcp/rag-publish.ts'); const c = m.resolveRagConfig({}); console.log(c.target, c.qdrantUrl, c.collection)"`
  - expected: `remote http://localhost:6333 grizzly_hcp`
- Run: `npx tsx -e "const m = await import('./src/hcp/rag-publish.ts'); console.log(m.resolveRagConfig({ RAG_TARGET: 'local' }).target)"`
  - expected: `local`
- Run: `grep -c "id_ed25519_proxmox" src/hcp/sync-estimates.ts`
  - expected: `0`
- Run: `grep -n "rag-publish" src/hcp/sync-estimates.ts`
  - expected: one import line

**Commit:** stage ONLY `src/hcp/rag-publish.ts`, `src/hcp/rag-publish.test.ts`,
`src/hcp/sync-estimates.ts`. Do NOT use `git add -A` or `git add .` - other modified files in
this repo belong to someone else's unfinished work and must stay uncommitted.
Commit message: `feat: configurable RAG publish target for sync-estimates`

---

## Session 3 - Self-contained bundle for headless Linux

**Goal:** a single-file JavaScript bundle of the sync-estimates job that runs on a machine with
only Node installed - no `node_modules`, no TypeScript toolchain, and provably no Playwright.
**Independent:** no (needs Sessions 1 and 2 complete)
**Stack / decisions:** Use **esbuild** as a devDependency - it is the right tool and the only new
dependency in this entire plan. Bundle format ESM, platform node, target node20, output to
`dist/` (already gitignored). Do not add a bundler config file; a single npm script is enough.

**Context you need:** This repo is `C:\Workspace\Active\grizzly-hcp` on branch `main`. It is an
ESM TypeScript project (`"type": "module"`) that today has no build step - everything runs
through `tsx`. `dist/` is already listed in `.gitignore`. The entry point we need to bundle is
`src/hcp/sync-estimates.ts`. Its runtime module graph, after earlier work in this repo, consists
of that file plus `src/hcp/client.ts`, `src/hcp/auth-cookies.ts`, `src/hcp/rag-publish.ts`, and
the `dotenv` package - notably it does NOT include `playwright`, and it must stay that way,
because the target machine is a headless server where Playwright cannot and must not be installed.

**IMPORTANT - shared file warning:** `package.json` in this repo currently has uncommitted
changes made by someone else (four `workflow:*` script entries near the end of the `scripts`
block). You must ADD to this file without disturbing those lines, and when you commit it those
lines will be carried along - that is expected and acceptable. Do not revert them, reorder the
file, reformat it, or run any command that rewrites it wholesale.

**Tasks:**

1. **Add esbuild as a devDependency** by running the package manager's install command for a dev
   dependency named `esbuild` (do not hand-edit the dependency version into the file; let the
   tool write it). Confirm afterward that it landed in `devDependencies`, not `dependencies`.

2. **Add a build script to `package.json`** named exactly `build:sync-estimates`. It must invoke
   esbuild on entry point `src/hcp/sync-estimates.ts` with bundling enabled, platform node,
   target node20, output format ESM, and output file `dist/sync-estimates.mjs`. Add it as one new
   line in the existing `scripts` block. Change nothing else in the file.

3. **Verify the bundle is clean and actually runs.** The bundle must not contain Playwright, and
   it must be able to start, resolve its configuration, and fail for the *right* reason when no
   HCP session is available. See Verification for the exact commands.

**Interfaces (exact):**
- npm script name: `build:sync-estimates`
- bundle output path: `dist/sync-estimates.mjs`
- esbuild flags: `--bundle --platform=node --target=node20 --format=esm --outfile=dist/sync-estimates.mjs`

**Verification:**
- Run: `npm run build:sync-estimates`
  - expected: esbuild reports success and writes `dist/sync-estimates.mjs`; no errors
- Run: `grep -ci playwright dist/sync-estimates.mjs`
  - expected: `0`
- Run: `grep -ci chromium dist/sync-estimates.mjs`
  - expected: `0`
- Run: `node -e "console.log(require('fs').statSync('dist/sync-estimates.mjs').size)"`
  - expected: a number well under 500000 (a bundle in the megabytes means Playwright leaked in - investigate)
- Run: `RAG_TARGET=local HCP_COOKIES_FILE=/tmp/no-such-cookies.json node dist/sync-estimates.mjs`
  - expected: exits non-zero and prints a failure mentioning `No HCP session found` - this proves
    the bundle loads, resolves config, and reaches the HCP client without Playwright. Any other
    error (module not found, syntax error, Playwright reference) is a failure of this session.
- Run: `node -e "const p=require('./package.json'); console.log(!!p.devDependencies.esbuild, !!p.scripts['build:sync-estimates'])"`
  - expected: `true true`

**Commit:** stage ONLY `package.json` and `package-lock.json`. Do NOT stage `dist/` (it is
gitignored). Do NOT use `git add -A` or `git add .` - other modified files in this repo belong to
someone else's unfinished work and must stay uncommitted. Note in your report that `package.json`
also carries the four pre-existing `workflow:*` script lines you did not write.
Commit message: `build: esbuild bundle for headless sync-estimates`

---

## Session 4 - Deployment artifacts and runbook

**Goal:** the systemd unit, timer, environment template, and a written runbook exist in the repo,
reviewed and ready for a human to apply to the server later. Nothing is deployed in this session.
**Independent:** no (describes artifacts produced by Sessions 1-3)
**Stack / decisions:** Plain text files - systemd unit syntax and Markdown. No code, no scripts,
no installation, no network access. These files are documentation and configuration only.

**Context you need:** This repo is `C:\Workspace\Active\grizzly-hcp` on branch `main`. Earlier work
produced a single-file bundle at `dist/sync-estimates.mjs` that pulls job data from an external
API, writes a CSV, clears stale points from a Qdrant collection over HTTP, and copies the CSV into
an ingest directory. It is configured entirely through environment variables:
`RAG_TARGET` (`local` or `remote`), `QDRANT_URL`, `QDRANT_COLLECTION`, `RAG_INGEST_DIR`,
`ESTIMATES_CSV_PATH`, and `HCP_COOKIES_FILE`.

That bundle is going to be installed on a headless Debian-based Linux server under
`/opt/hcp-estimates-sync/`, where it will run **once a week** on a systemd timer. On that server
the Qdrant database is reachable at `http://localhost:6333`, the ingest directory is
`/mnt/samsung-sata/mav-rag/hcp-exports`, and the job's private files live under
`/opt/hcp-estimates-sync/`. The job authenticates to the external API with a cookies JSON file
that a human produces by logging in through a browser on a Windows PC; that file is copied to the
server by hand and its session eventually expires, at which point the job fails and a human must
repeat the browser login. **You are only writing these files. Do not attempt to connect to any
server, do not run systemd commands, and do not run anything that touches a network.**

**Tasks:**

1. **Create `deploy/aiwa/hcp-estimates-sync.service`** - a systemd one-shot service unit.
   It must: describe itself clearly in a `Description`; be `Type=oneshot`; run the bundle with
   `node /opt/hcp-estimates-sync/sync-estimates.mjs`; set its working directory to
   `/opt/hcp-estimates-sync`; load its configuration from an `EnvironmentFile` at
   `/opt/hcp-estimates-sync/hcp-estimates-sync.env`; and route output to the journal with a
   recognizable syslog identifier. Include modest hardening directives appropriate for a one-shot
   job that needs to read its own directory and write to the ingest directory - at minimum
   `NoNewPrivileges`, `PrivateTmp`, and `ProtectSystem`. Do not add a `[Install]` section - the
   timer is what gets enabled, not the service.

2. **Create `deploy/aiwa/hcp-estimates-sync.timer`** - the weekly schedule.
   It must trigger the service above on a weekly calendar schedule (choose Sunday at 03:30 server
   local time), set `Persistent=true` so a run missed while the machine was off fires on next boot,
   add a randomized delay of a few minutes to avoid a thundering herd, and include an `[Install]`
   section wanting `timers.target`. Add a comment noting that the server's local timezone must be
   confirmed before enabling, since the schedule is expressed in server local time.

3. **Create `deploy/aiwa/hcp-estimates-sync.env.example`** - a documented template of the
   environment file. It must list every variable the job reads with the correct server value and a
   short comment for each: `RAG_TARGET` set to `local`, `QDRANT_URL` set to the localhost Qdrant
   address, `QDRANT_COLLECTION` set to `grizzly_hcp`, `RAG_INGEST_DIR` set to the ingest directory
   above, `ESTIMATES_CSV_PATH` set to a working path under `/opt/hcp-estimates-sync/`, and
   `HCP_COOKIES_FILE` set to `/opt/hcp-estimates-sync/secrets/hcp-cookies.json`. **This file must
   contain no real secret values** - it is a committed template. State in a comment that the
   cookies file itself is a secret, is never committed, and is placed on the server by hand.

4. **Create `docs/AIWA-DEPLOY-sync-estimates.md`** - the operator runbook, written for a human who
   will perform the deployment by hand later. It must cover, in order: (a) a short statement of
   what is being installed and why; (b) a pre-flight checklist to confirm on the server before
   installing - that Node is installed and its version, that the ingest directory exists, that
   Qdrant answers on localhost, and that the target collection exists; (c) the file layout to
   create under `/opt/hcp-estimates-sync/` with correct ownership and with the secrets directory
   and cookies file restricted to owner-only permissions; (d) how the cookies file is produced on
   the PC and transferred, explicitly noting it must NOT be sent with `scp` using an SSH key and
   must instead go through the sanctioned deployment tool; (e) how to do a single manual test run
   and what healthy output looks like; (f) how to enable and start the timer and how to confirm
   the next scheduled run; (g) how to read the job's logs; (h) what an expired session looks like
   and the exact recovery steps; and (i) a rollback section stating that disabling the timer
   restores the previous arrangement, in which the same job is run by hand from the PC.
   Add a prominent note near the top that every step which changes the running server requires
   explicit human approval before it is performed.

**Interfaces (exact spellings):**
- paths: `deploy/aiwa/hcp-estimates-sync.service`, `deploy/aiwa/hcp-estimates-sync.timer`,
  `deploy/aiwa/hcp-estimates-sync.env.example`, `docs/AIWA-DEPLOY-sync-estimates.md`
- server install root: `/opt/hcp-estimates-sync/`
- server bundle name: `sync-estimates.mjs`
- server env file: `/opt/hcp-estimates-sync/hcp-estimates-sync.env`
- server cookies file: `/opt/hcp-estimates-sync/secrets/hcp-cookies.json`
- systemd unit base name: `hcp-estimates-sync`

**Verification:**
- Run: `ls deploy/aiwa/`
  - expected: the three files named above are present
- Run: `grep -c "OnCalendar" deploy/aiwa/hcp-estimates-sync.timer`
  - expected: `1`
- Run: `grep -c "Persistent=true" deploy/aiwa/hcp-estimates-sync.timer`
  - expected: `1`
- Run: `grep -E "RAG_TARGET|HCP_COOKIES_FILE|RAG_INGEST_DIR|QDRANT_URL|QDRANT_COLLECTION|ESTIMATES_CSV_PATH" deploy/aiwa/hcp-estimates-sync.env.example`
  - expected: all six variables appear
- Run: `grep -ci "approval" docs/AIWA-DEPLOY-sync-estimates.md`
  - expected: at least `1`
- Confirm by reading the files: the `.env.example` contains no real cookie, token, password, or key value.

**Commit:** stage ONLY `deploy/aiwa/hcp-estimates-sync.service`,
`deploy/aiwa/hcp-estimates-sync.timer`, `deploy/aiwa/hcp-estimates-sync.env.example`, and
`docs/AIWA-DEPLOY-sync-estimates.md`. Do NOT use `git add -A` or `git add .` - other modified
files in this repo belong to someone else's unfinished work and must stay uncommitted.
Commit message: `deploy: systemd unit, timer, and runbook for AIWA sync-estimates`

---

## Session 5 (final) - docs + brain-write

**Goal:** project memory and the brain vault reflect this build. All three targets are REQUIRED -
skipping any one of them fails this session.
**Independent:** no

**Context you need:** This repo is `C:\Workspace\Active\grizzly-hcp` on branch `main`. It does not
currently have a `memory/` directory - create it. The work just completed, across four previous
sessions, did the following: it split the HCP authentication module into a Playwright-free runtime
half (`src/hcp/auth-cookies.ts`) and an interactive login half (`src/hcp/auth-login.ts`) behind a
compatibility shim at `src/hcp/auth.ts`; it introduced `src/hcp/rag-publish.ts`, which makes the
publish step of `src/hcp/sync-estimates.ts` switchable between a `remote` target (the original
SSH and SCP behavior, still the default) and a `local` target (a direct HTTP call to Qdrant and an
ordinary file copy); it added an esbuild build script producing a self-contained bundle at
`dist/sync-estimates.mjs` that contains no Playwright; and it added systemd deployment artifacts
under `deploy/aiwa/` plus an operator runbook at `docs/AIWA-DEPLOY-sync-estimates.md`.

The purpose of all of it: the sync-estimates job is being relocated from the Windows PC to run
natively on the Proxmox host at 192.168.1.12 as a weekly systemd timer. Running it there turns its
two remote operations into local ones, which removes this job's dependency on a passphrase-less
SSH key - the first step toward retiring that key entirely. **Nothing has been deployed to any
server yet;** that is a separate, human-approved step that follows the runbook. The design
document behind the work is
`docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md`.

**Tasks:**

1. **Create `memory/HANDOFF.md`** - the current-state document. It must state what now exists in
   the repo after this build, what is deliberately NOT done yet (the live deployment), which
   environment variables configure the job, that the PC path still works unchanged as the rollback,
   and where the runbook and design spec live. Write it for someone picking this up cold.

2. **Create `memory/JOURNAL.md`** with a dated entry for 2026-07-25 describing this build. Use a
   format where new entries are appended below older ones, and add a note at the top of the file
   saying entries are append-only and history is never rewritten.

3. **Update the brain vault project note at `C:\Workspace\Active\brain\projects\grizzly-hcp.md`**
   - read the existing file first and match its established structure and heading style, then add
   a dated section covering this build and its purpose. Preserve everything already in that file;
   this is an addition, not a rewrite. **This task is not optional - skipping it fails the session.**

**Verification:**
- Run: `ls memory/`
  - expected: `HANDOFF.md` and `JOURNAL.md` both present
- Run: `grep -c "2026-07-25" memory/JOURNAL.md`
  - expected: at least `1`
- Run: `grep -c "2026-07-25" "C:/Workspace/Active/brain/projects/grizzly-hcp.md"`
  - expected: at least `1`
- Run: `grep -ci "rag-publish\|sync-estimates" memory/HANDOFF.md`
  - expected: at least `1`
- Confirm by reading: the brain vault note still contains all of its original content.

**Commit:** stage ONLY `memory/HANDOFF.md` and `memory/JOURNAL.md`. The brain vault file lives
outside this repository and is not committed here. Do NOT use `git add -A` or `git add .` - other
modified files in this repo belong to someone else's unfinished work and must stay uncommitted.
Commit message: `docs: handoff + journal for sync-estimates AIWA relocation`

---

## Revisions

*(Empty at plan creation. The orchestrator appends dated entries here when the plan changes
mid-run: what changed and why.)*
