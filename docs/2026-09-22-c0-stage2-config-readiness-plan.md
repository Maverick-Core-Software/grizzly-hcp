# Grizzly LiveKit C0: Stage 2 configuration-readiness review and implementation plan

**Date:** 2026-09-22 · **Branch:** `barnscarter-ops/grizzly-livekit-c0-stage1` @ `8613c9e` · **Status:** review and plan only.

**Nothing was enabled, configured, deployed, routed, purchased, or called while preparing this.** No Twilio, LiveKit, or OpenAI account was accessed, and no `.env` or credential was read. Research used public vendor docs only.

**Inputs:**
- Stage 1 handoff: `docs/2026-09-22-grizzly-livekit-c0-stage1-handoff.md`.
- Seam audit §0–§14: `docs/2026-09-22-c0-voice-canary-seam-audit.md`.
- Approved canary plan (latest revision): `D:\Workspace\.codex\2026-09-22\livekit-gpt-live-canary-plan-approved-architecture\outputs\GRIZZLY-TWILIO-LIVEKIT-GPT-LIVE-1-CANARY-PLAN-APPROVED-ARCHITECTURE.md` (cited below as "plan §N").

**Research evidence:** two Hermes/DeepSeek lanes run through Orca produced `docs/2026-09-22-c0-stage2-research/twilio-subaccount-sip-fallback.md` and `.../livekit-gpt-live-config.md`. The load-bearing claims were rechecked directly against the vendor pages and are marked ✔ below. Anything still unconfirmed is marked **[U]**.

---

## 0. Readiness verdict

**Not ready to start Stage 2 cloud configuration.** The Stage 1 code is sound and inert. At `8613c9e` all eight C0 checks pass (re-run for this review), the tree is clean, and no outbox file was created. But three kinds of blocker remain:

1. **Owner and approval gates are all blank.** Every plan §12 checkbox and every [approval required] owner is unassigned. Plan §10 Stage 2 needs its own written canary-cloud approval before anything is created.
2. **One architecture decision the approved plan leaves open would break the kill switch if it goes the wrong way** (§1 below).
3. **Local prerequisites.** Plan §10 Stage 1 lists agent integration, deadlines, hard ceilings, CallSid mapping and an independent-fallback contract. None of these is in the delivered C0 code (§2 below). They are local-only work, but cloud configuration has nothing to point at until they exist.

---

