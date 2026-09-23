# C0 wiring fixes review — 2026-09-22

VERDICT: ACCEPT-WITH-FIXES

Scope reviewed: `git diff 4b3fe80 -- canary src` and the four requested untracked C0 wiring files. This was a read-only review of local code and installed SDK type definitions; no Twilio, LiveKit, or OpenAI account API was contacted, no process was started or stopped, and no real environment file was opened.

## Findings

### MAJOR — PID reuse can make `stop` kill an unrelated process

**Location:** `canary/c0/c0ctl.ps1:71-75`, used by `Stop-App` at `:169-185`.

**Failure scenario:** A stale or altered C0 PID file can point to a non-C0 process whose command line merely contains `canary/c0` (for example, a script argument or a different checkout path). `Test-CanaryProcess` treats that broad substring as ownership, and `Stop-App` then uses `Stop-Process -Force` or `taskkill /T /F` on the PID. That does not meet the required invariant that `c0ctl stop` can never kill a non-canary process.

**Fix:** Verify the exact owning command for each PID before termination: the supervisor must be the current worktree's `c0ctl.ps1` with the matching app and `-Supervisor`; the child must resolve to this worktree's matching `tsx` CLI plus its exact app entry and arguments. Treat any mismatch, unreadable command line, or missing identity data as stale metadata to preserve/remove only, never as a process to terminate. Add a test with a PID-record fixture whose command line contains `canary/c0` but is not an exact C0 command, and assert that no kill API is called.

### MAJOR — production guard can pass after a production route-method change

**Location:** `canary/c0/provision/snapshot-production-guard.ts:5-27`.

**Failure scenario:** The binding readiness plan requires snapshotting every `voice_*` and `sms_*` handler field, but the hash omits at least `voice_fallback_method`, `sms_fallback_method`, and `voice_caller_id_lookup`. If any omitted setting changes between the pre- and post-canary captures, its SHA-256 remains identical and the guard reports `comparison.pass:true`, despite a production voice/SMS routing change.

**Fix:** Add every relevant Twilio IncomingPhoneNumber voice/SMS field to `SNAPSHOT_FIELDS`, `ParentNumber`, and `snapshotFields` (at minimum the omitted fallback methods and caller-ID lookup). Extend `snapshot-production-guard.check.ts` with distinct before/after objects for each field and assert that every change produces a diff.

### MAJOR — `--compare` can open the protected C0 environment file

**Location:** `canary/c0/provision/snapshot-production-guard.ts:56-65`.

**Failure scenario:** The operator-only guard correctly receives parent credentials only from explicit process environment variables, but it accepts any `--compare` path and calls `readFile` on it. An operator typo or copied command such as `--compare canary/c0/.env.c0` opens the protected canary environment file, violating the no-`.env*` read boundary for this production guard.

**Fix:** Constrain `--compare` to a canonical, existing JSON evidence file below `canary/c0/provision/evidence` (with symlink/reparse-point-safe resolution), reject environment-like filenames and paths outside that directory before reading, and add a check proving `.env.c0` is rejected without invoking `readFile`.

### MINOR — enabled-state evidence still tells the operator to use PM2

**Location:** `canary/c0/provision/set-enabled.ts:11` (also documented at `canary/c0/provision/README.md:25` and asserted at `canary/c0/provision/set-enabled.check.ts:13`).

**Failure scenario:** An approved enabled-state change prints `restartCommand: 'pm2 restart c0-agent'`. On Windows PM2 has hard-coded pipes and the new runtime is specifically required never to invoke PM2; an operator following the emitted command can bypass `c0ctl`'s isolated lifecycle handling.

**Fix:** Replace the field with the scoped `pwsh -NoProfile -File canary/c0/c0ctl.ps1 restart agent` command (or remove the restart-command field and retain the runbook instruction), then update the README and check expectation. The launcher itself contains no PM2 invocation; this finding is the stale operational hint.

## Checks run

All commands exited 0.

- `git diff --check 4b3fe80 -- canary src`
- `Push-Location canary/c0/provision; npx tsc --noEmit; Get-ChildItem *.check.ts | Sort-Object Name | ForEach-Object { npx tsx $_.Name }; Pop-Location` — all nine provision checks passed, including the new production-guard check and LiveKit protobuf/bigint coverage.
- `Push-Location canary/c0/agent; npm run check; npx tsx src/main.check.ts; npm run typecheck; Pop-Location` — package checks, the new startup-order check, and TypeScript check passed.
- `pwsh -NoProfile -File canary/c0/c0ctl.check.ps1` and `powershell -NoProfile -File canary/c0/c0ctl.check.ps1` — both passed; the invoked launcher operations were dry-run only.
- `npx --prefix canary/c0/agent tsx canary/c0/integration/cross-component.check.ts` — passed with injected fakes only.
- `npx --prefix canary/c0/agent tsx canary/c0/integration/no-credential-literals.check.ts` — passed; the scanner uses Git enumeration and did not open ignored C0 environment files.

## Confirmed wiring points

The installed `livekit-server-sdk@2.19.1` declarations match the revised create/update payloads: protobuf `SIPInboundTrunkInfo` and `SIPDispatchRuleInfo` replacements, numeric create-time ringing timeout, and an explicit `trunkIds` create/update path. `reconcileSip` rejects an absent or blank trunk ID before dispatch-rule construction and validates the returned rule, so this review found no wildcard-dispatch defect. The production guard does not import or call `loadC0Env`; its parent credentials are sourced only from the two explicit `C0_OPERATOR_PARENT_*` process variables, subject to the `--compare` path issue above. `startCanaryAgent` initializes the logger before loading config or constructing `AgentServer`, and the new injection-based check verifies that order.

