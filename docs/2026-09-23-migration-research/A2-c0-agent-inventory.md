# A2: C0 voice canary agent inventory (read-only research)

- **Worktree (`<WT>`):** `C:\Users\carte\orca\workspaces\grizzly-hcp\grizzly-livekit-c0-stage1`
- **Branch and HEAD:** branch `barnscarter-ops/grizzly-livekit-c0-stage1`, HEAD `102bc6a` (2026-09-22 23:10 CT). The tree is clean.
- **Citations:** every path below is relative to `<WT>`. Line numbers are from HEAD.
- **Method:** I read all of `canary/c0/**` (source, runbooks, provisioning), the imported `src/agent/voice/*` modules, and the four named docs. I also looked at `docs/2026-09-22-c0-reviews/*` and parts of the production `voice-server.ts`/`resolver.ts` for parity context.
- **What I did not touch:** I did not open `.env.c0`. I did not run `c0ctl` start, stop, restart, or status, and I did not run PM2. No Twilio, LiveKit, or OpenAI account was called. Runtime facts come only from the process table, socket table, PID files, and redacted evidence JSON. I masked or counted phone numbers and never copied them.

**Legend:**
- **[R]** Read directly in source or docs at the cited lines.
- **[O]** Observed read-only on this PC on 2026-09-23.
- **[I]** Inferred. Neither code nor evidence proves it.
- **[U]** Explicitly unverified in the project's own docs.

---

## 0. Key takeaways

1. **C0 records requests only.** It has exactly two model tools: `record_service_request` and `request_transfer`. It has no HCP access of any kind: no lookup, booking, pricing, history, SMS, or after-hours logic. [R] `worker.ts:132-134`, `tools.ts:25-47`, D3/D4.
2. **"Delivery" is a local JSONL file on Carter's PC plus a stale-record ntfy alert.** Nothing consumes the outbox. `claimNext` and `markStatus` have no runtime caller. A human has to read `data/c0/voice-outbox.jsonl` on the PC, and that file holds the raw, unredacted caller details. [R] `outbox.ts:522-556`; grep confirms no consumer.
3. **Every layer is hard-wired for a staff-only allowlist with one call at a time.** The allowlist is enforced in four places (Function, LiveKit trunk, dispatch rule, agent). Concurrency is 1, and the daily ceiling is 30 calls or 90 GPT-Live minutes. No "all callers" mode exists anywhere. [R]
4. **The failure design is strong and reusable.** Humans come first: Twilio `<Dial timeout>` plus `/dial-action` plus the detector plus Sync transfer flags all converge on office → backup → voicemail. The kill switch is a single `VoiceUrl` write. [R]
5. **Hosting is launcher-managed, not PM2.** `c0ctl.ps1` runs detached `pwsh` supervisors under Carter's user session on CartersPC. There is no service or autostart. Logs are buffered until each child process exits. [R][O]
6. **The "outbound only" claim does not hold.** The agent process listens on **0.0.0.0:54653**. This is the LiveKit Agents worker's default health/`/worker` HTTP server (host `0.0.0.0`, random port). [O][R]
7. **As of HEAD, the rehearsal is not signed off.** The sign-off table in `REHEARSAL.md:18-30` is blank. `data/c0` has no outbox, marker, usage, or mapping files, so in this data root no call has yet passed agent admission. [O][I]

---

## 1. C0 call flow, end to end

### 1.1 Number and entry
1. The caller dials the canary DID `+1…2642`. The number is a Twilio **subaccount** resource.
   - It was **moved from the main account**, not bought: evidence `canary/c0/provision/evidence/20260922T213319-number-transfer.json` (`action: transfer_number_main_to_canary_subaccount`, `changed_fields: []`). [O]
   - Its `VoiceUrl` has been `https://grizzly-c0-canary-5889-production.twil.io/ingress` since 2026-09-23 03:25Z. Before that it was `/fallback`. `trunk_sid` and `voice_application_sid` are null (evidence `2026-09-23T03-25-23-292Z-twilio-number-route.json`). [O]
   - Routing refuses any number that has a trunk or application attached, requires `voice_method` to be POST, and allows only `voice_url` to change: `canary/c0/provision/lib.ts:149-158`, `twilio-number-route.ts:6-16`. [R]
2. **Twilio-level enable.** The Functions layer has **no enable flag**. "Enabled at Twilio" just means `VoiceUrl` points at `/ingress`. `VOICE_C0_ENABLED` exists only in the agent, detector, and monitor, which read it from `.env.c0`. [R] `ingress.protected.js:5-36` has no flag read.

### 1.2 `/ingress` (Twilio Function; protected, so Twilio validates the signature, `twilio-functions/deploy.md:15`)
- **Configuration.** Reads `C0_ALLOWED_CALLERS`, `C0_LIVEKIT_SIP_HOST`, `C0_SIP_USERNAME/PASSWORD`, `C0_CANARY_DID`, `C0_DIAL_TIMEOUT_S` (default 20), `C0_TIME_LIMIT_S` (default 480), and the transport/secure settings (`ingress.protected.js:6-14`). The Function env is built in `provision/deploy-functions.ts:12-30`.
- **Allowlist.** If `From` is not in `C0_ALLOWED_CALLERS`, or `CallSid` is missing, the response is `<Redirect>/fallback` (`ingress.protected.js:17-19`; `lib/c0.private.js:70-74`). [R]
- **Single-call lease.**
  - Creates the Sync document `c0-lease` with TTL = timeLimit + 120 s = 600 s.
  - On a 409, it fetches the current holder's call status and takes over only if that call is terminal, using a conditional `ifMatch` update. Otherwise the caller goes to `/fallback` (`c0.private.js:131-165`; `ingress.protected.js:21-23`). [R]
  - *Deviation from D1:* D1 describes the lease as "via Calls API list". It is implemented as a Sync lease.
- **Any exception** also redirects to `/fallback` (`ingress.protected.js:38-42`). [R]
- **Played copy.** `<Say>` plays the disclosure, then the emergency notice (`ingress.protected.js:26-27`; copy at `c0.private.js:5-6`). [R]
- **The dial.** `<Dial action=/dial-action timeout=20 answerOnBridge=true timeLimit=480><Sip username password>sip:<DID>@<LK SIP host>;transport=tcp?X-C0-Call=<CallSid></Sip>` (`ingress.protected.js:28-34`; URI built at `c0.private.js:65-68`).
  - The deploy default is `tcp` with `C0_SIP_SECURE=false` (`deploy-functions.ts:13,25`).
  - Preflight evidence shows the transport and media-encryption defaults are in effect (`2026-09-23T03-25-07-075Z-preflight.json`). [R][O]

