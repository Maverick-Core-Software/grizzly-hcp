VERDICT: ACCEPT-WITH-FIXES

## Findings

### MAJOR — claim-time retry exhaustion lacks the fifth-attempt regression case

**File:** `src/agent/voice/outbox.check.ts:266-300`

The implementation correctly calls the shared `outboxRetryExhausted()` predicate from both requeue and `claimNext()`, and the check proves both requeue boundaries plus the claim-time 30-minute-window boundary.  It does not create a `pending` record with `attempts === C0_LIMITS.maxOutboxAttempts` and then call `claimNext()`: therefore a future change that accidentally applies only the window branch during claim-time reconciliation would still pass, despite allowing the fifth attempt to remain silently pending.  Add a separate fifth-attempt pending fixture that calls `claimNext()` and asserts `null`, `human_reconciliation_required`, and `nextAttemptAt === null`; this must share the restart assertion or add an equivalent reopen assertion.

## Controls rechecked

- **Failure/requeue exhaustion:** `Outbox.markStatus()` evaluates the merged pending record before its atomic rewrite and changes an exhausted fifth attempt or exact 30-minute-window record to `human_reconciliation_required` with `nextAttemptAt: null` (`outbox.ts:572-622`).  The current check covers both requeue boundaries and restart persistence of the fifth-attempt result.
- **Claim-time reconciliation:** `claimNext()` first transitions every exhausted pending record by calling `markStatus(..., 'human_reconciliation_required')`, then reloads before selecting a claimable row (`outbox.ts:630-651`).  The window-boundary claim fixture proves this path; the distinct fifth-attempt fixture is the remaining MAJOR coverage gap above.
- **Illegal transitions:** the transition table makes `human_reconciliation_required` terminal, and the check rejects reopening completed and reconciliation records, rejects an invalid status, unknown patch fields, and unknown records (`outbox.ts:444-455`, `outbox.check.ts:173-229`).
- **Mapping fail-closed behavior:** only a read error whose code is exactly `ENOENT` produces an empty mapping store.  Any other read error, malformed JSON, malformed bind/terminal event, duplicate conflict, or impossible terminal ordering returns `mapping_unavailable` before append; `bind`, `get`, and `markTerminal` each propagate that result (`c0-mapping.ts:143-177,209-245`).  The focused check covers malformed first/middle lines, `EACCES`, all three operations, and verifies no append on unavailable history.
- **Type narrowing:** the reviewed outbox/mapping sources and their checks pass the same strict compiler settings independently, with no target-file diagnostic and no observed runtime behavior change.  The full compiler is currently blocked by the explicitly out-of-scope concurrent `c0-controller.check.ts` edit, detailed below.
- **Safety boundary:** the reviewed sources remain local-only, contain no provider/HCP imports, and mapping failures fail closed rather than creating a pairing.

## Verification performed

- `Get-ChildItem -Path src\agent\voice -Filter *.check.ts -File | Sort-Object Name | ForEach-Object { npx tsx $_.FullName }` — started; `blocks.check.ts` and `c0-config.check.ts` passed, then `c0-controller.check.ts` failed at line 248 (`the key names its kind`).  This is the coordinator-noted concurrent, out-of-scope edit.
- Individual execution of the remaining checks — **PASS**: `blocks`, `c0-config`, `c0-entry`, `c0-limits`, `c0-mapping`, `outbox-monitor`, `outbox`, `transfer-adapter`, and `transport` all reported `*.check OK`; `c0-controller.check.ts` remains the single failed check noted above.
- `C:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsc.cmd --noEmit --strict --target ES2023 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --types node --typeRoots C:\Workspace\Active\grizzly-hcp\node_modules\@types <all src/agent/voice/*.ts files>` — **exit 2**, solely `src/agent/voice/c0-controller.check.ts:308` (`boolean` is not assignable to literal `true`), again in the declared concurrent out-of-scope file.
- The same strict compiler command limited to `outbox.ts`, `outbox.check.ts`, `c0-mapping.ts`, and `c0-mapping.check.ts` — **PASS** (exit 0).

## Fix response

- **MAJOR — claim-time fifth-attempt proof:** `outbox.check.ts` now proves that a four-attempt pending record is claimable, then injects the valid crash/restart shape of the fifth pending attempt and verifies `claimNext()` returns no record while atomically setting `human_reconciliation_required` and `nextAttemptAt: null`.  The existing claim-time retry-window test now also asserts its null next-attempt value.
- **Concurrent compiler fixture:** `c0-controller.check.ts` now preserves the literal `true` type for its valid service-intent fixture without changing the deliberately invalid `false` test inputs.
