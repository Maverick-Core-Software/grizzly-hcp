# C0 canary: Stage 2 build decisions (orchestrator, 2026-09-22)

This is binding for every worker on this build. It implements `2026-09-22-c0-stage2-config-readiness-plan.md` (cited below as "readiness §N") under Carter's authorization in readiness §5. If a decision here conflicts with the approved canary plan, flag it to the coordinator; don't silently deviate.

## D1. Topology: no public inbound endpoint on our infrastructure

```
Caller -> canary DID (Twilio subaccount; VoiceUrl -> Function /ingress; TrunkSid and VoiceApplicationSid stay EMPTY)
  /ingress  (Twilio Function, protected => Twilio validates X-Twilio-Signature)
     - From not in C0 staff allowlist            -> redirect to /fallback
     - another in-progress call on the canary DID -> redirect to /fallback   (single-call lease, via Calls API list)
     - else: <Say> reviewed disclosure + emergency copy, then
       <Dial action=/dial-action timeout=T answerOnBridge=true timeLimit=M>
         <Sip username/password (Function env)>sip:<DID>@<livekit sip host>;transport=tls?X-C0-Call=<CallSid></Sip>
       </Dial>
  /dial-action (Function): any DialCallStatus other than a completed agent-ended call -> /fallback. A completed call ends the call.
  /fallback, /fallback-next, /voicemail-done (Functions): reviewed copy -> screen-transfer office -> backup on decline/no-answer -> voicemail (<Record>) -> redacted ntfy alert.
LiveKit Cloud (dedicated project): inbound trunk (numbers=[DID], auth user/pass, allowed_numbers=staff, headers_to_attributes X-C0-Call -> c0.callSid,
  ringing_timeout, max_call_duration) + dispatch rule (explicit trunkIds, hidePhoneNumber, inboundNumbers=staff, roomConfig.agents=[grizzly-c0-canary]).
Agent worker (self-hosted on CartersPC, own PM2 app, OUTBOUND ONLY): LiveKit Agents JS + GPT-Live.
Detector (own PM2 app, OUTBOUND ONLY): polls the subaccount Calls API for in-progress canary calls; if a call has no first-audio marker from the agent by the deadline -> Calls API update Url=/fallback.
Outbox monitor (own PM2 app): pure outbox-monitor policy + redacted ntfy alert; never retries or writes records.
```

Why: production is exposed through a Proxmox-hosted Cloudflare tunnel. The canary needs no tunnel change, no Proxmox action and no public port on the PC. If the PC or agent is down, Twilio's own `<Dial timeout>` plus `/dial-action` send the caller to humans, so no process of ours sits in that path (readiness F1, F2, F6).

## D2. Code layout: isolated from production

- C0 core stays in `src/agent/voice/` (Node builtins only; the existing isolation scans keep applying).
- New runnable pieces live under **`canary/c0/`**, each with its own `package.json` and exact pinned versions: `canary/c0/twilio-functions/`, `canary/c0/agent/`, `canary/c0/detector/`, `canary/c0/monitor/`, `canary/c0/provision/`.
- **The root `package.json`, lockfile, `ecosystem.config.cjs`, `.env.example`, `src/agent/voice-server.ts` and every production module are not touched.** Canary PM2 apps live in `canary/c0/ecosystem.c0.config.cjs` and are started only by name.
- Secrets live only in the git-ignored `canary/c0/.env.c0` (Carter supplies them). A committed `canary/c0/.env.c0.example` holds the names only. Nothing prints a secret. Logs are redacted.

## D3. Model integration

`GPTLiveModel({ model: 'gpt-live-1', delegation: 'responses', apiKey: <VOICE_C0_OPENAI_API_KEY> })` with **exactly two agent tools**, both validated by the C0 controller before anything happens:

- `record_service_request` writes a confirmed C0 intent to the outbox; no HCP.
- `request_transfer({ role: 'office' | 'backup' })` goes through the canary transfer adapter, which redirects the parent call via Calls API to `/fallback`. The model never sees a number.

No provider tools (web/file search, code interpreter). This deviates from the plan's literal "client-controlled delegation": client mode has no tool channel, so free-form speech could not be turned into a validated record without a second LLM of our own. Carter reviews this choice.

## D4. Delivery channel (C0 record-only)

- Durable local outbox (`src/agent/voice/outbox.ts`, path `data/c0/voice-outbox.jsonl`).
- A **redacted ntfy push** to a new canary-only topic, named by `VOICE_C0_NTFY_TOPIC`.
- An operator CLI view (`snapshot()`).

There is no HCP, no pending store, no poller, and no production ops helper import.

## D5. Transfer

This is the canary's own adapter: a Calls API redirect of the **parent** CallSid (from the `X-C0-Call` attribute) to `/fallback?role=…`. There is no SIP REFER. It uses a Restricted key scoped to `/twilio/voice/calls/update` (plus list/read for the detector). Destinations live only in Function environment variables.

## D6. Deadlines and limits (initial values; Carter can change them)

| Limit | Value |
|---|---|
| `<Dial timeout>` | 20 s |
| LiveKit `ringing_timeout` | 15 s |
| First audible response | 6 s after SIP answer (detector) |
| Silence | `userAwayTimeout` 15 s, then one check-in, then transfer |
| Max call | 8 min (trunk `max_call_duration` and `<Dial timeLimit>` 480 s) |
| Concurrency | 1 |
| Daily ceiling | 30 canary calls or 90 GPT-Live minutes, whichever comes first, then admission is denied and the kill switch is requested |
| Outbox retries | 5 attempts over 30 min, exponential backoff, then `human_reconciliation_required` |

## D7. Wording

Caller-facing exact wording (disclosure, emergency, fallback, voicemail) is played by Twilio `<Say>`, not by the model. The model persona must never say a request is booked. The standard line is "The office will review your request and contact you."

## D8. Process rules for workers

- Don't commit or push; the coordinator commits after an independent review.
- Make no calls to Twilio, LiveKit or OpenAI unless a task explicitly authorizes a named, read-only or dry-run step. Never read `.env*` files.
- Every new module gets a colocated `*.check.ts` (`node:assert/strict`, run with `npx tsx`).
