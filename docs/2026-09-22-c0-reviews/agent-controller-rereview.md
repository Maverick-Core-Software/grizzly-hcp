VERDICT: REJECT

## Findings

### BLOCKER — pre-session gate refusals do not positively route the parent call to a human

**Files:** `canary/c0/agent/src/worker.ts:64-71`; `canary/c0/agent/src/worker.ts:75-89`

For every failed SIP/trunk/rule/call-SID/enabled gate, the worker invokes only
`ctx.shutdown('c0_gate_refused')`.  It neither creates the `c0-transfer-<parent>`
Sync document nor redirects the parent call.  This is not an equivalent transfer
path: in installed Agents 1.9.0, `JobContext.shutdown()` merely invokes the job
shutdown callback (`node_modules/@livekit/agents/src/job.ts:552-553`), and the
job runner subsequently disconnects the LiveKit room
(`src/ipc/job_proc_lazy_main.ts:204-205`).  Thus Twilio receives an ordinary
ended SIP Dial with no transfer flag.  In the present Dial action, an otherwise
`completed` Dial that satisfies `isAnswered(event)` is explicitly hung up
instead of sent to fallback (`canary/c0/twilio-functions/functions/dial-action.protected.js:18-23`);
an agent that accepted the SIP leg and immediately rejects a disabled or bad
admission can therefore end the customer call without a human handoff.

**Fix:** Make gate refusal an explicit fail-closed routing path.  When a valid
parent SID is available, create the office Sync transfer flag before ending the
AI leg and redirect the parent on Sync failure.  For refusals where that trusted
parent correlation is absent, the Dial action needs a positive canary-admitted
criterion (written only after all gates) and must fall back whenever it is
absent; a SIP disconnect alone must not be interpreted as successful answered
canary service.  Add worker/fake tests for each gate refusal, including disabled
with a valid parent SID and missing/malformed SID, asserting the appropriate
flag/redirect or fallback outcome and no model/session creation.

### BLOCKER — the real bridge still consumes inherited `VOICE_C0_*` configuration and can write outside the canary-selected outbox

**Files:** `canary/c0/agent/src/worker.ts:35-44`; `canary/c0/agent/src/bridge.ts:38-46`

Although `loadCanaryRuntimeConfig` parses the fixed canary file, the default
worker dependencies construct `RealC0Bridge(process.env, ...)`.  The bridge
then calls `loadC0Config(env)`, which reads inherited `VOICE_C0_ENABLED`,
`VOICE_C0_ALLOWLIST`, `VOICE_C0_MAPPING_PATH`, and `VOICE_OUTBOX_PATH` values.
In particular, `VOICE_OUTBOX_PATH` is optional in `.env.c0`, so an inherited
value with no same-named parsed value is not rejected by the conflict loop and
becomes the outbox target.  A service manager environment can therefore steer
durable canary intake writes to a non-canary (including production) path,
contrary to the required dotenv-only configuration boundary.

**Fix:** Remove the `process.env` default from `RealC0Bridge`; pass an explicit
controller configuration derived solely from the parsed `.env.c0` map (including
the selected outbox path) into the bridge.  Treat every inherited supported C0
key as poison unless it exactly corresponds to a parsed, approved value, and
add a startup/bridge check with a poisoned inherited `VOICE_OUTBOX_PATH` while
the canary file omits that optional key, proving that no inherited value is used.

### BLOCKER — sensitive phone/card-like digits in free text bypass the new validator

**File:** `src/agent/voice/c0-controller.ts:335-356`

`validIntentText` only treats ASCII hyphen and slash as separators in its
10–19-digit-chain expression.  An adversarial read-only controller probe showed
that all of `4111–1111–1111–1111` (en dashes),
`4111‑1111‑1111‑1111` (non-breaking hyphens), and a digit sequence separated
by words were accepted and enqueued as `scope`; the same validator is applied
to `name`, `serviceAddress`, and `preferredWindows`.  These values can therefore
be persisted in the service-intent payload despite the controller requirement
that `callbackE164` be the sole phone-shaped field.

**Fix:** Canonicalize Unicode compatibility characters and separator forms
before sensitive-number detection, and reject digit chains separated by
non-digit prose as well as formatting punctuation (or use a conservative
normalization-plus-digit-count rule).  Extend `c0-controller.check.ts` across
all four free-text fields with en dash, non-breaking hyphen, non-breaking space,
and digit-word-digit adversarial fixtures, each expecting
`service_intent_invalid` and no outbox append.

## Verified remediations

- `src/main.ts` constructs `AgentServer` with explicit canary LiveKit URL/key/
  secret and agent name `grizzly-c0-canary`; `GPTLiveModel` uses `gpt-live-1`,
  `delegation: 'responses'`, and the explicitly parsed canary OpenAI key.
- Installed `@livekit/agents` is 1.9.0.  Its `agent_activity.ts:3197-3204`
  enters `speaking` from the first-frame callback, and that callback is attached
  only after `audioOut.firstFrameFut` resolves (`3253-3256`), so the replacement
  `AgentStateChanged` first-audio hook is correctly downstream of publisher
  playback rather than the former `SpeechCreated` anti-pattern.
- The worker uses exactly the two named tools, shares the bridge's per-call
  monotonic sequence map across them, invokes transfer even if durable transfer
  intent recording fails, applies the 15-second away check-in then office
  transfer, and uses the eight-minute deadline.  Agent and detector both enforce
  the same absolute-or-`<repo>/data/c0` root rule.
- The controller's delivery digest now omits kind and is derived from
  `(CallSid, intentSequence, payloadVersion)`, so a kind change cannot bypass a
  duplicate after restart.

## Verification

## Fix response

- **Positive admission and gate routing:** `worker.ts` now writes
  `c0-admitted-<ParentCallSid>` only after caller, mapping, and capacity gates
  pass and before model/session construction. A valid known parent SID on any
  refusal uses the Sync-first office transfer path, while an unknown or
  malformed SID ends the AI leg without admission so the Function fallback
  contract applies; admission-document write failure is likewise transferred.
  `worker-gates.check.ts` covers disabled, trunk, rule, missing/malformed SID,
  allowlist/fetch, mapping, capacity, and admission-write refusal outcomes with
  zero model/session construction; `transfer.check.ts` covers Sync failure
  falling back to the parent Calls redirect.
- **Bridge configuration:** `RealC0Bridge` receives the parsed canary map
  explicitly and no longer defaults to `process.env`; the agent config rejects
  every inherited `VOICE_C0_*` or `VOICE_OUTBOX_*` value that is absent from or
  differs from the parsed file.
- **Unicode digit boundary:** controller text validation NFKC-normalizes and
  canonicalizes Unicode separator forms, rejects a seven-digit punctuation
  chain and rejects ten total digits, with fixtures for all four free-text
  fields including en dash, non-breaking hyphen/space, narrow NBSP, fullwidth
  digits, and word-delimited digit groups.

- `cd canary/c0/agent && npm run check` — passed: all nine colocated checks
  reported `OK`.
- `cd canary/c0/agent && npm run typecheck` — passed (`tsc --noEmit`).
- `Get-ChildItem src/agent/voice -Filter '*.check.ts' | % { npx tsx $_ }` —
  passed: all ten core checks reported `OK`.
- `C:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsc.cmd --noEmit --strict --target ES2023 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --types node --typeRoots C:\Workspace\Active\grizzly-hcp\node_modules\@types <all non-check src/agent/voice/*.ts>` — passed.
- Adversarial controller probe (in-memory fake outbox) — confirmed the three
  Unicode/word-delimited digit inputs above each returned `enqueued` before the
  recommended fix.