## 1. Findings that change the configuration design

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | If a number has a `TrunkSid`, Twilio **ignores its voice URLs**. Setting `TrunkSid` also deletes `VoiceApplicationSid`, and the reverse is true too. | ✔ Twilio IncomingPhoneNumber resource: "If a `trunk_sid` is present, we ignore all of the voice urls…" | If the number is attached to an Elastic SIP trunk, the plan §6.2 kill switch (change only the canary number's Voice handler) does nothing. **The number must stay trunk-free and application-free, so the kill switch is a single `VoiceUrl` write.** |
| F2 | `VoiceFallbackUrl` fires only when Twilio can't retrieve or execute the TwiML. It does not fire when a SIP leg fails. | ✔ same page | The plan §6.1 fallback has to come from the `<Dial action>` callback (`DialCallStatus`), not from the number's fallback URL. |
| F3 | Username/password SIP authentication into LiveKit works on the TwiML `<Dial><Sip username password>` path. **Twilio Elastic SIP Trunking doesn't support it.** On the trunking path, source restriction needs `allowed_addresses`, which LiveKit support must enable per project. | ✔ LiveKit inbound-trunk docs | Plan §5.3 "authenticated/restricted ingress" can be met without a support ticket only on the TwiML path. |
| F4 | LiveKit's TwiML inbound path doesn't support SIP REFER (cold transfer). | LiveKit inbound-twilio docs (lane) | This doesn't block anything, because plan §2 already puts transfer in a **canary-owned adapter or Twilio fallback app**. Transfer happens by redirecting the parent call through Twilio's Calls API (`POST /Calls/{Sid}` with `Url`/`Twiml`) to the fallback app, not by SIP REFER. **[U]** Whether redirecting the parent call cleanly tears down the `<Dial><Sip>` child leg needs to be proven in the staff rehearsal. |
| F5 | Subaccount credentials can't reach the main account or sibling subaccounts. Main-account credentials *can* reach subaccount v2010 resources. Subaccounts use the main account's voice/SMS permissions. **Moving a number between accounts requires main-account credentials.** | ✔ Twilio subaccounts docs | The negative-authority proof (plan §2.1) is buildable from documented boundaries. Moving an existing number is a main-account action and becomes its own approval. Recommend a **new voice-only number bought inside the subaccount**, so no production Messaging/A2P registration is ever touched. **[U]** Whether 10DLC registration survives a move is a support-ticket question if a move is chosen. |
| F6 | Twilio has no "first audio" primitive. What it has: `<Dial timeout>` (5–600 s, plus a 5 s buffer, ending as `no-answer`), `<Sip statusCallbackEvent=initiated,ringing,answered,completed>`, and `<Dial timeLimit>`. | Twilio `<Dial>`/`<Sip>` docs (lane) | Pickup is bounded by Twilio itself (`<Dial timeout>`) and by LiveKit's trunk `ringing_timeout`. The first-audible-response deadline still needs the **independent detector** from plan §6.1: a separate service that redirects the call through the Calls API using a Restricted key limited to `/twilio/voice/calls/update`. |
| F7 | The `sip.twilio.callSid` / `sip.twilio.accountSid` attributes are documented only "if you're using Twilio SIP trunks". | ✔ LiveKit SIP-participant reference | **[U]** It's unconfirmed that the TwiML path fills these, and if it does, it is probably the *child* (`DialCallSid`) SID. Plan: put the parent CallSid into an `X-` header on the `<Sip>` URI and map it with trunk `headers_to_attributes`. Those attributes arrive **asynchronously**, so the agent waits for `participant_attributes_changed` up to a deadline and otherwise fails closed to transfer (plan §7). Also record `sip.ruleID`, `sip.trunkID`, `sip.callIDFull`, the room, and the participant identity. |
| F8 | A dispatch rule with no `trunk_ids` matches **every** inbound trunk in the project. | ✔ LiveKit dispatch-rule docs | Always bind `trunkIds` explicitly, and use a **dedicated LiveKit project** for the canary. |
| F9 | LiveKit and OpenAI don't enforce "one concurrent call". The Build plan allows 5 agent sessions, and free projects share limits. The only server-side time cap is the trunk's `max_call_duration`. | LiveKit quotas docs (lane) | The single-call lease, silence limit, first-audio limit and daily hard ceilings are all application-enforced (plan §5.3, §8), in the ingress webhook and the agent entrypoint. |
| F10 | GPT-Live has a **Node.js** plugin: `@livekit/agents` 1.9.0 + `@livekit/agents-plugin-openai` 1.9.0, class `openai.realtime.GPTLiveModel`, model `gpt-live-1`. It needs Node ≥ 20 (this PC runs v24.19.0). `delegation: 'client'` gives the model **no tool channel**. Delegated work arrives on `delegationCreated`, and replies go back through `appendCommentary`. | ✔ LiveKit GPT-Live guide | This fits C0's no-HCP boundary (plan §3.3). GPT-Live only works on `/v1/live/sessions`, so the Realtime plugin won't work. The plugin falls back to `OPENAI_API_KEY`; pass `apiKey` explicitly from a **canary-only env name** so a production key can never be picked up. |
| F11 | LiveKit's GPT-Live page requires "an OpenAI API key on an account with **GPT-Live alpha access**". OpenAI's model page lists normal tiers (the Free tier is unsupported). Pricing is $0.05/min voice plus backend tokens. Zero Data Retention is available on approval. | ✔ LiveKit guide; OpenAI docs (lane) | **Hard external gate:** confirm alpha access on the intended OpenAI project before any other work. The ZDR decision belongs to the plan §5.2 privacy gate. |
| F12 | LiveKit Cloud documents **no per-host outbound deny** for hosted agents. Build-plan agents can cold-start 10–20 s. | LiveKit deploy/firewall docs (lane) | The plan §4.2 runtime egress-deny evidence (HCP/CT102 denied) is only achievable with a **self-hosted agent worker** on a host where we control outbound rules. A self-hosted worker also removes the cold start that would eat the first-audio deadline. |

---

## 2. Local prerequisites: Stage 1 carry-overs that block Stage 2 (local only, no cloud)

Stage 1 is treated as done, as instructed. These items are the parts of the plan §10 Stage 1 list the delivered contracts don't yet cover. Cloud objects would have nothing to route to until they exist.

| # | Gap | Evidence | Fix |
|---|---|---|---|
| P1 | Caller wording contradicts plan §4.1 ("never say it was booked"). | `blocks.ts:101` "someone will confirm your appointment"; `:103` "someone will confirm it with you"; `:100` claims "I have recorded your details" before delivery is confirmed | Replace with the plan wording "The office will review your request and contact you." Add reviewed keys for the AI/recording disclosure (§5.2), emergency guidance (§5.1), and the deadline transition (§5.3). The copy gates still apply. **Note:** GPT-Live can't speak exact text (no TTS half-cascade; `appendCommentary` is paraphrased). Exact, legally reviewed wording therefore has to be played by **Twilio `<Say>`/`<Play>` before `<Dial>`** and in the fallback app, not by the model. |
| P2 | Idempotency key ≠ plan §7. | `c0-controller.ts:80` (`DEFAULT_TURN_REF='1'`), `:309` (`sha(correlationId,kind,turnRef)`) | Derive from `CallSid + intentSequence + payloadVersion`. The sequence is allocated only after caller confirmation. |
| P3 | The outbox lacks plan §4.1 retry state. | `outbox.ts:51-65`: no `human_reconciliation_required`, no next-attempt time, no retry bound | Add the status, `nextAttemptAt`, and a bounded retry policy as parameters. The count, window and backoff values stay [approval required]. |
| P4 | There's no CallSid↔LiveKit mapping record. | `transport.ts` plans data only; no grep hits for trunk/room/mapping | Add an append-only mapping store: parent CallSid, child SID, trunk, rule, room, participant, and state. Fail closed on anything missing or conflicting. |
| P5 | There's no single-call lease, no deadlines (first-audio, silence, max duration), and no daily hard ceiling. | not present in `src/agent/voice/` | Add pure policy and checks. Wire them into the ingress webhook and the agent entrypoint. |
| P6 | Nothing runnable exists yet: no canary ingress webhook (TwiML + signature validation), independent detector, fallback app, LiveKit agent worker, delivery-channel writer, or monitor process. | audit §10.3/§12 (no `c0-entry` process) | Build them locally with injected fakes. Each is a separate process and failure domain. Adding the dependencies (`@livekit/agents@1.9.0`, `@livekit/agents-plugin-openai@1.9.0`, `livekit-server-sdk@2.19.1`, Twilio SDK) is the separately approved, version-pinned change from audit §8.5. |
| P7 | The environment surface is closed at seven names. | `c0-config.ts:51-59` | Add canary-only names (for example `VOICE_C0_TWILIO_ACCOUNT_SID`, `VOICE_C0_TWILIO_API_KEY_*`, `VOICE_C0_LIVEKIT_*`, `VOICE_C0_OPENAI_API_KEY`). They must never be the production `TWILIO_*` names (`.env.example:27-29`). The existing check pins the list, so each addition is deliberate. |
| P8 | Static C0 proof (plan §4.2) for the new runtime pieces. | the audit's isolation scan covers only the eight current modules | Extend the scan to every new source and to the agent's dependency tree (no HCP, CT102, `from-voice`, pending, or poller reachability). |

**Gate:** an independent reviewer (not the implementer) accepts P1–P8 in writing. Plan §10's Stage 1 gate applies.

---

## 3. Stage 2 configuration plan (after its own written approval; ordered; each step canary-only)

Order follows plan §6.1: **the fallback exists before any primary route.** Every step records a redacted before/after snapshot.

1. **Baseline (read-only).** Capture the masked production number, its Voice and Messaging handlers, ConversationRelay health, the HCP/pending/poller owners, and the production SMS baseline (plan §2.1). *Owner: baseline owner plus an independent reviewer.*
2. **Twilio subaccount.** Create a dedicated subaccount. Inside it, create one Standard key for provisioning and Restricted keys scoped per component: the detector and transfer adapter get only `/twilio/voice/calls/update`, and the webhook gets only what it reads. Run the **negative-authority test**: subaccount keys must fail on the parent's `IncomingPhoneNumbers` (list and update) and on `/Accounts`, and succeed only on the canary resources. Record pass/fail as non-2xx plus no state change. **[U]** The exact denial codes are undocumented. (F5)
3. **Canary number.** Buy a voice-only number **inside the subaccount** (needs the purchasing-owner approval, plan §2.1). Keep `TrunkSid` and `VoiceApplicationSid` empty and leave the Messaging URL unset. Snapshot every `voice_*`/`sms_*` field. (F1, F5)
4. **Independent fallback app first.** A TwiML app owned by the subaccount (Twilio Functions/TwiML hosted in Twilio, so it's outside our failure domain). It plays reviewed copy, screen-transfers to the office destination, tries the backup on decline or no-answer, then records voicemail/callback. The destinations are held by the controller and the app, never by the model. **Point the number's `VoiceUrl` here first.** The number now fails safe to humans before LiveKit exists. (plan §6.1)
5. **Ingress webhook and detector (our hosts, separate processes).** The webhook validates `X-Twilio-Signature` using **all** received parameters and the subaccount token. It takes the single-call lease; plays disclosure and emergency copy with `<Say>`/`<Play>`; then returns `<Dial action=<fallback> timeout=N timeLimit=M answerOnBridge=true><Sip username password statusCallback=<detector> statusCallbackEvent="initiated ringing answered completed">sip:…;transport=tls?X-C0-Call=<CallSid></Sip></Dial>`. The detector redirects the call to the fallback app if the first-audio or controller-success signal is late. It does not depend on the controller or LiveKit. (F2, F6)
6. **LiveKit (dedicated project).** Inbound trunk: `numbers=[canary DID]`, `auth_username`/`auth_password` matching the `<Sip>` credentials, `allowed_numbers=[staff testers]`, `headers_to_attributes={X-C0-Call: c0.callSid}`, `ringing_timeout`, `max_call_duration`, and `media.encryption` chosen with the TLS decision. Dispatch rule: **explicit `trunkIds`**, `hidePhoneNumber:true`, `inboundNumbers=[staff testers]`, `roomConfig.agents[{agentName:"grizzly-c0-canary"}]`. Keys: `sip.admin` for provisioning only; the runtime key gets no admin or recording grants. (F3, F7, F8)
7. **OpenAI (dedicated project).** Confirm GPT-Live alpha access. Use a project key with an expiry, stored only under the canary env name. Settle ZDR/retention under the privacy gate. Set the safety identifier to a hashed CallSid. (F10, F11)
8. **Agent worker (self-hosted).** Run it as its own process with an outbound allowlist: LiveKit, OpenAI, and the C0 delivery channel only. Produce redacted **egress-deny evidence** that HCP and CT102 are unreachable (plan §4.2). The entrypoint checks `sip.trunkID`, `sip.ruleID`, the C0 mapping attribute and the lease, and calls `ctx.shutdown()` if any is wrong. `GPTLiveModel({ delegation:'client', apiKey })` with no tools. `voiceOptions.userAwayTimeout` covers silence. (F9, F10, F12)
9. **Primary route last.** Change the canary `VoiceUrl` from the fallback app to the ingress webhook. Diff the snapshot: only `voice_url` changed, and `sms_*` is byte-identical. **The kill switch is the reverse of this single write.** (F1, plan §6.2)
10. **Stop.** Configuration complete does **not** authorize a call. The staff-only rehearsal needs its own separate written approval (plan §10 Stage 2). It must cover: ingress rejection without credentials; pickup timeout leading to fallback; missing first audio leading to detector redirect; a call-redirect teardown test (F4 [U]); kill-switch time-to-effect; stale-outbox alert with no write; idempotency and reconnect; the hard ceiling; and unchanged production and SMS.

**Rollback at any step:** set the canary `VoiceUrl` back to the fallback app. Never route to ConversationRelay (plan §11.4). Delete LiveKit and OpenAI canary objects only with written direction.

---

## 4. Decisions needed from Carter or the named owners

1. **Ingress path:** TwiML `<Dial><Sip>` (recommended: it keeps the one-field kill switch, SIP authentication and `<Dial action>` fallback; F1–F4) or Elastic SIP Trunking (needs a support ticket for `allowed_addresses` and breaks the `VoiceUrl` kill switch).
2. **Number:** buy a new voice-only number in the subaccount (recommended), or move an existing one (a main-account action, with the 10DLC question).
3. **Hosts:** where the ingress webhook, detector, agent worker and stale-outbox monitor run. They need public HTTPS for Twilio webhooks, separate failure domains, and outbound control on the agent host. An AIWA/Proxmox host brings in the AIWA runbook and the Orca-only rules.
4. **Plans and accounts:** a paid vs Build LiveKit project (Build shares free limits and cold-starts), and OpenAI GPT-Live alpha access and tier.
5. **All plan §12 owners:** baseline, purchasing, business, C0 delivery (plus backup), monitor, safety, privacy/legal, technical, transfer-destination, kill-switch operator (plus backup), cost, and an independent reviewer who is distinct from the implementer.
6. **Open values:** retry count/window/backoff; SLA and escalation; first-audio, silence and max-duration deadlines; daily ceilings; kill-switch time-to-effect target (proposed ≤ 60 s); retention and ZDR.

---

## 5. Authorization recorded (2026-09-22, Carter, in chat)

- Carter **created the dedicated Twilio canary subaccount himself** and **purchased a LiveKit membership**. Neither was created by an agent.
- Carter directs the build to proceed **as fast as possible**: finish the §2 local prerequisites, do the §3 canary-only configuration and wiring, and enable the canary. Work continues without further check-ins, unless an answer from Carter is strictly necessary, until the canary is **ready for Carter to review and to listen to a live staff rehearsal**. The rehearsal call itself happens with Carter.
- The orchestrator (Claude) delegates the implementation to Orca agents and does not write the code itself. The reviewer of each change is a different agent from its implementer.
- **Unchanged by this authorization:** the production number, production Voice/SMS handlers, `voice-server.ts`/ConversationRelay, HCP, CT102, the pending store and poller, Proxmox/AIWA production, and every production PM2 app. Credentials are supplied by Carter and are never printed or committed. Any number purchase is confirmed with Carter first.

## 6. Verification performed for this review

- All eight `npx tsx src/agent/voice/*.check.ts` checks exit 0 at `8613c9e`. `git status` is clean, and `data/voice-outbox.jsonl` is absent.
- The vendor claims marked ✔ were fetched directly from twilio.com/docs and docs.livekit.io on 2026-09-22.
- No external system was touched. The research lanes were limited to public docs; both of their Orca terminals were closed afterwards.