### 1.3 LiveKit SIP ingress and dispatch
- **Inbound trunk `grizzly-c0-canary-inbound`** (`provision/livekit-sip.ts:39-53`):
  - `numbers=[DID]`
  - `allowedNumbers` = staff callers
  - digest username/password
  - `headersToAttributes {X-C0-Call: c0.callSid}`
  - ringing timeout 15 s
  - max call duration 480 s
  - `media.encryption = SIP_MEDIA_ENCRYPT_ALLOW`
- **Dispatch rule `grizzly-c0-canary-dispatch`** (`livekit-sip.ts:55-64, 87-89`):
  - explicit `trunkIds`
  - `hidePhoneNumber:true`
  - `inboundNumbers` = staff callers
  - `dispatchRuleIndividual` (one room per call, prefix `c0-`)
  - `roomConfig.agents=[{agentName:'grizzly-c0-canary'}]`
- **Live state matches the spec.** Evidence `2026-09-23T03-01-18-340Z-livekit-sip.json` shows 1 trunk and 1 rule with exactly these values: 1 number, 1 allowed caller, 15 s / 480 s, encryption enum 1 (ALLOW), header map present, 1 trunk ID bound, hidePhoneNumber true, prefix `c0-`, agent `grizzly-c0-canary`. [O]

### 1.4 Agent worker (self-hosted on CartersPC)
- **Startup.** `main.ts:21-41` initializes the logger, runs `loadCanaryRuntimeConfig`, then `new AgentServer(options).run()`. The script must be invoked with a trailing `start` argument (`main.ts:25`). [R]
- **Configuration source.** Config comes only from `canary/c0/.env.c0` (`config.ts:5, 11-15`). Any inherited `VOICE_C0_*` or `VOICE_OUTBOX_*` value that differs from the file makes the process refuse to start (`config.ts:13`). [R]
- **Worker registration.** `ServerOptions` uses `agentName 'grizzly-c0-canary'`, with `wsURL`, `apiKey`, and `apiSecret` taken from the `.env.c0` values (`worker.ts:17, 190-198`). [R]
- **Job entry.** `ctx.connect()` → `waitForParticipant()` → `enterCanary` (`worker.ts:179-185`). [R]

### 1.5 Pre-session gates (every refusal still routes the caller to a human)
The gates run in this order (`worker.ts:90-127`):
1. **`evaluateGate`** (`gate.ts:26-39`) checks five things:
   - participant kind is SIP
   - `sip.trunkID` equals `VOICE_C0_LIVEKIT_TRUNK_ID`
   - `sip.ruleID` equals `VOICE_C0_LIVEKIT_RULE_ID`
   - `c0.callSid` matches `^CA[0-9a-f]{32}$`
   - the enabled flag is true

   If the CallSid attribute has not arrived yet, the agent waits up to 3 s for `participant_attributes_changed` (`gate.ts:41-53`; `worker.ts:100-102`).

   On refusal: with a valid CallSid, the call goes to the office transfer; otherwise the room is deleted (`worker.ts:41-52, 103-108`). **When disabled, callers are transferred to the office, not dropped.**
2. **Caller allowlist.** The agent fetches the parent call's `From` through the Twilio Calls API. It must be E.164 and in `VOICE_C0_ALLOWLIST` (`caller.ts:8-20`; `worker.ts:120-121`).
3. **Mapping bind.** Appends to `data/c0/voice-c0-mapping.jsonl`: parent CallSid, child SID, trunk, rule, room, participant, and SIP call ID. A conflict or I/O fault sends the call to the office (`mapping.ts:15-27`; `bridge.ts:53-55`; `src/agent/voice/c0-mapping.ts:143-157`).
4. **Admission limits** (`admission.ts:11-32`; `c0-limits.ts:3-15, 44-64`; `runtime.ts:40-70`):
   - fewer than 1 other active `c0-` room with a SIP participant, checked through RoomService `listRooms`/`listParticipants`
   - fewer than 30 calls today
   - fewer than 90 GPT-Live minutes today, read from `data/c0/usage-<America/Chicago date>.jsonl`

   If any counter can't be observed, admission is denied and the call goes to the office.

### 1.6 Post-admission session start (`worker.ts:128-138`)
This step is wrapped by `startPostAdmission` (`worker.ts:26-39`). If anything fails, it clears the admission doc and transfers the call to the office.
1. Sync `c0-admitted-<CallSid>` is written with TTL 900 (`transfer.ts:19-22`).
2. The `answered` marker file is written (`runtime.ts:25-32`).
3. Usage is incremented by one call.
4. The model is built with `GPTLiveModel({ model:'gpt-live-1', delegation:'responses', apiKey })`.
   - The plugin defaults, which are **not pinned in C0 code**, are voice `marin` and backend Responses model `gpt-5.6-luna`: `canary/c0/agent/node_modules/@livekit/agents-plugin-openai/dist/realtime/gpt_live_model.js:20-21, 51` (plugin 1.9.0). [R]
5. `new Agent({ instructions: CANARY_INSTRUCTIONS, llm, tools })` (`worker.ts:18, 133-134`).
6. `new AgentSession({ userAwayTimeout: 15 })`.
7. `session.start({ record: { logs:false, traces:false, audio:false } })` (`worker.ts:135-136`).

### 1.7 In session
- **First audio.** Moving to the agent state `speaking` writes the `first-audio` marker (`worker.ts:148-151`; `audio.ts:7-16`).
- **Usage metering.** GPT-Live seconds are summed from `MetricsCollected` (`worker.ts:152-155`) and appended to usage at shutdown (`worker.ts:162-165`).
- **Silence.** When the user state becomes `away` (15 s), the agent says "Are you still there?" once. The second `away` transfers the call to the office (`worker.ts:156-160`).
- **Hard duration timer.** A 480 s timer transfers to the office (`worker.ts:161`).
- **Greeting.** `generateReply({instructions:'Greet briefly and offer assistance.'})`. An error here transfers to the office (`worker.ts:166-171`).
- **Rehearsal switch.** `VOICE_C0_REHEARSAL_SILENT_START` suppresses the first-audio marker and delays the greeting by 15 s (`worker.ts:149, 167`).

### 1.8 Tools (`tools.ts`)
- **`record_service_request`** (`tools.ts:26-35`):
  - Its zod schema requires name, E.164 `callbackNumber`, service address, scope, preferred windows, and `callerConfirmed: true`.
  - Call path: `RealC0Bridge.record` (`bridge.ts:56-72`) → `controller.enqueueServiceIntent` (`c0-controller.ts:545-568`) → `Outbox.append` (`outbox.ts:522-556`).
  - The model receives either `{status:'recorded'}` or `{status:'refused'}`.
- **`request_transfer({role:'office'|'backup'})`** (`tools.ts:36-46`):
  - Writes a best-effort `transfer` outbox record (`c0-controller.ts:570-591`), then calls `transferWithSync`.