## Fix response

- **Exact PID ownership:** `c0ctl.ps1` now accepts a PID for termination only when its command line exactly describes the current worktree's matching supervisor invocation or matching Node/tsx child invocation. PID metadata for every other case, including unreadable and substring-only command lines, is preserved with a warning; fixture checks prove the current launch shapes remain accepted and unrelated commands are not killable.
- **Complete production snapshot:** the guard hashes the full requested voice, SMS, routing, callback, caller-ID, emergency, bundle, address, and identity field set. Its colocated check changes every individual field and requires a resulting difference.
- **Safe comparison evidence:** `--compare` rejects environment-like and non-JSON names before filesystem access, resolves both evidence root and candidate through `realpath`, rejects reparse-point escapes, and requires an existing regular JSON evidence file below the provision evidence root.
- **No PM2 recovery instruction:** enabled-state evidence and its documentation/check now emit the scoped `c0ctl.ps1 restart agent` command.

Post-fix verification passed: `npx tsc --noEmit` plus every provision `*.check.ts`; `pwsh -NoProfile -File canary/c0/c0ctl.check.ps1`; `powershell -NoProfile -File canary/c0/c0ctl.check.ps1`; `npx --prefix canary/c0/agent tsx canary/c0/integration/no-credential-literals.check.ts`; and `git diff --check`. The launcher checks run only `-DryRun` lifecycle paths and fixture identity matching; no live C0 process, environment file, or provider account was accessed.

### W6 live-regression response

The regex guard was replaced with a native `CommandLineToArgvW` tokenizer and exact token comparisons. It accepts the observed fully quoted live supervisor and child forms (and equivalent unquoted token forms), normalizes only separators for the full worktree paths, and preserves PID metadata for every executable, root, app, token-count, or argument mismatch. The launcher checks include those live-shape fixtures and near misses; `pwsh -NoProfile -File canary/c0/c0ctl.ps1 status all` then reported `agent`, `detector`, and `monitor` as `state=running` without any lifecycle action.

**W7 Fix response:** The snapshot now hashes Twilio's `emergency_address_sid` and the additionally identified `emergency_address_status`, with a per-field change-detection assertion for both.

## Re-review (W5/W6)

VERDICT: ACCEPT-WITH-FIXES

Independent read-only re-review of the W5/W6 responses. No C0 process was started, stopped, or restarted; the only live invocation was the permitted `status all`, which reported `agent`, `detector`, and `monitor` as running. No `.env*` file or provider account API was read or contacted.

### MAJOR — production guard omits Twilio `emergency_address_sid`

**Location:** `canary/c0/provision/snapshot-production-guard.ts:11,22,44-47`.

**Failure scenario:** The installed Twilio SDK exposes `emergencyAddressSid` on each `IncomingPhoneNumber`, but the guard's `ParentNumber`, `SNAPSHOT_FIELDS`, and `snapshotFields` omit it. If a parent-account number's emergency address is changed between the before and after captures while every included field remains unchanged, both `fields_sha256` values are equal and step 15 reports `comparison.pass:true`; an injected-fake reproduction changing only `emergencyAddressSid` produced no diff. This contradicts the asserted complete emergency/address field coverage and leaves a production configuration change undetected.

**Fix:** Add `emergency_address_sid` / `emergencyAddressSid` to the snapshot type, ordered field list, and serialized field record; extend `snapshot-production-guard.check.ts` so an `emergencyAddressSid`-only before/after pair must produce one change. Consider whether the read-only `emergencyAddressStatus` also belongs in the intended production-invariance baseline, and make that scope explicit.

## Re-review confirmations

- **W6 exact-command guard:** `c0ctl.ps1` uses native `CommandLineToArgvW` (`:71-103`), so Windows quoting and backslash-before-quote tokenization is delegated to the platform parser. The supervisor and child matchers require exact token counts and arguments, use case-insensitive normalized worktree paths, and preserve unreadable, substring-only, other-worktree, extra-token, wrong-app, and wrong-executable near misses; both PowerShell-hosted checks passed.
- **W5 compare confinement:** `resolveCompareEvidencePath` rejects environment-like and non-JSON names before filesystem resolution, resolves both root and candidate with `realpath`, rejects outside/reparse-point targets, and requires a regular evidence file before `readSnapshot`. The colocated checks cover early `.env` rejection, non-JSON rejection, a contained canonical file, and an escaped linked target.
- **Restart hint:** `set-enabled.ts`, its check, and the provision README now use the scoped `c0ctl.ps1 restart agent` hint. A scoped source scan found no remaining `pm2 restart` hint in C0 runtime/provision sources (excluding environment files and installed dependencies).

## Commands and results

All listed commands exited 0 unless noted as the intentional reproducer result.

- `pwsh -NoProfile -File canary/c0/c0ctl.ps1 status all` — `agent`, `detector`, and `monitor` reported `state=running`; no lifecycle action.
- `pwsh -NoProfile -File canary/c0/c0ctl.check.ps1` — passed.
- `powershell -NoProfile -File canary/c0/c0ctl.check.ps1` — passed.
- `Push-Location canary/c0/provision; npx tsc --noEmit; Get-ChildItem *.check.ts | Sort-Object Name | ForEach-Object { npx tsx $_.Name }; Pop-Location` — TypeScript clean and all nine provision checks passed.
- `npx --prefix canary/c0/agent tsx canary/c0/integration/no-credential-literals.check.ts` — passed.
- Injected-fake `snapshotProductionGuard` comparison changing only `emergencyAddressSid` — reproduced the finding: no diff was detected.
- `git diff --check` — passed.
