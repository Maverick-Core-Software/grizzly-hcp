VERDICT: REJECT

## Findings

### BLOCKER — positive admission can survive a pre-model failure and authorize a silent hangup

**File:** `canary/c0/agent/src/worker.ts:110-120`

The worker writes `c0-admitted-<ParentCallSid>` and then performs several
fallible operations before constructing or starting a session: the answered
marker write, usage-file append, `GPTLiveModel`, `Agent`, and `AgentSession`
construction.  None of those operations is inside the later `try` block.  For
example, a filesystem permission/disk failure from
`deps.markers.mark('answered', gate.callSid)` escapes the entrypoint after the
admission document has been written.  The job disconnects the SIP leg with no
transfer flag, and `/dial-action` correctly treats the retained admission
document plus a completed Dial as successful and hangs up; the caller can hear
no agent audio and receive no human handoff.

**Fix:** Keep the binding order (admission before model construction), but wrap
the admission-to-session-start sequence in a failure handler that creates the
office transfer flag and ends the leg, using the parent redirect fallback if
Sync fails.  Ensure that every post-admission failure, including marker/usage
writes and model/agent/session construction, uses that handler.  Add injected
failure tests proving no positive admission alone reaches Dial-action success
when each step fails.

### BLOCKER — non-ASCII decimal digits still bypass service-intent PII filtering

**File:** `src/agent/voice/c0-controller.ts:339-345`

The NFKC normalization handles fullwidth digits but does not convert Arabic-
Indic or Devanagari decimal digits to ASCII, while JavaScript `\d` matches only
ASCII digits.  A read-only fake-outbox probe confirmed that both
`٤١١١-١١١١-١١١١-١١١١` and `४१११-११११-११११-११११` were accepted and enqueued as
`scope`; the same `validIntentText` function protects all four free-text
fields.  This persists a caller-supplied phone/card-like value outside the sole
permitted `callbackE164` field.

**Fix:** Reject non-ASCII Unicode decimal digits in free text or normalize all
Unicode decimal digits to ASCII before applying the existing chain/count
policy.  Extend `c0-controller.check.ts` for Arabic-Indic and Devanagari
fixtures in name, service address, scope, and preferred windows, asserting
`service_intent_invalid` and zero outbox writes.

### MAJOR — a CallSid received during the bounded attribute wait is discarded for the refusal transfer decision

**Files:** `canary/c0/agent/src/worker.ts:72-84`; `canary/c0/agent/src/gate.ts:37-45`

`knownSid`/`knownValidSid` is captured before `waitForCallSid`.  If the
participant initially lacks `c0.callSid`, the attribute arrives during the
three-second wait, and the re-evaluated gate then refuses because
`VOICE_C0_ENABLED` is false, `gate.callSid` is valid but `knownValidSid` remains
false.  The worker therefore takes the end-leg-only branch instead of writing
the required office transfer flag for a refusal with a valid parent CallSid.
The Function's positive-admission rule keeps this path fail-safe to fallback,
but it does not satisfy the required direct office-transfer path or its
observability contract; `worker-gates.check.ts` only calls the routing helper
with a pre-supplied SID and cannot exercise this delayed-attribute sequence.

**Fix:** Derive the refusal SID after the wait from the re-evaluated gate result
or the current participant attributes, validate it once, then route any valid
value through `transferWithSync`.  Add an integration-style gate test for
missing-at-first, valid-after-change, disabled-at-recheck, asserting the office
transfer document, AI-leg end, and zero model/session construction.

## Verified remediations and controls

- `RealC0Bridge` now receives the parsed canary map (`config.c0Env`) rather
  than `process.env`; config poison detection rejects inherited
  `VOICE_C0_*` and `VOICE_OUTBOX_*` values absent from or different from the
  parsed file, including the poisoned `VOICE_OUTBOX_PATH` fixture.
- The Functions admission contract is correctly named and ordered:
  `c0-transfer-<ParentCallSid>` retains precedence, and a completed Dial with
  no `c0-admitted-<ParentCallSid>` falls back rather than hanging up.
- The earlier en-dash, non-breaking-hyphen/space, narrow-NBSP, fullwidth-digit,
  punctuation, and word-delimited ASCII cases are rejected in all four
  controller free-text fields.  Short house-number/ZIP service-address input
  remained accepted in an independent fake-outbox probe; newline/tab-separated
  ASCII digits and 3-3-4 digit-word-digit groups were rejected.
- The installed Agents 1.9.0 first-audio mechanism remains downstream of its
  first published audio frame; the two-tool constraint, explicit GPT-Live
  configuration, silence/deadline transfer handling, rehearsal silent-start
  gate, and canonical data root remain unchanged and covered by the agent
  checks/integration harness.

## Verification

## Fix response

- **Post-admission failures:** the worker now wraps admission through the first
  successful `session.start`; any failure clears the admitted Sync document
  best-effort and uses the existing Sync-first office transfer/Calls redirect
  fallback path before the AI leg ends.
- **Unicode digits:** `c0-controller.check.ts` now covers Arabic-Indic,
  Extended Arabic-Indic, Devanagari, Bengali, and fullwidth digit sequences in
  all four free-text fields; validation uses Unicode decimal-digit matching.
- **Delayed CallSid:** `worker.check.ts` now exercises a CallSid arriving in
  the bounded wait followed by a disabled re-check and proves office routing.
- **Post-admission recovery fixtures:** `worker.check.ts` injects failures at
  answered-marker write, usage append, GPTLiveModel construction, Agent
  construction, AgentSession construction, and `session.start`; each proves a
  best-effort admitted-document deletion, Sync-first office flag, and AI-leg
  end.  A separate injected Sync-flag failure fixture proves the parent
  fallback redirect.

| Command | Result |
| --- | --- |
| `npm run check` from `canary/c0/agent` | Passed: all ten colocated checks, including `worker-gates.check OK`. |
| `npm run typecheck` from `canary/c0/agent` | Passed. |
| `Get-ChildItem src/agent/voice -Filter '*.check.ts' \| % { npx tsx $_ }` | All checks passed on the final tree. The first sweep observed a concurrent transient exact-source-inventory assertion in `c0-config.check.ts`; the affected check was rerun after the tree changed and passed, while every other core check passed in the initial sweep. |
| Strict primary compiler `tsc --noEmit --strict ... <all non-check src/agent/voice/*.ts>` | Passed. |
| `npx --prefix canary/c0/agent tsx canary/c0/integration/cross-component.check.ts` | Passed: all eight contracts and `cross-component.check OK`. |
| Additional fake-outbox probes | Arabic-Indic and Devanagari digit strings incorrectly enqueued; short house-number/ZIP accepted; newline/tab and ASCII word-delimited chains rejected. |