### 1.9 Transfer mechanics (`transfer.ts:72-88`)
1. Sync `c0-transfer-<CallSid>` is created with `{role}` and TTL 900.
2. `RoomServiceClient.deleteRoom(room)` ends the SIP/AI leg.
3. The Twilio `<Dial>` ends, and `/dial-action` consumes the flag, returning `<Redirect>/fallback?role=…` (`dial-action.protected.js:8-17`).
4. **Fallback path:** if the Sync write or `deleteRoom` throws, the parent call is redirected through the Calls API with `update({url: /fallback?role=…})` (`transfer.ts:45-60, 86`).

The model never sees a phone number. There is no SIP REFER (D5). [R]

### 1.10 `/dial-action` (`dial-action.protected.js:5-31`)
1. If a transfer flag exists, redirect to `/fallback?role`.
2. Otherwise, if the admission doc exists **and** `DialCallStatus=completed` with duration > 0, remove the admission and return `<Hangup>`. This is the normal end of an AI call.
3. Everything else (no-answer, busy, failed, Sync read error, no admission) goes to `/fallback` (office).
4. The lease is always released (`dial-action.protected.js:36`; `c0.private.js:167-180`).

### 1.11 Human fallback chain
- **`/fallback`** plays "Let me connect you with someone from the office." (`c0.private.js:7`), then `<Dial timeout=20 action=/fallback-next?role=…><Number url=/whisper>office|backup</Number>`. If the destination env value is missing, it goes straight to voicemail (`fallback.protected.js:5-15`).
- **`/whisper`**: the callee hears "Grizzly canary call. Press 1 to accept." Any other key, or no input, hangs up the callee leg (`whisper.protected.js:5-12`).
- **`/fallback-next`** (`fallback-next.protected.js:5-9`):
  - `DialBridged=true` → hang up
  - role office → `/fallback?role=backup`
  - role backup → voicemail
- **Voicemail:** `<Say>` voicemail copy, then `<Record maxLength=120 playBeep recordingStatusCallback=/voicemail-done>` (`c0.private.js:8, 88-98`).
- **`/voicemail-done`** POSTs to `https://ntfy.sh/<C0_NTFY_TOPIC>` with `{event, recordingSid, callSid first 6 chars…}` and releases the lease (`voicemail-done.protected.js:7-24`). [R]

### 1.12 End of call
- **There is no agent "end call" tool.** A call ends only when:
  - the caller hangs up;
  - a transfer happens (by tool, silence, max-duration timer, or error path); or
  - Twilio `timeLimit` or the trunk's `max_call_duration` (480 s) is reached.
- **On a normal hang-up:** the room closes, the shutdown callback appends usage (`worker.ts:162-165`), and `/dial-action` sees completed plus admission, so it hangs up and releases the lease. [R]
- **[I] Possible race at 8 minutes.** Twilio `timeLimit` and the trunk's `max_call_duration` both start at bridge time. The agent's own 480 s timer starts several seconds later, after admission. At 8 minutes the Dial probably completes first, `/dial-action` sees completed plus admission, and the caller is **hung up rather than transferred** to the office.
- **The call mapping is never closed out.** `C0MappingStore.markTerminal` exists (`c0-mapping.ts:167-178`) but has no caller (grep). [R]

### 1.13 Detector (`canary/c0/detector/src`)
- **Loop.** Runs every 2 s (`detector.ts:6`; `index.ts:31-32`) and only when `VOICE_C0_ENABLED=true` (`detector.ts:126`).
- **Tick.**
  1. Lists `in-progress` calls to the DID (`detector.ts:134`).
  2. For each call that has an `answered` marker but no `first-audio` marker 6 s or more after the answered file's mtime (`policy.ts:7, 20-32`; `detector.ts:149-167`), it does four things in order:
     - writes a one-shot `redirected` marker
     - writes Sync `c0-transfer-<sid>` with role office (best effort)
     - calls the Calls API `update(Url=/fallback?role=office)`
     - sends an ntfy alert with no caller details (`detector.ts:112-123, 169-202`)
- **Credentials.** Uses the C0 API key, falling back to the subaccount **auth token** (`index.ts:12-20`).
- **Coupling:** it reads the agent's **local marker files**, so the detector and agent must share one filesystem.
- **Blind spot.** With no `answered` marker there is no action (`detector.ts:151-154`). Silence before admission (agent down, or a crash before admission) is covered only by Twilio `<Dial timeout=20>` and LiveKit's 15 s ringing timeout. [U] Nobody has confirmed that LiveKit leaves the INVITE unanswered until an agent joins. `REHEARSAL.md` scenario G is meant to prove it and is unsigned.

### 1.14 Outbox monitor (`canary/c0/monitor/index.ts`)
- **Loop.** Every `VOICE_OUTBOX_MONITOR_INTERVAL_MS` (default 60 s, `c0-config.ts:43`) it reads the outbox read-only and runs `analyzeOutboxHealth(…, staleAfterMs)` (default 300 s, `c0-config.ts:42`).
- **Alerts.** It sends one ntfy "C0 outbox record is stale" per crossing and one "requires human reconciliation" (`monitor/index.ts:109-126, 133-181`). Crossing state persists in `data/c0/monitor-alerts.jsonl` (`monitor/index.ts:45-77`).
- **One stale alert per record, ever.** The second tier, `stale_repeat`, applies only to records in status `stale_alerted` (`outbox-monitor.ts:174-186`), and nothing ever sets that status. In practice every recorded request produces **exactly one** stale alert, about 5-6 minutes after it is created. [R][I]

---

## 2. Capability table

