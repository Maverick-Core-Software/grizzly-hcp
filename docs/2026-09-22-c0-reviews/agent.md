VERDICT: REJECT

Scope: read-only review of `canary/c0/agent/**`, with the runtime integration points inspected only where the reviewed worker depends on them. No account API, credential file, or live service was accessed.

## Findings

### BLOCKER — detector markers are written and read from different roots

- **Evidence:** `canary/c0/agent/src/worker.ts:19` resolves markers from the agent process's `cwd`; the C0 process definition sets each app's `cwd` to its own package at `canary/c0/ecosystem.c0.config.cjs:9`; the detector independently resolves its marker root from its own `cwd` at `canary/c0/detector/src/detector.ts:171-177`.
- **Failure scenario:** the agent writes `canary/c0/agent/data/c0/answered/<CallSid>` and `first-audio/<CallSid>`, while the detector polls `canary/c0/detector/data/c0/...`. The detector deliberately skips any call without an answered marker, so it never applies the six-second redirect if the agent produces no audible response. Once the SIP leg has answered, the existing completed-with-duration dial path can hang up at the eight-minute limit rather than route the caller to a person.
- **Fix:** make the marker root one explicit, absolute C0-only configuration value shared by both processes (or replace files with a single injected marker service). Add an integration check that runs the two process configurations and proves the detector observes the agent's marker without relying on `cwd`.

### BLOCKER — `SpeechCreated` is not evidence that the caller received first audio

- **Evidence:** `canary/c0/agent/src/worker.ts:57` writes the `first-audio` marker on `AgentSessionEventTypes.SpeechCreated`. In the installed Agents 1.9.0 source, `SpeechCreatedEvent` describes the timestamp when a speech *handle is created*, and the event is emitted immediately after `SpeechHandle.create`, before playback or a published audio frame (`canary/c0/agent/node_modules/@livekit/agents/src/voice/events.ts:243-279` and `agent_activity.ts:1595-1606`, `1791-1802`).
- **Failure scenario:** `session.generateReply()` can create a handle while GPT-Live connection, generation, synthesis, track publication, or media delivery subsequently stalls. The marker suppresses the detector's first-audio redirect even though the caller hears silence.
- **Fix:** emit the marker only from the audio-output path after the first frame is actually handed to the LiveKit audio publisher (or an API event explicitly documented to mean that). Add a regression fixture that creates a speech handle but never publishes a frame and asserts no marker is written; only a first published frame may close the detector deadline.

### MAJOR — the intentionally fail-closed bridge refuses both canary actions, including human transfer

