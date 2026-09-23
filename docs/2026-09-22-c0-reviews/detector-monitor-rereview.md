VERDICT: REJECT

## Findings

### MAJOR — a partially corrupt monitor alert-state file can suppress an alert

**File:** `canary/c0/monitor/index.ts:30-39`

`createNodeMonitorAlertState().load()` discards a malformed line but retains every other parseable `{ id, tier }` line.  If `monitor-alerts.jsonl` contains one corrupt line plus a valid-looking crossing for an unchanged stale record (or the `human_reconciliation_required` count-level key), the monitor reloads that crossing and suppresses the next alert, even though the state file is corrupt.  A fake-only reproduction wrote `not-json` followed by `{"id":"ob_fixture_only","tier":"stale"}` and `load()` returned the latter crossing; this is silence rather than the required fail-toward-alerting behavior.  Treat any non-blank malformed/invalid line or read failure as an unavailable state file and return no crossings for that entire load, then add fixtures for mixed valid/corrupt state and the reconciliation crossing to prove both re-alert.

## Controls rechecked

- **Future answered-marker deadline:** detector clamps an answered marker's future mtime to the first detector tick and retains that observed timestamp per CallSid (`detector/src/detector.ts:149-167`).  The focused fake advances its clock six seconds after a future marker and proves exactly one redirect (`detector.check.ts:104-118`).
- **Outbound fallback behavior:** overdue calls persist the redirect marker before provider work, attempt exactly one Sync transfer flag, and then exactly one parent-call fallback redirect; Sync failure remains non-blocking to the human fallback (`detector.ts:169-202`, `detector.check.ts:69-102`).  The process starts no listener.
- **Reconciliation signal and outbox immutability:** monitor derives a count-level `human_reconciliation_required` crossing from `analyzeOutboxHealth`, emits a redacted once-per-crossing alert, and receives only `listRecords` rather than an outbox write capability (`monitor/index.ts:70-145`).  Its check proves the redacted alert, unchanged-count dedupe, and unchanged outbox hash (`monitor/index.check.ts:47-59`).
- **Separate state placement/redaction/restart:** successful crossings are atomically saved under `<dataRoot>/monitor-alerts.jsonl` with only an opaque record id plus tier; `StaleOutboxEntry.id` is the hashed `ob_…` record id, not the CallSid/payload.  Restart dedupe and state redaction pass, but the mixed-corruption handling above prevents acceptance.
- **File-authoritative configuration:** both entries load only `canary/c0/.env.c0` using `dotenv.parse`; inherited `VOICE_C0_*`/`VOICE_OUTBOX_*` differences throw a refusal (`detector/src/env.ts:7-25`, `monitor/env.ts:5-23`).  The review inspected the names-only template as specifically requested; no real environment file was opened.
- **Canonical data root:** detector, monitor, and agent each default to `<repo>/data/c0`, require an absolute configured `VOICE_C0_DATA_DIR`, and assert the `src/agent/voice` repository anchor.  Their resolved default and absolute-path behavior match.
- **Canary-number SID:** `VOICE_C0_CANARY_NUMBER_SID` appears in the names-only template and the detector exact-order check.

## Verification performed

- `npm run check && npm run typecheck` in `canary/c0/detector` — **PASS** (`policy`, `data-root`, `detector`, `env`, and `env-example` checks; TypeScript clean).
- `npm run check && npm run typecheck` in `canary/c0/monitor` — **PASS** (`data-root`, `env`, and `index` checks; TypeScript clean).
- `node canary/c0/ecosystem.c0.config.check.cjs` from the worktree root — **PASS**.
- Fake-only monitor-state corruption probe using `createNodeMonitorAlertState` — **reproduced the MAJOR**: a mixed malformed/valid state file loads the surviving valid crossing.  No provider or account API was called.

## Fix response

- **MAJOR — partially corrupt monitor alert state:** `createNodeMonitorAlertState.load()` now treats any non-`ENOENT` read error or any non-blank malformed/invalid JSONL line as unavailable and returns no crossings, so the monitor fails toward re-alerting.  A redacted warning is emitted once on the next enabled tick, and the existing atomic `save()` path rewrites clean state only after a subsequently delivered alert.
- **Coverage:** the monitor check now proves mixed valid/corrupt state does not retain the otherwise-valid crossing and re-alerts, a non-`ENOENT` unreadable state path re-alerts, and the pre-existing clean-file restart fixture continues to dedupe across restart.
