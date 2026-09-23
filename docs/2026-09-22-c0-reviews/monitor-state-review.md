VERDICT: REJECT

## Findings

### MAJOR — runtime configuration can alias the monitor state file to the outbox and destroy records

**File:** `canary/c0/monitor/index.ts:192-197`

`loadRuntime()` independently resolves `VOICE_C0_DATA_DIR` for `createNodeMonitorAlertState(dataRoot)` and `VOICE_OUTBOX_PATH` for `new Outbox(resolveOutboxPath(c0, repoRoot))`, but never rejects equality.  `VOICE_OUTBOX_PATH=data/c0/monitor-alerts.jsonl` therefore makes the state file and the durable outbox the same path.  After the first delivered stale alert, `persistAlertState()` atomically renames the redacted crossing JSONL onto that shared path, replacing the outbox record with monitor state; a fake-only isolated reproduction appended one stale outbox record at that alias, ran one monitor tick, and observed `alias records=0` on the reopened outbox.  This violates the explicit read-only-outbox and separate-state invariants, and can lose a caller’s durable C0 intent rather than merely suppressing an alert.

**Fix:** resolve both absolute paths in `loadRuntime()` and refuse startup when they are equal (preferably also reject the state path being inside the configured outbox path if directory paths are ever accepted).  Add a focused fixture configuring this exact alias, assert startup refusal before an alert is sent, and retain the existing hash proof for the normal distinct-path case.

## Controls that pass

- `createNodeMonitorAlertState.load()` returns no crossings and `unavailable: true` for any non-`ENOENT` read error and for every malformed or invalid nonblank JSONL row ([index.ts](../../canary/c0/monitor/index.ts:50)).  It does not preserve an otherwise valid earlier row.
- The warning is redacted and emitted once on the next enabled tick ([index.ts](../../canary/c0/monitor/index.ts:110)); clean state is written only through the existing temporary-file plus rename path after state changes caused by a delivered alert ([index.ts](../../canary/c0/monitor/index.ts:98), [index.ts](../../canary/c0/monitor/index.ts:167)).
- The clean, non-aliased state fixture continues to dedupe across restart, the monitor receives only `listRecords`, and the existing hash proof verifies no write to the separately configured outbox ([index.check.ts](../../canary/c0/monitor/index.check.ts:23), [index.check.ts](../../canary/c0/monitor/index.check.ts:40)).
- `human_reconciliation_required` rise/dedupe/redaction remains covered and passes ([index.check.ts](../../canary/c0/monitor/index.check.ts:81)).

## Verification

| Command | Result |
| --- | --- |
| `npm run check` (from `canary/c0/monitor`) | Passed: `data-root.check OK`, `env.check OK`, `index.check OK`. |
| `npm run typecheck` (from `canary/c0/monitor`) | Passed with no diagnostics. |
| `npx --prefix canary/c0/agent tsx canary/c0/integration/cross-component.check.ts` | Passed: all eight contracts and `cross-component.check OK`. |
| Fake-only temp-dir outbox/state alias probe | Reproduced loss: one delivered alert rewrote the aliased outbox and reopening it returned zero records. |
| `git diff --check -- canary/c0/monitor` | Passed with no whitespace diagnostics. |

## Re-review

VERDICT: REJECT

### MAJOR — an absent file beneath a Windows junction bypasses the alias guard

**File:** `canary/c0/monitor/data-root.ts:28-35`

`normalizeMonitorStoragePath()` calls `realpathSync.native()` on the complete candidate.  When the final state or outbox file does not yet exist, it receives `ENOENT` and compares lexical `path.resolve()` values instead of resolving the existing parent directory.  On Windows, a configured `VOICE_C0_DATA_DIR` that is a junction can therefore point at the real directory containing a separately spelled `VOICE_OUTBOX_PATH`: `resolveMonitorStoragePaths(junction, actual\\monitor-alerts.jsonl)` returned normally while both candidates named the same absent file.  The subsequent alert-state save follows the junction and can replace the outbox, recreating the original MAJOR before a state file exists.

