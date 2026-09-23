VERDICT: REJECT

## Findings

### BLOCKER — Free-text validation persists formatted card numbers and phone numbers outside `callbackE164`

**File:** `src/agent/voice/c0-controller.ts:335-354`

`validIntentText()` only rejects an uninterrupted 13–19 digit run, and its optional phone check only rejects an uninterrupted 10–15 digit run. Consequently, a confirmed service intent whose `scope`, `preferredWindows`, `name`, or `serviceAddress` contains a formatted card value (for example, four digit groups separated by spaces) or a formatted E.164 value is accepted and written unredacted to the durable outbox; `callbackE164` is therefore not the only phone-shaped field. This violates the stated capture boundary even though the outward snapshot later masks the top-level name/address fields. Replace the bare-run tests with canonicalized digit detection that rejects card-shaped values regardless of ordinary separators and rejects phone-shaped values in every free-text field; retain the dedicated E.164 parser exclusively for `callbackE164`, and add adversarial fixtures for formatted cards and formatted E.164 values in every text field.

### MAJOR — Delivery idempotency is not the required `CallSid + intentSequence + payloadVersion` identity

**File:** `src/agent/voice/c0-controller.ts:373-386`

The digest includes `kind` in addition to the required tuple. If an already-confirmed sequence is replayed after a reconnect or schema/classification change with a different delivery kind, the same CallSid, sequence, and payload version produce a new key and a second durable record instead of being treated as a duplicate. Derive the key solely from the parent CallSid, confirmed intent sequence, and payload version as specified in readiness plan P2/§7, and add a restart fixture proving that a changed kind cannot bypass that identity.

### MAJOR — Retry exhaustion leaves records pending instead of entering human reconciliation

**File:** `src/agent/voice/outbox.ts:620-632`

After the fifth failed claim, or after the 30-minute retry window, `claimNext()` merely stops selecting the pending record through `outboxRetryExhausted()`; it never transitions it to `human_reconciliation_required`. An exhausted record consequently remains `pending` with no eligible retry and is indistinguishable from a normal queued delivery in operational status counts, contrary to D6's explicit “then `human_reconciliation_required`” requirement. On failure/requeue and before skipping an exhausted record, atomically transition it to `human_reconciliation_required` with `nextAttemptAt: null`, and add boundary checks for both the fifth attempt and the retry-window limit.

### MAJOR — A corrupted or unreadable mapping log is treated as an empty mapping store

**File:** `src/agent/voice/c0-mapping.ts:175-193`

`read()` converts every file-read error to a new empty map and silently skips every malformed event. A partially written/corrupt first bind, or an unreadable existing log followed by a writable append, lets `bind()` treat an unknown existing parent CallSid as unbound and create a new pairing rather than failing closed; that defeats the required conflict/missing-mapping safety gate. Treat only a confirmed absent file as an empty store, surface unreadable or malformed event logs as a closed mapping failure, and ensure `bind()`, `get()`, and terminal updates cannot accept or create a mapping until the durable history is valid.

## Confirmed controls

- `enqueueServiceIntent()` and `enqueueTransferRequest()` settle the disabled/allowlist gate before examining request content, require a literal `callerConfirmed: true` for service intents, enforce bounded fields, and validate the dedicated parent CallSid shape.
- The snapshot and stale-monitor report paths omit raw service payload/error fields; the full C0 isolation scan in `c0-config.check.ts` enumerates the new limits and mapping sources and passed.
- Current wording contains the required new keys and no shipped phrase claiming a request is booked or an appointment confirmed.

## Verification

- `Get-ChildItem -Path src\agent\voice -Filter *.check.ts -File | Sort-Object Name | ForEach-Object { npx tsx $_.FullName }` (executed with exit handling) — exit 0: `blocks`, `c0-config`, `c0-controller`, `c0-entry`, `c0-limits`, `c0-mapping`, `outbox-monitor`, `outbox`, `transfer-adapter`, and `transport` all reported `*.check OK`.
- `C:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsc.cmd --noEmit --strict --target ES2023 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --types node --typeRoots C:\Workspace\Active\grizzly-hcp\node_modules\@types <all 20 src/agent/voice/*.ts files>` — exit 1, currently only `c0-controller.ts:307` (`string` not assignable to `OutboxKind`) and `c0-controller.ts:558` (`C0ServiceIntent` lacks the `Record<string, unknown>` index signature); this is the noted concurrent type-only area and is not counted as a behavioral finding above.

## Fix response

- **Formatted sensitive free text:** controller validation now rejects 10–19 digit chains joined by spaces, dashes, dots, parentheses, or slashes in every service field; `c0-controller.check.ts` exercises cards and telephone formats in each field.
- **Delivery identity:** the idempotency digest is now the parent CallSid, confirmed sequence, and payload version only, so a changed kind cannot create a second durable delivery; `c0-controller.check.ts` asserts same-tuple equality.

- **Retry exhaustion:** `Outbox.markStatus()` now converts an exhausted failure/requeue to `human_reconciliation_required` with no next attempt, and `claimNext()` atomically converts any expired pending records before considering a delivery. The focused check covers the fifth-attempt boundary, the exact retry-window boundary, automatic claim-time reconciliation, and restart persistence.
- **Mapping availability:** only `ENOENT` now initializes an empty mapping history. Malformed first or middle lines and injected non-ENOENT read failures return `{ ok: false, reason: 'mapping_unavailable' }` from bind, lookup, and terminal updates without appending a pairing; the focused check covers each case.
- **Post-fix verification:** all ten `src/agent/voice/*.check.ts` scripts, `canary/c0/agent` and `canary/c0/monitor` `npm run check`, the agent `npm run typecheck`, and the strict primary-compiler C0 source check now exit 0.