| # | Capability | What C0 does | Status | Files:lines | Notes |
|---|---|---|---|---|---|
| 1 | Greeting / AI disclosure | Twilio `<Say>` plays the disclosure and emergency notice before the dial. The model then greets freely ("Greet briefly and offer assistance.") | **done** | `c0.private.js:5-6`; `ingress.protected.js:26-27`; `worker.ts:168` | Exact, reviewed copy is Twilio-only (D7). [I] The caller hears two voices: Twilio's default `<Say>` voice, then GPT-Live `marin`. |
| 2 | Intake conversation | Collects name, callback, address, broad scope, and preferred windows; reads them back; gets confirmation | **done** (prompt-only) | `worker.ts:18`; `tools.ts:9-16` | The prompt has no business facts: no hours, service area, services, or pricing. Persona is "canary intake assistant". |
| 3 | `record_service_request` / outbox | Validated typed intent → idempotent append to local JSONL | **partial.** Recording is done; **delivery is missing** | `tools.ts:26-35`; `bridge.ts:56-72`; `c0-controller.ts:335-368, 545-568`; `outbox.ts:522-556` | Payload (name, callback, address, scope, windows) is stored **unredacted** at `data/c0/voice-outbox.jsonl` (mode 0600). No consumer: `claimNext`/`markStatus` have no runtime caller. The only signal is the monitor's stale ntfy. The D4 "operator CLI view (`snapshot()`)" has no script (grep). Free text is refused if it contains an email, 10+ digits, or a 7-digit chain (`c0-controller.ts:335-346`). A refused record returns `{status:'refused'}`, and the prompt gives no guidance for that case. [I] The per-process sequence (`bridge.ts:48-52`) means a duplicate tool call writes a second record. |
| 4 | Transfer to humans | Role-only tool → Sync flag plus room delete, or Calls API redirect → office (screened with press 1) → backup → voicemail | **done**, canary shape | `tools.ts:36-46`; `transfer.ts:45-88`; `dial-action.protected.js:8-17`; `fallback*.js`; `whisper.protected.js` | Destinations live only in Function env. The office hears **no caller context** (the whisper says only "Grizzly canary call"). F4 [U]: whether the parent-call redirect cleanly tears down the child leg. |
| 5 | Emergency handling | Tells the caller to hang up and call 911 (Twilio copy plus the prompt) | **partial** | `c0.private.js:6`; `worker.ts:18` | No 24/7 emergency direct dial. Production dials emergencies directly (`src/agent/voice-server.ts:19-21`). |
| 6 | Voicemail | Twilio `<Record>` (120 s) → ntfy alert with only the RecordingSid | **done** | `c0.private.js:88-98`; `voicemail-done.protected.js:7-24` | The recording stays in the Twilio subaccount. No transcription, and no link to the outbox. |
| 7 | HCP customer lookup | none | **missing (by design, D3/D4)** | tool list `tools.ts:25-47` | The caller's number is fetched from Twilio only for the allowlist check (`caller.ts`). Production voice has `lookup_my_appointments` (`resolver.ts:6-11`). |
| 8 | Address / job history | none | **missing** | n/a | No HCP. |
| 9 | Booking / appointment creation | Forbidden: "Never promise a booking" | **missing (forbidden)** | `worker.ts:18`; D7 | Production runs `[BOOKING_REQUEST]`/`[RESCHEDULE]` → `from-voice.ts` (`voice-server.ts:18-24`). |
| 10 | Pricing / estimate answers | Forbidden | **missing (forbidden)** | `worker.ts:18` | Production voice has `search_pricebook` and `lookup_pricing` (`resolver.ts:6-11`). |
| 11 | Knowledge / FAQ | none | **missing** | n/a | Production has `search_knowledge`. |
| 12 | SMS follow-ups | none | **missing** | grep: no SMS code in `canary/c0` | The subaccount number has no Messaging configuration. |
| 13 | After-hours behavior | none. The fallback rings office → backup → voicemail 24/7 | **missing** | grep: no office-hours code in `canary/c0` | Production gates general transfers on `officeStatus()` and turns them into a message when closed (`voice-server.ts:379`). |
| 14 | Caller allowlist | Four-layer staff allowlist; empty ⇒ everyone refused | **done (canary-only)** | `ingress.protected.js:6,17`; `livekit-sip.ts:45, 61, 163-168`; `caller.ts:8-20`; `config.ts:9`; `c0-config.ts:237-249` | **Blocks production:** no layer has an "all callers" mode. |
| 15 | Enable flag | `VOICE_C0_ENABLED==='true'` in agent, detector, monitor, and controller; audited writer script | **done** | `config.ts:14`; `gate.ts:37`; `detector.ts:126`; `monitor/index.ts:134`; `provision/set-enabled.ts:8-12` | Changing it requires `c0ctl restart agent`. Twilio-level enable is the VoiceUrl (§1.1). |
| 16 | Handoff (context to human or system) | Outbox `transfer` record holding `{role}` only | **partial** | `c0-controller.ts:570-591` | No summary, name, or reason goes to the office; no HCP note. |
| 17 | Language | Not configured | **missing** | `worker.ts:132` (no language or voice option) | English copy only. [I] GPT-Live may mirror the caller's language, but nothing designs or tests that. |
| 18 | Errors / silence | Silence check-in then transfer; greeting error → transfer; pre- and post-admission failures → transfer; detector first-audio redirect; Function exceptions → `/fallback` | **partial** | `worker.ts:26-52, 103-108, 156-171`; `detector.ts`; `ingress.protected.js:38-42`; `dial-action.protected.js:39` | **No handler for session or model errors after the greeting**: `worker.ts` registers no Error or Close listener. [I] If GPT-Live drops mid-call, the caller may hear silence until they hang up or 480 s passes. The detector only guards first audio. |
| 19 | Recording / transcripts | Nothing recorded except voicemail | **none (by design)** | `worker.ts:136` (`record` all false); no `<Dial record>` | No transcript is kept anywhere local. The OpenAI retention/ZDR decision is still open (readiness F11). The readiness §3.7 "safety identifier = hashed CallSid" is not implemented (grep). |
| 20 | PII handling | Redacted operator surfaces; raw data at rest | **partial** | Redaction: `outbox.ts:279-303, 655-670`; `monitor/index.ts:109-126`; `detector.ts:112-123`; `voicemail-done.protected.js:7-11`; `c0-mapping.ts:180-202`; `c0ctl.ps1:260-263`; `provision/lib.ts:65-76`; `hidePhoneNumber` `livekit-sip.ts:60` | The outbox payload is raw. `livekit-sip` evidence JSON keeps **unmasked** `numbers`/`allowedNumbers`, because `publicTrunk` (`livekit-sip.ts:70-76`) does not mask them and `redact()` masks only `*sid`/`*id` keys. Alerts go to public ntfy.sh, protected only by the topic name. |
| 21 | Concurrency / daily ceilings | 1 call; 30 calls/day; 90 GPT-Live min/day; unobservable ⇒ deny | **done (canary limits)** | `c0-limits.ts:3-15, 44-64`; `admission.ts`; `c0.private.js:131-165` | D6 says "then the kill switch is requested". The code only denies admission; there is no alert or kill request (the agent has no ntfy code). |
| 22 | First-audio deadline | Detector redirects after 6 s | **done** | `detector.ts`; `policy.ts` | Depends on the local marker files. |
| 23 | Kill switch | VoiceUrl → `/fallback` (one field) | **done** | `twilio-number-route.ts`; `lib.ts:149-158`; `GO-LIVE.md:36` | See §3. |
| 24 | Observability | Supervisor event log; stdout/stderr captured | **partial** | `c0ctl.ps1:156-159, 210-214` | `ReadToEndAsync` plus `WaitForExit` means **logs appear only after the child exits**. Nothing is visible while it runs, and there is no metrics sink. |
| 25 | CallSid ↔ room mapping | Append-only bind | **done (never closed)** | `c0-mapping.ts:143-157` | `markTerminal` has no caller. |