- **Evidence:** `canary/c0/agent/src/bridge.ts:69` and `:79` pass `callerE164: null` to the C0 controller. The controller's validated gate rejects a missing caller before either intent can be queued (`src/agent/voice/c0-config.ts:237-248` and `c0-controller.ts:537-545`, `562-567`); additionally, `bridge.ts:7-14` names the service field `callbackNumber` while the controller requires the exact `callbackE164` field (`c0-controller.ts:343-350`). `tools.ts:36-39` returns `refused` without calling the transfer adapter whenever that bridge refusal occurs.
- **Failure scenario:** a caller who asks for a person causes `request_transfer` to return a refusal and never invokes the restricted Calls update. A confirmed service request is likewise never recorded. This is conservative for data and external calls, but it is not caller-safe for the required "person at any time" path: the live conversation remains connected without a human fallback.
- **Fix:** keep the bridge inert until the approved rewire, but make that state caller-safe: on any bridge refusal, immediately redirect the valid parent CallSid to `/fallback` (or close the SIP leg so Twilio's Dial action does so). The rewire must carry the allowlisted caller identity into the controller and map the validated callback field to `callbackE164`; add checks proving both the refusal fallback and accepted transfer path.

### MAJOR — configured C0 agent process targets a nonexistent entry file

- **Evidence:** the worker's executable bootstrap is in `canary/c0/agent/src/worker.ts:95-98`, and the agent package contains no `src/index.ts`; the C0 PM2 configuration launches `src/index.ts` at `canary/c0/ecosystem.c0.config.cjs:12-13`.
- **Failure scenario:** a normal PM2 start/restart cannot load the requested entry file, leaving no registered agent. Twilio's Dial timeout should route the caller to the fallback, but the C0 worker can never provide the intended service.
- **Fix:** point the C0 agent app at `src/worker.ts`, or add and test the missing `src/index.ts` bootstrap. Include a non-live process-start smoke check that proves the configured path resolves.

### MAJOR — the package's required TypeScript check is currently failing through its bridge dependency

- **Evidence:** `npm run typecheck` exits 1. The observed diagnostics are `src/agent/voice/c0-controller.ts:307` (`string` not assignable to `OutboxKind`) and `:558` (`C0ServiceIntent` not assignable to `Record<string, unknown>`); they are reachable because the reviewed bridge imports the controller at `canary/c0/agent/src/bridge.ts:2-4`.
- **Failure scenario:** the worker package cannot pass its own release type gate, so a compatible, reproducible agent build is not established even though its small unit checks execute.
- **Fix:** correct the C0 controller type defects in their owning task, then re-run this package's typecheck before accepting the agent. Do not suppress the diagnostics or weaken this package's typecheck.

## Confirmed controls

- `package.json:14-15` pins the requested Agents and OpenAI plugin versions to `1.9.0`.
- `worker.ts:51-54` constructs `GPTLiveModel` with `model: 'gpt-live-1'`, `delegation: 'responses'`, and an explicit C0 API key; its two tools are exactly `record_service_request` and `request_transfer` (`tools.ts:20-42`). This matches the LiveKit GPT-Live guide's `responses` delegation behavior and avoids provider tools.
- The SIP/trunk/rule/CallSid/enabled checks execute before model/session construction (`worker.ts:35-54`), and the worker waits briefly for the asynchronous CallSid attribute. `ServerOptions` receives the explicit C0 LiveKit URL/key/secret and explicit agent name (`worker.ts:85-92`).
- Runtime configuration loads only `canary/c0/.env.c0` with `override: false` and requires only `VOICE_C0_*` credential names (`config.ts:1-41`); session recording is disabled (`worker.ts:65`) and this reviewed worker contains no transcript or phone logging call.

## Vendor API review

The GPT-Live constructor and `responses` delegation are valid for the pinned plugin. LiveKit documents that the default `responses` delegation performs tool work in the backend Responses model while framework function tools run in the agent process; `client` delegation has no tool channel ([OpenAI GPT-Live plugin guide](https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/)). The explicit `ServerOptions` fields and `agentName` are supported by the Agents JS API ([ServerOptions reference](https://docs.livekit.io/reference/agents-js/classes/agents.ServerOptions.html)).

The failure is not an option-name problem: it is the local safety wiring around detector markers and the deliberately incomplete bridge. In particular, the public event name `speech_created` does not establish media delivery; the installed 1.9.0 source confirms it is emitted on speech-handle creation, so it cannot be used as the first-audible-response proof.

## Checks run

| Command | Result |
| --- | --- |
| `npm run check` | Exit 0: `worker.check OK`, `tools.check OK`, `transfer.check OK`, `config.check OK`. |
| `npm run typecheck` | Exit 1: two diagnostics in the imported C0 controller, recorded above. |

## Fix response

| Finding | Fix | Check |
| --- | --- | --- |
| Marker root divergence | The agent now resolves markers from `VOICE_C0_DATA_DIR` only when absolute, otherwise the repository-root `data/c0`; it never uses its cwd. | `runtime.check.ts` |
| SpeechCreated does not prove playout | The marker is now set only on the 1.9.0 `AgentStateChanged` `speaking` transition, whose installed `agent_activity.ts` first-frame path waits for playback started. | `audio.check.ts` |
| Bridge refusal stranded transfer | `request_transfer` always invokes the transfer adapter after its durable intent attempt, including a refusal or error. | `tools.check.ts` |
| Missing process entry | `src/main.ts` now owns the AgentServer process start while `worker.ts` remains importable. | `config.check.ts` |
| Controller type defects | Narrowed the delivery kind and explicitly represented the validated service intent as the durable JSON object expected by the outbox. | `npm run typecheck` |