**Fix:** canonicalize every future candidate by walking upward to its nearest existing parent, `realpath` that parent, and then appending the missing path segments before Windows case folding and collision comparison.  Add the feasible Windows junction fixture above (with both target files absent) and assert `c0_monitor_state_outbox_path_collision`; retain the exact, case-only, temporary-target, corruption, restart, reconciliation, and distinct-path fixtures.

The guard does correctly reject lexical exact, simulated Windows case-only, and explicit `.tmp` target aliases before either store is constructed, but those checks do not cover a nonexistent leaf below a junction.  The corruption fail-toward-alerting behavior and the normal distinct-path outbox-hash proof still pass.  The detector/monitor component as a whole is therefore not yet acceptable.

### Re-review verification

| Command | Result |
| --- | --- |
| Fake-only Windows junction probe using `resolveMonitorStoragePaths(junction, actual\\monitor-alerts.jsonl)` | Reproduced bypass: `junction_refused=false`. |
| `npm run check` (from `canary/c0/monitor`) | Passed: `data-root.check OK`, `env.check OK`, `index.check OK`. |
| `npm run typecheck` (from `canary/c0/monitor`) | Passed with no diagnostics. |
| `npx --prefix canary/c0/agent tsx canary/c0/integration/cross-component.check.ts` | Passed: all eight contracts and `cross-component.check OK`. |

## Fix response

- **MAJOR — monitor state/outbox path aliasing:** startup now resolves the fixed `<dataRoot>/monitor-alerts.jsonl`, configured outbox path, and the outbox's atomic-rename target to filesystem identities (with Windows case folding), then refuses with the redacted `c0_monitor_state_outbox_path_collision` error before constructing either store if state equals or falls inside an outbox write target.
- **Coverage:** the monitor path check proves distinct paths operate normally; exact and case-only configured outbox aliases refuse without creating the state file; and a simulated outbox temporary rename target equal to the state path also refuses.  The existing monitor hash proof remains the normal-operation evidence that monitor ticks do not write the distinct outbox.

## Fix response 2

- **MAJOR — absent leaves below a junction:** the path guard now ensures the parent directory of the state file, outbox file, and outbox temporary rename target exists, then forms each identity from `realpathSync.native(parent)` plus its basename before Windows case folding.  Any parent canonicalization failure remains a redacted startup refusal, and identity collision is still rejected before constructing an outbox or alert-state writer.
- **Coverage:** an injected filesystem maps two distinct lexical parent directories to one canonical directory while both leaves remain absent; the guard refuses and the check confirms no state file was written.  The same injected seam proves distinct canonical parents stay valid.

## Re-review 2

VERDICT: ACCEPT

No BLOCKER, MAJOR, or MINOR defects found in the junction-safe canonicalization.

`normalizeMonitorStoragePath()` now creates and canonicalizes each candidate's parent with `realpathSync.native()`, then appends the leaf and applies Windows case folding ([data-root.ts](../../canary/c0/monitor/data-root.ts:24)).  `resolveMonitorStoragePaths()` compares those canonical identities for the state file, outbox, and atomic outbox temporary target before either store is constructed ([data-root.ts](../../canary/c0/monitor/data-root.ts:48)); parent canonicalization failure is a redacted refusal.  A real temporary Windows junction with both leaves absent, a real directory symlink, and an injected parent-resolution failure each refused without creating the target file; distinct canonical parents remain allowed.

The previous corruption fail-toward-alerting handling, normal distinct-path outbox hash proof, clean restart dedupe, and `human_reconciliation_required` reporting all remain covered by the passing monitor check.  The detector/monitor component as a whole is now acceptable.

### Re-review 2 verification

| Command | Result |
| --- | --- |
| Fake-only temporary Windows junction and directory-symlink probe | Both absent-leaf aliases refused; parent canonicalization failure also refused. |
| `npm run check` (from `canary/c0/monitor`) | Passed: `data-root.check OK`, `env.check OK`, `index.check OK`. |
| `npm run typecheck` (from `canary/c0/monitor`) | Passed with no diagnostics. |
| `npx --prefix canary/c0/agent tsx canary/c0/integration/cross-component.check.ts` | Passed: all eight contracts and `cross-component.check OK`. |