**Stage-1 core modules the runtime never imports:** `src/agent/voice/c0-entry.ts`, `blocks.ts`, `transfer-adapter.ts`, and `transport.ts`. Grep finds no import from `canary/c0`. The runtime uses only `c0-controller`, `c0-config`, `c0-limits`, `c0-mapping`, `outbox`, and `outbox-monitor`. [R]

---

## 3. D1–D8: binding decisions (`docs/2026-09-22-c0-stage2-build-decisions.md`)

| # | One-line summary | Implementation delta at HEAD |
|---|---|---|
| **D1** | Topology: the DID lives in a subaccount with its VoiceUrl pointed at the Twilio Function `/ingress` (TrunkSid and AppSid empty). Ingress checks the allowlist and the single-call lease, `<Say>`s the copy, then does `<Dial><Sip>` to a dedicated LiveKit trunk and dispatch rule. `/dial-action` and `/fallback` send callers to humans. The agent, detector, and monitor are **outbound-only** processes on CartersPC. | The lease is a Sync document, not a Calls-API list. PM2 was replaced by `c0ctl.ps1` (commit 102bc6a; `ecosystem.c0.config.cjs:1` is marked "Reference only"). The agent **does** open a 0.0.0.0 listener (§4). |
| **D2** | Code isolation: the core stays in `src/agent/voice` (Node builtins only). Runnables go under `canary/c0/*` with pinned packages. Root `package.json`, `ecosystem.config.cjs`, `.env.example`, and `voice-server.ts` are untouched. Secrets live only in git-ignored `canary/c0/.env.c0`. | Holds. The canary imports the core through relative `../../../../src/agent/voice/*.js` paths (`bridge.ts:1-4`; `admission.ts:2`; `monitor/index.ts:4-6`). |
| **D3** | Model: `GPTLiveModel({model:'gpt-live-1', delegation:'responses', apiKey:VOICE_C0_OPENAI_API_KEY})` with **exactly two** controller-validated tools. No provider tools. This deviates from the readiness plan's `delegation:'client'`, and Carter is to review it. | Holds (`worker.ts:132-134`). The backend model defaults to `gpt-5.6-luna` inside the plugin and is not pinned. |
| **D4** | Delivery = record-only: a durable local outbox (`data/c0/voice-outbox.jsonl`), redacted ntfy to a canary-only topic, and an operator `snapshot()` view. No HCP, pending store, poller, or production ops import. | No script exposes `snapshot()`. ntfy fires only on stale or reconciliation, not per record. |
| **D5** | Transfer = the canary's own adapter: a Calls API redirect of the **parent** CallSid to `/fallback?role=`. No SIP REFER. Uses a Restricted key scoped to calls/update. Destinations live only in Function env. | The primary path is now a Sync flag plus room delete, with the Calls API redirect as fallback. **A Standard subaccount key is used instead of a Restricted key.** `twilio-restricted-keys.ts:12-18` records the deviation, and its Restricted policy constant (`:6-9`) is unused. Evidence `...twilio-restricted-keys.json` shows `keyType: standard`. |
| **D6** | Limits: Dial timeout 20 s; ringing 15 s; first audio 6 s; silence 15 s + one check-in → transfer; max 8 min (480 s); concurrency 1; daily 30 calls / 90 min then deny and request the kill switch; outbox retries 5 over 30 min then `human_reconciliation_required`. | All present (`c0-limits.ts:3-15`). The "request kill switch" part is absent. Retry policy exists but has no retrier. |
| **D7** | Exact caller wording (disclosure, emergency, fallback, voicemail) is Twilio `<Say>`, not the model. The persona never says "booked". The standard line is "The office will review your request and contact you." | Holds (`c0.private.js:5-8`; `worker.ts:18`). |
| **D8** | Worker process: no commits by workers; no provider calls unless a task authorizes them; never read `.env*`; every module gets a colocated `*.check.ts` (`node:assert/strict`, `npx tsx`). | Holds. `.check.ts` files exist for every module. |

### Kill switch and fallback mechanics
- **Kill switch** (`GO-LIVE.md:36`; `README.md:49-59`): run `npx tsx canary/c0/provision/twilio-number-route.ts --apply --to fallback`.
  - This is a single write that sets VoiceUrl to `/fallback`.
  - Before writing, the script asserts that the number is the DID, has no trunk or application, and uses `voice_method` POST. After writing, it asserts that only `voice_url` changed (`twilio-number-route.ts:6-16`; `lib.ts:149-158`).
  - Optionally follow with `c0ctl stop all`.
  - Target: new calls reach humans within 60 s. Existing calls finish under their current TwiML.
  - It works only while TrunkSid and VoiceApplicationSid stay empty (readiness F1).
- **Soft disable.** Running `set-enabled.ts --apply --value false` followed by `c0ctl restart agent` makes the agent refuse and transfer every call to the office (`gate.ts:37`; `worker.ts:103-107`). Twilio still plays the copy and dials LiveKit first. [I] This adds a few seconds before the caller reaches a human.
- **Fallback layers, from outermost in:**
  1. ingress refusal or exception → `/fallback`
  2. the SIP leg never answered (agent or LiveKit down) → Dial timeout 20 s / ringing 15 s → `/dial-action` → `/fallback`
  3. agent gate, admission, or post-admission failure → Sync flag plus room delete, or Calls API redirect
  4. detector first-audio redirect at 6 s
  5. silence or 480 s timer → office transfer
  6. office → backup (both screened with press 1) → voicemail → ntfy
- **Rollback** (`GO-LIVE.md:38`): run the kill switch, then `stop all`, then preserve evidence, logs, outbox, and markers. Leave the Functions, Sync, LiveKit trunk and rule, and the number in place, inert on `/fallback`. Never route to ConversationRelay (readiness §3).

---

## 4. Hosting today (CartersPC; c0ctl, not PM2)

### 4.1 Processes [O] (read-only CIM query, 2026-09-23; no lifecycle action)
| Role | PID | Command (`<WT>` elided) | Started (CT) |
|---|---|---|---|
| agent supervisor | 42628 | `pwsh -NoProfile -ExecutionPolicy Bypass -File <WT>\canary\c0\c0ctl.ps1 start agent -Supervisor` | 2026-09-22 22:24:40 |
| agent child (tsx CLI) | 16016 → node 7048 | `node <WT>\canary\c0\agent\node_modules\tsx\dist\cli.mjs canary/c0/agent/src/main.ts start` | 22:24:40 |
| agent inference subprocess | 6076 (~96 MB) | `@livekit/agents/dist/ipc/inference_proc_lazy_main.js` (local EOT turn-detector model) | — |
| detector supervisor / child | 47072 / 19448 → 22936 (+ esbuild) | `… c0ctl.ps1 start detector -Supervisor` / `canary/c0/detector/src/index.ts` | 22:16:30 |
| monitor supervisor / child | 14408 / 30820 → 50108 (+ esbuild) | `… c0ctl.ps1 start monitor -Supervisor` / `canary/c0/monitor/index.ts` | 22:16:30 |

