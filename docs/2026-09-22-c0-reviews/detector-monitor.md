VERDICT: REJECT

## Findings

### MAJOR — a future answered-marker timestamp defeats the six-second first-audio fallback

**Files:** `canary/c0/detector/src/policy.ts:20-31`, `canary/c0/detector/src/detector.ts:148-156`

The detector uses the agent-created answered marker's filesystem mtime as the deadline origin, but a marker timestamp ahead of the detector clock returns `false` from `firstAudioOverdue` until that future time plus six seconds. The focused read-only reproduction `firstAudioOverdue({ answeredAtMs: 20000, firstAudioAtMs: null, nowMs: 10000 }, 6000)` printed `false`; a clock jump/skew or future mtime can therefore leave an answered caller without first audio well beyond the promised six seconds (up to the Twilio/LiveKit maximum duration). Clamp a future answered mtime to the detector's current time (or otherwise fail closed at the current tick), retain the one-redirect marker behavior, and add a future-mtime test.

### MAJOR — the runtime monitor never reports records requiring human reconciliation

**Files:** `canary/c0/monitor/index.ts:54-78`, `src/agent/voice/outbox-monitor.ts:64-66,158-190`

`human_reconciliation_required` exists in the canonical status set, but the monitor runtime calls only `findStale`, whose eligible/repeatable sets exclude that terminal status; it neither emits a count nor sends a redacted operator signal for it. Thus a record that has exhausted its retries can require human intervention with no monitor-visible outcome, contrary to the C0 outbox/reconciliation safety contract. Have the runtime consume the redacted `analyzeOutboxHealth` status counts (or an equally read-only projection) and emit a redacted, once-per-crossing reconciliation-required signal without mutating or retrying the outbox.

### MAJOR — the canonical C0 environment set omits the required canary-number SID

**Files:** `canary/c0/provision/lib.ts:54-60`, `canary/c0/provision/twilio-number-route.ts:26-29`, `canary/c0/detector/src/env-example.check.ts:8-20`

Number routing requires `VOICE_C0_CANARY_NUMBER_SID`, yet the provisioning canonical list and the executable names-only template check omit it. Consequently the enable preflight/template can pass while GO-LIVE number routing fails before either the humans-first fallback or ingress route can be written. Add the name to the canonical list, the names-only template, and its exact-order check; make the appropriate preflight stage require and validate it.

### MINOR — a monitor restart can re-alert the same unchanged stale crossing

**File:** `canary/c0/monitor/index.ts:36-76`

The dedupe set is process-local and has no durable input state, so a PM2 restart clears it and the next tick sends another ntfy alert for the same unchanged stale record/tier. This violates the stated once-per-crossing operator experience and is especially likely because the PM2 definition enables autorestart. Preserve an immutable, redacted crossing identity in an approved non-outbox state store or define/implement a restart-safe bounded alert policy; do not write the outbox.

## Controls verified

- The detector is an outbound-only process: it starts no listener, filters the configured subaccount client's calls by `status: 'in-progress'` and `to: VOICE_C0_CANARY_DID`, and uses only Calls list/update, Sync documents, local markers, and redacted ntfy. Twilio documents both the `To`/status list filters and the `<Dial>` parent/child relationship; the child SIP leg is dialed to a SIP URI while the parent remains addressed to the canary DID. [Twilio Call resource](https://www.twilio.com/docs/voice/api/call-resource), [Twilio `<Dial>`](https://www.twilio.com/docs/voice/twiml/dial)
- Parent correlation is correct: ingress supplies `X-C0-Call`, the agent gates and writes `answered`/`first-audio` under `c0.callSid`, and the detector's `To=canary DID` list returns the parent leg key it uses for those markers. No answered marker intentionally causes no detector action; Twilio `<Dial timeout>`/action owns the never-started-agent path.
- Overdue answered calls persist an exclusive `redirected/<parent CallSid>` marker before one best-effort Sync transfer flag and one parent `Calls(...).update({url: fallback?role=office})`; the marker survives a detector restart, and Sync failure still permits the human redirect. The redacted detector ntfy body contains no caller details.
- Detector and agent share the same data-root contract: an absolute `VOICE_C0_DATA_DIR`, otherwise a repository-root-asserted `<repo>/data/c0`; both assert the `src/agent/voice` repository anchor. The agent `src/main.ts` now exists, so all three PM2 entries exist; the PM2 file uses only `c0-*` names, repository cwd, no secrets/env file, five restart attempts, and a 10-second minimum uptime.
- The detector's existing template check passed, which proves the reviewed `.env.c0.example` is names-only and exactly matches its current canonical order without this review directly opening an environment file; `.gitignore` includes `.env.c0`.
- The monitor's alert body is structurally redacted and its existing hash check proves it does not mutate the outbox; its configured topic derives only from `VOICE_C0_NTFY_TOPIC`.

## Verification performed

- `npm run check` and `npm run typecheck` in `canary/c0/detector` — **PASS** (`policy`, `data-root`, `detector`, and `env-example` checks passed; TypeScript clean).
- `npm run check` and `npm run typecheck` in `canary/c0/monitor` — **PASS** (`data-root` and `index` checks passed; TypeScript clean).
- `node canary/c0/ecosystem.c0.config.check.cjs` from the worktree root — **PASS**.
- Focused read-only policy probe for a future answered mtime — returned `false`, establishing the first finding. No `.env*` file was opened directly and no provider/account request was made.

## Fix response

All three MAJOR findings and the restart-deduplication MINOR are resolved. The detector now clamps a future answered-marker mtime when it is first observed and retains that clamped time for the active call, so subsequent ticks advance the six-second deadline instead of repeatedly resetting it; the focused fake reproduces a future marker, advances the injected clock by six seconds, and proves exactly one fallback redirect. `VOICE_C0_CANARY_NUMBER_SID` is now part of the canonical provisioning list, validates as a mixed-case-safe `PN` SID, is required for functions/enable preflight, and appears in the template's tested canonical order.

The monitor now consumes `analyzeOutboxHealth(...).counts.human_reconciliation_required`, sends one redacted ntfy signal only when that count crosses from zero to non-zero, and still never writes the outbox. It persists only `{id, tier}` crossing identities in an atomically replaced `<dataRoot>/monitor-alerts.jsonl` state file, reloads them at startup, clears inactive crossings so a later real crossing can re-alert, and keeps the reconciliation signal as a count-level crossing identity; the state contains no payload, caller number, CallSid, or error text. The expanded monitor check proves reconciliation edge alerting, unchanged-count silence, restart dedupe, redaction, and unchanged outbox hash.

Reverification after the fixes: `cd canary/c0/detector && npm run check && npm run typecheck` — **PASS** (`policy`, `data-root`, `detector`, `env`, `env-example`; TypeScript clean); `cd canary/c0/monitor && npm run check && npm run typecheck` — **PASS** (`data-root`, `env`, `index`; TypeScript clean). No provider request was made.