- **Supervisors are detached.** Their parent shells (PIDs 17664 and 52912) no longer exist.
- **Launch mechanics.** `c0ctl.ps1` starts each supervisor with `Start-Process -WindowStyle Hidden` (`c0ctl.ps1:161-185`). Each supervisor runs its node child with `TZ=America/Chicago` (`c0ctl.ps1:187-231`).
- **Restart policy.** Exponential backoff of 5→60 s. After 5 restarts in 10 minutes the supervisor gives up (`c0ctl.ps1:217-226`).
- **Stop guard.** Stop acts only on a PID whose command line exactly matches the expected tokens, parsed with `CommandLineToArgvW` (`c0ctl.ps1:71-145, 233-258`).
- **Not durable.** There is no Windows service or scheduled task. [I] The processes won't survive a logoff or reboot.
- **Run history.** The agent crash-looped at 22:16 on a logger-initialization bug (`data/c0/logs/agent.err.log`; `agent.supervisor.log`). The bug was fixed in 102bc6a. The agent has run cleanly since the 22:24:40 relaunch. [O]
- **Data root.** `data/c0/` contains only `run/`, `logs/`, and `.gitignore`. No outbox, `answered`/`first-audio`/`redirected` markers, `usage-*.jsonl`, or mapping file exists. [O] [I] No call has passed admission in this data root, unless `VOICE_C0_DATA_DIR` points somewhere else; I did not read `.env.c0` to check.
- **Runtime versions.** Preflight evidence (`2026-09-23T03-25-07-075Z-preflight.json`): Node 24.19.0, `pm2OnPath:true` (present but unused), `envGitIgnored:true`, stage `enable` `pass:true`. [O]

### 4.2 Env var names (from templates and source only; no values)
- **Agent** (`agent/README.md:9-22`; `config.ts:14`):
  - Read directly: `VOICE_C0_TWILIO_ACCOUNT_SID`, `VOICE_C0_TWILIO_API_KEY_SID`, `VOICE_C0_TWILIO_API_KEY_SECRET`, `VOICE_C0_LIVEKIT_URL`, `VOICE_C0_LIVEKIT_API_KEY`, `VOICE_C0_LIVEKIT_API_SECRET`, `VOICE_C0_OPENAI_API_KEY`, `VOICE_C0_FALLBACK_URL`, `VOICE_C0_SYNC_SERVICE_SID`, `VOICE_C0_DATA_DIR`, `VOICE_C0_MAPPING_PATH`, `VOICE_C0_ENABLED`, `VOICE_C0_LIVEKIT_TRUNK_ID`, `VOICE_C0_LIVEKIT_RULE_ID`, `VOICE_C0_ALLOWLIST`, `VOICE_C0_REHEARSAL_SILENT_START`.
  - Passed through to the core (`c0-config.ts:52-62`): `VOICE_C0_PROVIDER`, `VOICE_C0_MODEL`, `VOICE_C0_NTFY_TOPIC`, `VOICE_OUTBOX_PATH`, `VOICE_OUTBOX_STALE_MS`, `VOICE_OUTBOX_MONITOR_INTERVAL_MS`. `PROVIDER` and `MODEL` are parsed but never used; the model is hard-coded.
- **Detector** (`detector.ts:213-222`; `index.ts:12-20`): `VOICE_C0_ENABLED`, `VOICE_C0_CANARY_DID`, `VOICE_C0_FALLBACK_URL`, `VOICE_C0_NTFY_TOPIC`, `VOICE_C0_SYNC_SERVICE_SID`, `VOICE_C0_DATA_DIR`, `VOICE_C0_TWILIO_ACCOUNT_SID`, `VOICE_C0_TWILIO_API_KEY_SID/SECRET`, and `VOICE_C0_TWILIO_AUTH_TOKEN` as a fallback.
- **Monitor** (`monitor/index.ts:186-201`): `VOICE_C0_ENABLED`, `VOICE_C0_NTFY_TOPIC`, `VOICE_C0_DATA_DIR`, `VOICE_C0_ALLOWLIST`, `VOICE_OUTBOX_PATH`, `VOICE_OUTBOX_STALE_MS`, `VOICE_OUTBOX_MONITOR_INTERVAL_MS`.
- **Provisioning (all names)** (`provision/lib.ts:78-83`; `.env.c0.example:1-68`): the above plus `VOICE_C0_TWILIO_AUTH_TOKEN`, `VOICE_C0_CANARY_NUMBER_SID`, `VOICE_C0_INGRESS_URL`, `VOICE_C0_LIVEKIT_SIP_HOST`, `VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION`, `VOICE_C0_SIP_USERNAME`, `VOICE_C0_SIP_PASSWORD`, `VOICE_C0_SIP_TRANSPORT`, `VOICE_C0_ALLOWED_CALLERS`, `VOICE_C0_OFFICE_NUMBER`, `VOICE_C0_BACKUP_NUMBER`.
- **Operator-only,** set in the process env and never in `.env.c0`: `C0_OPERATOR_PARENT_ACCOUNT_SID` and `C0_OPERATOR_PARENT_AUTH_TOKEN` (`snapshot-production-guard.ts:74-78`).
- **Twilio Function env** (set by `deploy-functions.ts:15-29`): `C0_ALLOWED_CALLERS`, `C0_SYNC_SERVICE_SID`, `C0_LIVEKIT_SIP_HOST`, `C0_SIP_USERNAME`, `C0_SIP_PASSWORD`, `C0_CANARY_DID`, `C0_DIAL_TIMEOUT_S`, `C0_TIME_LIMIT_S`, `C0_SIP_TRANSPORT`, `C0_SIP_SECURE`, `C0_OFFICE_NUMBER`, `C0_BACKUP_NUMBER`, `C0_NTFY_TOPIC`. The runtime is `node22`, and the service is `grizzly-c0-canary` in the `production` environment (`deploy-functions.ts:7-8, 44`).
- **Unguarded SDK env fallbacks** [R, from the SDK]:
  - The C0 inherited-conflict guard covers only the `VOICE_C0_` and `VOICE_OUTBOX_` prefixes.
  - These SDK variables can still change runtime behavior if set in the launcher environment: `LIVEKIT_AGENT_NAME_OVERRIDE`/`LIVEKIT_AGENT_NAME` (agents `dist/worker.js:184-191`) and `OPENAI_BASE_URL` (`gpt_live_model.js:55`).

### 4.3 Network
- **Agent outbound** (`transfer.ts:67-69, 90-94`; `worker.ts:73`; plugin baseURL):
  - LiveKit Cloud worker registration over WSS. [O] One ESTABLISHED TCP connection to `161.115.182.113:443`, owned by node PID 7048. [I] That address is LiveKit Cloud.
  - LiveKit RoomService over HTTPS (`listRooms`, `listParticipants`, `deleteRoom`).
  - Per call: LiveKit room media through `@livekit/rtc-node` [I, WebRTC/UDP], OpenAI GPT-Live at `api.openai.com/v1` (live sessions), Twilio REST Calls fetch/update, and Twilio Sync.
- **Detector outbound:** Twilio REST Calls list/update (every 2 s), Twilio Sync, and `ntfy.sh`.
- **Monitor outbound:** `ntfy.sh` only.
- **Twilio Functions** (run in Twilio's cloud): Sync, Calls fetch, and `ntfy.sh`.
- **Inbound: NOT none.**
  - [O] Agent node PID 7048 is **LISTENING on `0.0.0.0:54653`**.
  - [R] Cause: LiveKit Agents 1.9.0 `AgentServer` defaults to `host = "0.0.0.0"` with an undefined port, meaning a random port (`canary/c0/agent/node_modules/@livekit/agents/dist/worker.js:163-164, 293-303`). It serves `/` (health) and `/worker` (JSON with agent_name, active_jobs, sdk_version, and more) (`dist/http_server.js`).
  - Neither Twilio nor LiveKit needs this listener. [I] It is reachable from the LAN or tailnet unless Windows Firewall blocks it.
  - It contradicts D1 and README.md:4-5 ("no public listener"). The fix would be `ServerOptions({ host:'127.0.0.1', port:<fixed> })`.
  - [O] Detector and monitor have no listening sockets. No inbound webhook to the PC exists; Twilio webhooks terminate at `*.twil.io`.

---

## 5. Known gaps, TODOs, and fail-closed seams that block production parity

**A. Scope: record-only by design (D3/D4/D7)**
1. No HCP reads or writes of any kind: customer lookup, appointments, job history, booking, reschedule, estimate, pricebook, or knowledge. Production voice has four read tools plus `[BOOKING_REQUEST]`/`[MESSAGE]`/`[RESCHEDULE]` → `from-voice.ts` (`resolver.ts:6-11`; `voice-server.ts:18-24`).
2. No after-hours policy, no emergency on-call direct dial, no SMS, no caller-context whisper, and no Carter/Jaime targets. C0 has only the office and backup roles.

**B. Delivery and data (found in code)**

3. **The outbox is a dead end.**
   - Records are written raw to `data/c0/voice-outbox.jsonl` on the PC (`outbox.ts:551`).
   - Nothing claims them, delivers them, or marks them done. There is no operator CLI.
   - Each record produces one ntfy alert telling someone to "review the local C0 outbox" (`monitor/index.ts:109-117`).
   - The retry and reconciliation policy (`c0-limits.ts:80-96`; `outbox.ts:572-652`) is dormant.
   - The store assumes a single writer (`outbox.ts:30-32`).
4. **Single-host coupling.** The detector reads the agent's local marker files. Usage, mapping, and outbox are all under `<WT>/data/c0` (`runtime.ts:5-14`; detector `data-root.ts:24-32`). None of the processes can move to another host independently.
5. **Hard-coded canary identity.** Agent name `grizzly-c0-canary`, trunk and rule names, room prefix `c0-` (which the admission count also uses, `admission.ts:16`), the `X-C0-Call` header and `c0.callSid` attribute, the Sync documents `c0-lease`/`c0-transfer-*`/`c0-admitted-*`, service names, the `VOICE_C0_*` env prefix, and the "canary intake assistant" prompt are all hard-coded.
6. **Canary limits are baked in.** The four-layer allowlist refuses everyone when empty. Concurrency is 1 (both the Sync lease and the room count). The daily ceiling is 30 calls / 90 minutes. The `c0-limits.ts` constants are frozen.

**C. Runtime robustness (found in code; [I] marks behavior not proven live)**

7. No handler for session or model failure after the greeting (no Error or Close listener in `worker.ts`). [I] A mid-call GPT-Live drop can leave the caller in silence.
8. [I] The 480 s race described in §1.12: at the time limit, the caller is likely hung up instead of transferred.
9. The daily ceiling does not alert or request the kill switch that D6 calls for.
10. [I] Service-intent validation may falsely refuse ordinary text: the 7-digit-chain and 10-digit rules would catch an address like "…Rd 1234, 75201". The prompt has no refused-record path.
11. `intentSequence` is an in-memory counter per process, so a repeated tool call writes a new record (`bridge.ts:48-52`).
12. [I] The usage "GPT-Live minutes" come from summing `MetricsCollected.duration`, which may not match billed minutes.

**D. Hosting and security**

13. Detached `pwsh` supervisors in the user session have no service or reboot persistence. Logs are buffered until the child exits (`c0ctl.ps1:210-214`). There is no health or metrics export apart from the unintended 0.0.0.0 listener (§4.3).
14. The runtime uses a **Standard** Twilio key, not a Restricted one (D5 deviation). The detector can fall back to the subaccount **auth token**. One LiveKit key pair is used for both provisioning (SIP admin) and runtime. [I] The readiness plan (§3.6) wanted separate keys.
15. SIP between Twilio and LiveKit runs by default over **TCP with no `secure=true`**. With media encryption set to "ALLOW", media is [I] likely plain RTP. `deploy.md:29-33` marks TLS/SRTP on this path as **UNVERIFIED**.
16. Alerts go to public `ntfy.sh`; secrecy depends only on the topic name.
17. Nothing produces the egress-deny evidence the readiness plan requires (§3.8: HCP/CT102 unreachable from the agent host). There is no firewall artifact in the repo. [R] (absence)

**E. Unverified external seams (readiness plan [U] items and rehearsal)**

18. F4: whether the parent-call redirect tears down the `<Dial><Sip>` child cleanly.
19. Scenario G: whether LiveKit answers the call before an agent joins. The detector's blind spot (§1.13) depends on this.
20. Whether `secure=true` works on `<Dial><Sip>`.
21. F11: GPT-Live alpha access and tier, and ZDR/retention.
22. **All eight rehearsal scenarios (A–H) are unsigned** (`REHEARSAL.md:18-30`).

**F. Evidence hygiene**

23. **No recorded step-15 production-guard pass.**
    - The two C0 guard snapshots (`2026-09-23T03-44-10-166Z` and `…T04-08-16-081Z`) list the same 4 masked parent-number SIDs, but **all 4 hashes differ**.
    - The 04:08 run has no `comparison` block, so no `pass:true` is recorded. [O]
    - [I] The difference most likely comes from expanding the guard's field set between the runs (the W7 `emergency_address_*` fix), not from a real production change.
    - Separately, the operator snapshot pair `20260922T214505-…-before.json` / `20260922T222535-…-after.json` is identical for all 4 numbers. [O]
    - **Next step:** take a fresh baseline and a `--compare` before any production step relies on this guard.
24. `set-enabled` evidence at 03:24Z still printed the old `pm2 restart c0-agent` hint. The code is fixed (`set-enabled.ts:11`), but the record in `evidence/` is stale. [O]
25. `livekit-sip` evidence files contain unmasked DID and allowlist numbers (§2 row 20). They are git-ignored, but they sit in plaintext in the worktree.

**G. Number provenance**

26. The canary DID was **moved from the main account** (with main-account credentials). This touches readiness F5, the open question of whether 10DLC/messaging registration survives a move. Production cutover needs its own number or port decision. The production line itself stays in the main account on ConversationRelay.

---

## 6. LiveKit resources and a second (production) trunk and dispatch rule

- **Project.** C0 uses a dedicated LiveKit Cloud project. Its URL is `VOICE_C0_LIVEKIT_URL` (wss://…), and its SIP host is `VOICE_C0_LIVEKIT_SIP_HOST`. I did not read either value. Carter bought the LiveKit membership himself (readiness §5). [R]
- **Created resources** (evidence 2026-09-23 03:01Z) [O]:
  - one inbound trunk, `grizzly-c0-canary-inbound`
  - one dispatch rule, `grizzly-c0-canary-dispatch`
  - their IDs are stored in `.env.c0` as `VOICE_C0_LIVEKIT_TRUNK_ID` (`ST_…`) and `VOICE_C0_LIVEKIT_RULE_ID` (`SDR_…`) (format rules at `preflight.ts:37-38`)
  - no outbound trunk
  - the agent is a self-hosted worker, not a LiveKit Cloud-deployed agent (readiness F12: cold start, no egress control)
- **Provisioning script: `canary/c0/provision/livekit-sip.ts`.**
  - It is dry-run by default. `--list` records the trunks and rules. `--apply` reconciles (`livekit-sip.ts:107-161`) in six steps:
    1. Finds the trunk **by name** `C0_TRUNK_NAME` and updates it, or creates it and then does a full update, because SDK 2.19.1 create options lack `maxCallDuration`.
    2. Asserts an explicit trunk ID.
    3. Finds the rule by name `C0_RULE_NAME` and updates it, or creates it and then updates it to set `inboundNumbers`.
    4. Asserts explicit `trunkIds` and that the allowlist was retained.
    5. Writes the trunk and rule IDs to `.env.c0` atomically.
    6. Writes evidence.
  - The API URL is the `wss:` project URL rewritten to `https:` (`livekit-sip.ts:173`).
  - Supporting scripts: `generate-sip-credentials.ts` (digest username/password), `deploy-functions.ts` (points the SIP URI at the trunk host), and `preflight.ts --stage livekit`.
- **How to create a second (production) trunk and dispatch rule.** This is [I], a recommendation derived from the code.
  1. **Use a separate LiveKit project and a separate env file.** Readiness F8 says a dispatch rule with no `trunk_ids` matches every trunk in the project, and a separate project also isolates keys, quotas, and agent names. If the same project is reused, every rule must bind explicit `trunkIds`, as `assertExplicitTrunkIds` already enforces (`livekit-sip.ts:27-29`).
  2. **Do not re-run `livekit-sip.ts` unchanged against the same project.** It reconciles **by name**, so it would *update the canary trunk and rule in place* instead of creating new ones. Parameterize or fork these first:
     - the trunk and rule names (`:24-25`)
     - the `agentName` (`:62`, and in the worker, `worker.ts:17`)
     - the room prefix (`:88`, and in `admission.ts:16`)
     - `numbers` = the production DID (`:44`)
     - allowlisting: `allowedNumbers` and `inboundNumbers` (`:45, :61`). LiveKit treats an empty list as "allow all", but `callers()` refuses an empty list (`:163-168`), so production needs an explicit open mode.
     - `headersToAttributes` (`:48`)
     - ringing and max-duration values (`:49-50`)
     - media encryption; move to TLS plus `SIP_MEDIA_ENCRYPT_ALLOW` or `REQUIRE` after the rehearsal proves it
  3. Issue a separate runtime API key with no admin or recording grants, and a separate SIP-admin key used only for provisioning (readiness §3.6).
  4. Deploy a production Twilio ingress (Function or TwiML) whose `<Sip>` URI targets the new project's SIP host with the new digest credentials, and register an agent worker under the new `agentName`. Keep the number free of any trunk or application so the VoiceUrl kill switch keeps working (F1).
  5. Elastic SIP Trunking is the alternative. It breaks the VoiceUrl kill switch (F1), and LiveKit support must enable `allowed_addresses` (F3). Readiness §4.1 recommends against it.

---

## Appendix: redacted evidence consulted ([O]; phone numbers were counted, never copied)
| Evidence file (`canary/c0/provision/evidence/`) | Fact |
|---|---|
| `20260922T213319-number-transfer.json` | DID `+14…2642` moved from the main account to the canary subaccount, HTTP 200, `changed_fields []`. |
| `2026-09-23T02-46-08-268Z-twilio-restricted-keys.json` | `keyType: standard`, with the Sync restricted-permission deviation noted. |
| `2026-09-23T02-47-02-239Z-deploy-functions.json` | Ingress and fallback URLs on `grizzly-c0-canary-5889-production.twil.io`. |
| `2026-09-23T03-01-18-340Z-livekit-sip.json` | 1 trunk and 1 rule, as described in §1.3. |
| `2026-09-23T03-24-38-979Z-set-enabled.json` | `VOICE_C0_ENABLED` changed from false to true at 03:24:38Z. |
| `2026-09-23T03-25-07-075Z-preflight.json` | Stage `enable` `pass:true`; Node 24.19.0. |
| `2026-09-23T03-25-23-292Z-twilio-number-route.json` | VoiceUrl changed from `/fallback` to `/ingress`; trunk and app null. |
| `2026-09-23T03-44-21-951Z-twilio-negative-authority.json` | `pass:true`: parent account and number reads both returned 401; the own-subaccount control succeeded. |
| `2026-09-23T03-44-10-166Z` / `T04-08-16-081Z-snapshot-production-guard.json` | 4 parent numbers. All hashes differ between the runs, and there is no `comparison` block (see §5 item 23). |
