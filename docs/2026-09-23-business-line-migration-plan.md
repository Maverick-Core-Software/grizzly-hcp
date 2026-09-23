# Business-line migration plan: +1 469-896-3862 onto gpt-live-1 + LiveKit (hosted on AIWA)

**Date:** 2026-09-23 · **Branch:** `barnscarter-ops/grizzly-livekit-c0-stage1` (plan written on top of `102bc6a`) · **Status:** PLAN ONLY.

Nothing was built, provisioned, routed, deployed or restarted to produce this plan. HCP was not touched, and neither were AIWA, the canary routing or the production number. Four read-only research lanes and a few read-only API reads (§0) are the only actions taken. Their full reports are committed beside this doc in `docs/2026-09-23-migration-research/`, with SIDs and non-business numbers masked:
- `A1-prod-voice-inventory.md`: production voice-server at `dc31c9b`
- `A2-c0-agent-inventory.md`: C0 agent at `102bc6a`
- `B-aiwa-governance.md`: AIWA runbooks, Proxmox inventory, gateway-autofix, line check
- `C-pi-execution-model.md`: Pi team launch facts

**Evidence markers used below:**
- **[R]** read in source or docs at the cited path:line.
- **[O]** observed through a read-only call today.
- **[I]** inferred.
- **[U]** unverified, with a named owner in §9.

**Precedent.** This plan follows the C0 precedent (`docs/2026-09-22-c0-stage2-config-readiness-plan.md` and build decisions D1–D8). Where production must differ from D1–D8, §3.1 says so explicitly as PD1–PD12.

---

## 0. Verified current state (read-only, 2026-09-23)

### 0.1 C0 canary DID …2642 (Twilio subaccount): **it is on the new flow, but no call has exercised it yet**

Carter believes the canary is already on the new flow. **Confirmed, with one caveat:**
- It is wired to the new flow and enabled.
- Only the one allow-listed staff caller can reach the agent.
- The data root shows no call has passed agent admission yet.
- The rehearsal (`canary/c0/REHEARSAL.md` A–H) is unsigned.

| Field (GET IncomingPhoneNumbers, 18:34:37Z) [O] | Value |
|---|---|
| account / number SID | `AC9b…b8db` (subaccount "Grizzly LiveKit GPT-Live Canary") / `PN89…3f17` |
| friendly_name | **"Gateway Autofix Canary"**. The label came with the number when it moved from the main account on 09-22; origin in §9 Q12. |
| voice_url / method | `https://grizzly-c0-canary-5889-production.twil.io/ingress` / POST (this is the new flow) |
| voice_fallback_url | `null` (by design: C0 fallback comes from `<Dial action>`, per readiness F2) |
| status_callback, voice_application_sid, trunk_sid | all `null`, so the one-field kill switch works (readiness F1) |
| sms_url | `""` |
| date_updated | 2026-09-23 03:25:22Z. This was the GO-LIVE route write from `/fallback` to `/ingress` (evidence `canary/c0/provision/evidence/2026-09-23T03-25-23-292Z-twilio-number-route.json`). |

**What `/ingress` does** (`canary/c0/twilio-functions/functions/ingress.protected.js:5-36`) [R]:
1. Callers outside `C0_ALLOWED_CALLERS`, or with no lease, are sent to `/fallback`.
2. Otherwise it plays `<Say>` disclosure and emergency copy.
3. Then it dials `<Dial action=/dial-action timeout=20 answerOnBridge timeLimit=480><Sip user/pass>` to the LiveKit trunk.

**Supporting state:**
- `VOICE_C0_ENABLED=true`: a single key was read from `canary/c0/.env.c0` [O].
- LiveKit (`lk` CLI, project `grizzly-c0-canary`) [O]:
  - Trunk `ST_vh3D…` "grizzly-c0-canary-inbound": 1 number, 1 allowed caller, digest auth, **Encryption DISABLE**, header `X-C0-Call=c0.callSid`.
  - Dispatch rule `SDR_gkGj…`: individual per caller, bound to that trunk, agent `grizzly-c0-canary`.
- `pwsh -NoProfile -File canary/c0/c0ctl.ps1 status all` [O]:

  | Process | State | Supervisor PID | Uptime | Restarts |
  |---|---|---|---|---|
  | agent | running | 42628 | 15 h | 0 |
  | detector | running | 47072 | 15 h | 0 |
  | monitor | running | 14408 | 15 h | 0 |

- `data/c0/` holds no outbox, answered, first-audio or usage files, so no call has passed admission (A2 §4.1) [O].

### 0.2 Production DID …3862 (main account): old voice-server, **no fallback set**

| Field (same read) [O] | Value |
|---|---|
| account / number SID | `AC08…79ed` ("Grizzly Electrical") / `PNc8…1d3b` |
| voice_url / method | `https://aiwa.tailf72e3f.ts.net:10000/twiml` / POST. Old voice-server: ConversationRelay plus Venice/z.ai LLM behind Tailscale Funnel. |
| voice_fallback_url | `""` (**not set**) |
| status_callback, voice_application_sid | `""` |
| trunk_sid | `null` |
| sms_url | `https://aiwa.tailf72e3f.ts.net/customer/webhook/twilio` (Funnel `/customer`; **out of scope, unchanged**) |
| date_updated | 2026-08-23 04:41:22Z |

This confirms Carter's description.

The gateway-autofix `voice_fallback_url` that Carter expects to "stay in place" is **built but was never applied**:
- It is Twilio Functions `grizzly-fallback`, domain `grizzly-fallback-8197-dev.twil.io`.
- It lives on the unpushed branch `barnscarter-ops/twilio-fallback` of Hermes-Supervisor.
- Its `STATUS.md` has read `BLOCKED-NEEDS-CARTER` since 09-20 10:24 (B §3.2–3.4) [R].
- This plan therefore makes applying it an explicit pre-cutover step (§5 step C1).

### 0.3 Facts that change the premises

1. **"The AIWA container" is the Proxmox host itself.**
   - `/opt/grizzly-hcp` runs under host-root PM2 on node `aiwa` (192.168.1.12). It is not in an LXC [R] (B §0.1; `Hermes-Supervisor/docs/2026-08-31-helm-lanes-findings.md:25,32`).
   - The governing runbook says host root is for "host responsibilities only" (`brain/agent-memory/runbooks/aiwa-deployment.md:15-16`).
   - PLAN2 names **CT103 `mcc-prod`** as the production voice target, "last, after a dedicated readiness review" (`Hermes-Supervisor/PLAN2.md:83`).
   - This plan hosts the new stack in **CT103** (PD6). Keeping it on host root would need Carter's recorded exception (§9 Q1).
2. **The new path removes Tailscale Funnel from voice entirely.**
   - The path becomes: Twilio → Twilio-hosted Function → `<Dial><Sip>` → LiveKit Cloud → agent worker connecting *outbound* from CT103.
   - No inbound port on AIWA serves voice, so the tailscaled Funnel drop class (#21114/#18181; the 64102 missed calls of 09-22) leaves the voice path.
   - Funnel remains only for SMS, and for the rollback target during coexistence.
3. **C0 build-decisions D1 line 25 is wrong.**
   - It says production is behind "a Proxmox-hosted Cloudflare tunnel".
   - Production is behind Tailscale Funnel `:10000` (§0.2 plus B §5.4). PD1 supersedes it.
4. **The C0 agent's delivery is a dead end.** Its outbox (`data/c0/voice-outbox.jsonl`) has no consumer, and records are stored unredacted (A2 §2 row 3) [R]. Production parity needs a real delivery worker (WP-C).
5. **The C0 agent is not outbound-only.**
   - It listens on `0.0.0.0:<random>`, the LiveKit Agents 1.9.0 default health/`/worker` server (A2 §4.3) [O][R].
   - Production must bind to `127.0.0.1` on a fixed port (PD8).
6. **Production-guard evidence hygiene.**
   - The two C0 guard snapshots have different hashes for all 4 parent numbers and no `comparison` block (A2 §5 item 23) [O].
   - Before any production step relies on the guard, take a fresh baseline plus `--compare`.

---

## 1. Parity inventory: every capability a caller gets today

- **Source of truth:** `dc31c9b`, the commit AIWA runs (with uncommitted prod edits to `data/employee-phones.json`, `ecosystem.config.cjs` and `package-lock.json` [R]).
- **Entry point:** `src/agent/voice-server.ts` `POST /twiml` (`:180-193`), `<Connect action=/handoff><ConversationRelay …>`.
- **LLM:** a fresh Mastra agent per turn, Venice `zai-org-glm-5-2`, with z.ai fallback. It is **non-streaming**, so there is dead air during tool calls.
- **Actions:** every side-effecting action comes from inline blocks (`[BOOKING_REQUEST]`, `[MESSAGE]`, `[RESCHEDULE]`, `[TRANSFER]`) parsed by the server (`voice-server.ts:333-419`). The LLM has only 4 read tools (`src/agent/resolver.ts:6-11`).
- **Full detail:** A1 §1–§5 (44 rows, each cited).

**Rule:** every row is carried unchanged, carried with a listed improvement, or explicitly waived by Carter in §8. Nothing is silently dropped. The "C0 today" column cites `canary/c0` at `102bc6a`.

| # | Capability (A1 row) | What the caller gets today | C0 today | Must build (WP) |
|---|---|---|---|---|
| 1 | Answer + AI disclosure greeting (2,3) | "Thanks for calling Grizzly Electrical! This is Maverick, the automated assistant. How can I help you today?" (`voice-server.ts:50`) | **done**, different wording: Twilio `<Say>` disclosure + emergency notice, then GPT-Live greets (`c0.private.js:5-6`) | Production copy: disclosure plus a short Grizzly greeting, played by `<Say>`/`<Play>` (D7), then the model continues. The two-voice seam (Twilio voice, then GPT-Live `marin`) is Carter decision §9 Q5. (WP-A, WP-B) |
| 2 | TTS voice (4) | Env-driven (`VOICE_TTS_*`). Prod `dc31c9b` lacks the 9195ff9 ElevenLabs fix; safe only if `.env` overrides [U] | GPT-Live voice (plugin default `marin`, not pinned) | Pin the voice explicitly and have Carter pick it at the gate (WP-B) |
| 3 | English STT, barge-in (5,6) | en-US, barge-in on; interrupts ignored server-side | GPT-Live native, barge-in native | Carry. Language stays English (no Spanish today). (WP-B) |
| 4 | DTMF (7) | Enabled but ignored | none | **Carried as none.** Nothing lost. |
| 5 | Speech style rules (8) | Short, warm, one question at a time, under 40 words, natural numbers, asks to repeat (`resolver.ts:71-77`) | Minimal "canary intake" persona (`worker.ts:18`) | Port `VOICE_INSTRUCTIONS` (`resolver.ts:67-149`) into GPT-Live instructions (WP-B) |
| 6 | Conversation memory (10) | 30-message window, lost on restart | Native session context | Carry, since GPT-Live keeps session state (WP-B) |
| 7 | Caller-ID awareness (11) | Caller number injected, "is this the best number?" (`voice-server.ts:324`) | Parent `From` fetched for the allowlist only (`caller.ts:8-20`) | Pass the verified caller ID to the controller. The model is told it is present, but numbers are never spoken back in full. (WP-B) |
| 8 | Office-hours awareness (12) | M-F 8-6, Sat 8-2, Sun closed, Central; no holidays (`office-hours.ts:6-21`) | missing | Controller supplies open/closed and hours text. Holiday calendar is optional, §9 Q8. (WP-B) |
| 9 | Company knowledge Q&A (13) | RAG `/ask` on `192.168.1.12:8181` (`rag.ts:69-94`). **Leak risk:** may return other customers' records | missing | `search_knowledge` tool through the controller with a **server-side filter that drops `[CUSTOMER]` records** (improvement) (WP-B) |
| 10 | Price ranges (14) | "Typically runs between X and Y… confirmed on-site"; never a firm price (`rag.ts:18-53`) | forbidden | `search_pricebook` and `lookup_pricing` tools through the controller. A range-only guardrail is enforced in the tool result shape. (WP-B) |
| 11 | Booking intake (15) | Name, callback, address (house # + street + city), optional email, optional lead source, issue, 2-3 windows. Ends with "You're all set. We'll confirm one of those times with you within the next business day." **The line is spoken regardless of success.** | `record_service_request` (name, callback, address, scope, windows); **email refused** by the free-text PII rule (`c0-controller.ts:335-346`) | Typed `record_booking_request` tool with an explicit email and lead-source field. The confirmation line is spoken **only after the durable outbox append succeeds**, and the wording is Carter-approved (§9 Q6). (WP-B) |
| 12 | Booking → HCP chain (16) | Geocode (Census), customer find/create, address reuse/add, estimate, lines, note with SCHEDULE instructions, assign Carter + Jaime with push, pending row, ops alert (`from-voice.ts:219-381`) | missing (outbox only) | HCP delivery worker (WP-C, §2) |
| 13 | Line items (17) | Service Fee always, plus Troubleshoot L1/L2 by regex or a pricebook match; $0 "NEEDS PRICING" otherwise (`booking-line-items.ts:114-208`) | missing | Reuse `booking-line-items.ts` unchanged (WP-C) |
| 14 | Price-concern 50% discount (18) | Silent; the office sees a discount line (`booking-line-items.ts:241-259`) | missing | Carry: a `priceConcern` flag on the booking tool (WP-B/WP-C) |
| 15 | Address normalization/dedupe (19) | House # + zip5 + unit reuse (`estimates.ts:350-376`) | missing | Carry (WP-C) |
| 16 | Existing-customer match (20) | **Name only, first hit.** A failed search creates a duplicate customer (`estimates.ts:320,328-330`) | missing | Improvement: match on phone first, then name. A search *failure* fails the step and never creates a customer (§2.3). Needs Carter approval, §9 Q7. (WP-C) |
| 17 | Message taking (21) | "Got it. I'll pass that along right away." → HCP estimate shell + note + push. **No ops alert on success** (`from-voice.ts:212`) | partial (outbox record only) | `record_message` tool, HCP shell via WP-C. Improvement: a Slack/SMS ops alert on every message. (WP-B/WP-C) |
| 18 | Appointment lookup, own jobs (22) | Verify by phone + last name, or name + house # + street; read back up to 5 **scheduled** jobs (`voice-lookup.ts:93-169`) | missing | `lookup_my_appointments` through the controller, with the same verification rule, read-only via hcp-mcp `hcp_api_get` (WP-B, §2) |
| 19 | Estimate status lookup (23) | **Promised by the persona, not implemented** | missing | Decide: implement it (read-only estimates in the lookup) or remove the promise. §9 Q9. (WP-B) |
| 20 | Reschedule request (24) | Verify, collect 2-3 windows → HCP shell with RESCHEDULE note. **Bug:** always `needs_address_review` | missing | `record_reschedule` tool that carries the verified job's address. Fix the always-unverified bug. (WP-B/WP-C) |
| 21 | General transfer, office open (25) | Name + reason → screened dial: whisper "Grizzly call from {name}, about {reason}. Press one", 25 s, then the other person (`voice-server.ts:115-128,215-240`) | Role-only `office`/`backup` roles; whisper "Grizzly canary call" with no context (`whisper.protected.js`) | `request_transfer({kind, target?, callerName, reason})`. The controller resolves target by name or geography (default Carter). The Function whisper carries name + reason. The model never sees numbers. (WP-A/WP-B) |
| 22 | After-hours transfer → message (26) | Code backstop turns it into a MESSAGE (`voice-server.ts:356-370`) | missing (fallback rings humans 24/7) | Controller enforces hours: after-hours general transfer becomes `record_message`. The Function fallback is hours-aware (§9 Q10). (WP-A/WP-B) |
| 23 | Emergency (27) | Fire/smoke → "hang up and call 911", no transfer. Other hazards → ask city → **direct 24/7 dial, no whisper**, geography routing NE→Jaime, S→Carter. Can land in personal voicemail. | partial: 911 notice only | `request_transfer({kind:'emergency', city})` → Function emergency dial with the same routing. Whether emergencies keep no-whisper is Carter decision §9 Q11. (WP-A/WP-B) |
| 24 | Transfer fallback chain (28) | First no-answer → "Still connecting you" → other person | **done** (office→backup) | Carry with Carter/Jaime roles (WP-A) |
| 25 | Both unreachable (29) | Spoken give-up message. **Only a jsonl line; no alert, no HCP record** | Voicemail `<Record>` + ntfy alert | Improvement: voicemail plus a Slack/SMS alert with a recording link, plus an HCP message shell. §9 Q10. (WP-A/WP-C) |
| 26 | Payment refusal, privacy rules, out-of-scope → message (30-32) | Persona rules (`resolver.ts:143-149`) | partial | Port them into instructions. The privacy rule is also enforced in tool results (row 9). (WP-B) |
| 27 | LLM/agent error line (33) | "I'm having a little trouble on my end… we'll call you right back." | Greeting error → transfer; **no mid-call model-drop handler** (A2 §5 C7) | Add a session error/close handler: transfer to humans (or voicemail after hours). Never silence. (WP-B) |
| 28 | Pipeline failure alerting (34) | `failed_needs_manual` row + FAILED alert with stderr tail | outbox monitor "stale" ntfy only | WP-C delivery worker: `failed_needs_manual` plus a Slack #ops-alerts alert (SMS fallback) (§2.4) |
| 29 | Booking/reschedule ops alert with SCHEDULE hint (35) | ntfy + ops SMS including `Reply: SCHEDULE <id> …` | missing | Carry the text; channels move to Slack first with SMS fallback, the same policy as the watchdog (WP-C) |
| 30 | SCHEDULE approval → HCP appointment (36) | `booking-approval-poller` (60 s) acts on an HCP note or ops-SMS `SCHEDULE …` | missing | Second poller instance on the new store, with SMS id required (§2.5). (WP-D) |
| 31 | SMS to the caller (37) | **None today** | none | **Carried as none.** Nothing lost. |
| 32 | Call recording / voicemail (38) | None | Voicemail only | Voicemail carried as an improvement (row 25). No full-call recording (§9 Q13). |
| 33 | Transcripts / logs (39) | Console + `data/audit.jsonl` (first 120 chars) + `voice-messages.jsonl`; `ops-digest` reads these (`ops_digest.py:500-505`) | Redacted launcher logs; buffered until exit | Structured, redacted per-call log and audit records in an ops-digest-compatible shape (WP-C/WP-G1) |
| 34 | Spam/robocall, call/silence limits (40,41) | **None** | Silence check-in then transfer; 480 s cap; daily ceilings | Carry the C0 limits with **production values** (PD9), fixing the 480 s race (A2 §5 C8). Spam filtering is not added (none today). (WP-B) |
| 35 | Employee callers (42) | Not special on voice | 4-layer staff allowlist | Production admission modes: `staff-only` for staging, `open` for customers (PD5) (WP-A/WP-B/WP-E) |
| 36 | Security of webhooks (43) | **Unsigned `/twiml`, `/handoff`; unauthenticated WS** | Functions `*.protected.js` validate the Twilio signature | Carry C0 (an improvement). No public endpoint on our infrastructure. |
| 37 | Twilio-level failure handling (44) | None. 64102 = silent missed call. Watchdog live since 09-23. | `<Dial timeout>` / `/dial-action` / detector: humans-first | Carry C0 plus gateway-autofix `voice_fallback_url` (C1) plus watchdog re-pointed (WP-G2) |
| 38 | Health endpoint (1) | `GET /health` on :8765 (line check reads it) | Agent default 0.0.0.0 random-port health | Bind `127.0.0.1:<fixed>` plus a unit health check (WP-B/WP-F) |
| 39 | Concurrency (implicit) | Unbounded (async per WS) | **1 call** (Sync lease + room count) | Production: N concurrent calls, lease per CallSid, not global (PD9) (WP-A/WP-B) |
| 40 | SMS line (secondary) | Funnel `/customer`. The actual serving process is [U]: `SERVICE-MATRIX.md:38` says `hermes-customer-sms` :3014; `customer-chat-server.ts` defaults to :3012 | n/a | **Out of scope; unchanged.** Every routing write asserts `sms_*` is byte-identical. |

**Gate for §1:** the practice-call gate (§4) must exercise every row that has a caller-facing effect. Anything still missing at gate time fails the gate.

---

## 2. HCP integration design

### 2.1 Boundary (binding)

- **HCP-lite only.** Carter's standing rule is that customer-facing voice never gets Proxmox, and that HCP access is limited (global CLAUDE.md "AIWA / Proxmox split").
- **The model never calls HCP.** It calls controller tools. The controller validates each call and either answers read-only queries or appends a typed, idempotent intent to a durable outbox. This is the C0 shape (D3), extended.
- **Path:** hcp-mcp on CT102 (`HCP_MCP_URL`, CT102 :7332). A **dedicated token scoped to the voice tool subset** is used, per PD7.
- **No cookie-jar writes.** Two production writes still use the HCP login cookie today (A1 §3). Both are replaced:
  - the note fallback on `-32602`
  - the poller's confirmation note

  They move to hcp-mcp `update_estimate_notes`. If that tool is absent from the hcp-mcp surface ([I] A1 §3), adding it is WP-C's prerequisite (a CT102 change, approval §8 P9). Otherwise the delivery worker keeps the cookie jar plus the main-branch keepalive `9063f42`, and §9 Q14 decides.

### 2.2 Calls the new stack makes

**Reads** happen during the call, through the controller, with a timeout of ≤ 4 s each:

| Purpose | hcp-mcp tool | Notes |
|---|---|---|
| Appointment lookup | `hcp_api_get` → `/alpha/customers?q=`, `/alpha/jobs?customer_id=&work_status=scheduled` | Same as production (`voice-lookup.ts:70-84`) |
| Estimate status | same, estimates | Only if §9 Q9 says to implement it |

**Writes** happen after the call ends, in the delivery worker. Each is checkpointed:

| Step | hcp-mcp tool |
|---|---|
| find customer | `search_customer` |
| create customer | `create_customer` |
| address dedupe / numeric id | `hcp_api_get` |
| add address | `add_customer_address` |
| create estimate | `create_estimate` |
| lines | `add_line_item` |
| note | `update_estimate_notes` |
| assign + push | `assign_technician` |

Other dependencies: Census geocoder, RAG `/pricebook/search` (192.168.1.12:8181), and `data/pricebook.csv`.

### 2.3 Idempotency and duplicate-booking guards

- **Intent key:** `sha256(parentCallSid + intentKind + intentSeq + payloadVersion)`, where `intentSeq` is allocated only after the caller confirms (readiness P2).
  - The key is **persisted per call** in the outbox, not held as a per-process counter.
  - This fixes C0's in-memory `intentSequence` (A2 §5 C11) and production's lack of any callSid check (A1 §3).
- **Step checkpoints:**
  - After each HCP write, the worker records the returned ids (customer, address, estimate, lines, note, assign) in the outbox record before starting the next step.
  - A retry resumes from the last checkpoint and never re-creates.
  - This fixes production's "partial writes stay; manual retry duplicates" (A1 §3).
- **Pre-create probe:** before `create_estimate`, the worker searches the customer's recent estimates for the intent-key marker in the note text. If found, it adopts that estimate. This makes the step safe even if a checkpoint write was lost after a successful HCP call.
- **Search failure is a failure.** `search_customer` errors fail the step and schedule a retry. They never create a customer. This changes production behaviour (`estimates.ts:328-330`); see §9 Q7.
- **One writer:** exactly one delivery worker per store, enforced by a lock file with a unit-level single instance.
- **Retries:** C0 D6 policy applies, 5 attempts over 30 min with exponential backoff, then `human_reconciliation_required` plus an alert.

### 2.4 What a failed HCP call sounds like, and what gets logged

| Failure | Caller hears | Logged / alerted |
|---|---|---|
| **Read** failure or timeout (lookup) | "I can't pull that up right now. Let me take your name and number and have the office call you." Then the `record_message` flow. | Redacted audit record with `lookup_unavailable` |
| **Write** failure | Nothing, because writes happen after the call. During the call the caller hears only the confirmation line, which is spoken *after* the durable outbox append succeeds. If the append fails, the caller hears "I'm having trouble saving that. Let me connect you with the office" and is transferred (or sent to voicemail after hours). | Row `failed_needs_manual` with the redacted error class. #ops-alerts alert "Voice {kind} FAILED — {name} …" with the full callback number (the channel is private, as the watchdog precedent established), SMS fallback. The alert is repeated at `human_reconciliation_required`. |

Logs are redacted per call to JSONL (room, masked CallSid, intents, tool outcomes, timings). They never include full numbers or addresses. Raw PII lives only in the 0600 outbox and the HCP record.

### 2.5 Pending store and poller coexistence

- **Old path (the rollback target, untouched):**
  - store: `/opt/grizzly-hcp/data/pending-bookings.jsonl`
  - host-root PM2 `booking-approval-poller`
- **New path:**
  - store: `/var/lib/voice-prod/pending-bookings.jsonl` in CT103
  - a second poller instance, WP-D, built from the existing `deploy/ct103/booking-approval-poller.service` template on main `ac42ac9`
- **Hazard:** both pollers read the same ops-SMS inbox. A `SCHEDULE` reply **without an estimate id** is accepted when exactly one row is pending (`approval-poller.ts:107-118`), so the two pollers could each act on a different row [R].
- **Guard:**
  - The new poller runs in **id-required mode**: it ignores id-less SMS replies and acts only on ids in its own store.
  - HCP-note SCHEDULE commands are safe, because each poller reads notes only for estimates in its own store.
  - The old poller is not changed.
- **Downstream readers:** the ops digest and the watchdog must read the new store and logs (WP-G1, WP-G2).

---

## 3. Hosting on AIWA

### 3.1 Production build decisions (PD1–PD12)

These are binding for every work package. They are C0 D1–D8, amended for production.

| # | Decision | Relation to C0 |
|---|---|---|
| **PD1** | **Topology:** Caller → …3862 (main account; VoiceUrl → new Twilio Serverless service `grizzly-voice-prod` `/ingress`; TrunkSid and VoiceApplicationSid stay empty) → `<Say>` copy → `<Dial action=/dial-action timeout answerOnBridge timeLimit><Sip tls user/pass>` → LiveKit Cloud production project → dispatch → self-hosted agent worker in **CT103**, **outbound only**. Humans-first fallbacks run entirely in Twilio Functions. | D1, with the Cloudflare statement corrected |
| **PD2** | **The number stays in the main account.** It is not moved to a subaccount: SMS/10DLC is live on it (readiness F5 [U]), and the line check, watchdog and Monitor queries all read the main account (B §4.4.5). The Functions service is created in the main account. | Deviates from C0's subaccount isolation. The risk is covered by PD3. |
| **PD3** | **Routing writes are single-field.** Every write to …3862 is done by a script that snapshots before and after, refuses if a trunk or application is attached, and asserts that **only `voice_url` changed**, with `sms_*` and `voice_fallback_url` byte-identical. The one exception is step C1, which writes `voice_fallback_url` under its own approval. | D1/F1 kill-switch rule |
| **PD4** | **Code layout:** production runnables live under `voice-prod/`, with separate packages and pinned versions, reusing the `src/agent/voice/*` core and `src/automations/bookings/*` (booking-line-items, geocode, contact-normalize) by import. `voice-server.ts`, `ecosystem.config.cjs` and the host-root PM2 apps are **not modified**; the old stack is the rollback target. | D2, extended to production reuse |
| **PD5** | **Admission modes**, controlled at the Function *and* the agent: `staff-only` (the allowlist; everyone else goes to humans), then `open`. A separate `probe` policy applies to the line-check number (ops line …1546): it is admitted to the agent and flagged, and is **never forwarded to a human**. The LiveKit trunk `allowed_numbers` is cleared only at the step-C5 approval. | D1 allowlist, extended |
| **PD6** | **Placement:** CT103 `mcc-prod` (4c/8G, about 0.34 GB used) hosts the agent, detector, monitor, delivery worker and new poller. The sandbox is **CT101** (`aiwa-orca`) first. Host root is used for nothing new. | Resolves readiness §4.3 |
| **PD7** | **Secrets:** one EnvironmentFile per service under `/etc/maverick-integrations/`, owned by the service user, mode 0600, with no shared `.env` (`SECRETS-MATRIX.md:3`). Production-only keys: LiveKit runtime key (no admin), OpenAI production project key, Twilio **Restricted** key limited to calls update/read and Sync, and an hcp-mcp token scoped to the voice tools. Provisioning keys are never on AIWA. | D2/D5, fixing C0's Standard-key deviation |
| **PD8** | **Supervisor:** systemd, one unit per service, `Restart=on-failure` with a bounded burst, `TZ=America/Chicago`, `MemoryMax=` and `CPUQuota=` (PD10), agent health on `127.0.0.1:<fixed>`. Not PM2 and not c0ctl. | D1 (C0 used c0ctl on Windows) |
| **PD9** | **Production limits** (Carter sets the values in §9 Q4): Dial timeout 20 s; ringing 15 s; first audio 6 s (detector); silence 15 s then one check-in then transfer; max call 10 min, with the agent timer started *before* bridge time so the transfer fires before Twilio's `timeLimit` (fixing A2 §5 C8); concurrency N (proposed 3); daily ceilings proposed 150 calls / 600 GPT-Live min, after which admission becomes humans-first plus an alert. | D6 |
| **PD10** | **Resource caps** (proposed; CT103 is 4c/8G): agent `MemoryMax=2G CPUQuota=200%`; detector, monitor and poller `256M/25%` each; delivery worker `512M/50%`. The agent runs LiveKit's local CPU end-of-turn model (~96 MB) (A2 §4.1). Whether that counts as a "local model on the customer path" under `AIWA-VRAM-PLACEMENT.md:14` is §9 Q15. | new |
| **PD11** | **Wording:** exact legal and caller-facing copy (disclosure, emergency, fallback, voicemail, after-hours) is played by Twilio `<Say>`/`<Play>`. The model never says "booked". The confirmation line is spoken only after the durable append succeeds. | D7 |
| **PD12** | **Process:** workers never commit to the integration branch or touch live systems. No provider or account calls unless a WP names a read-only step. Workers never read `.env*`. Every module gets a colocated `*.check.ts`. All live steps are Carter-approved and executed by the supervising session. | D8 |

### 3.2 Hosting specifics

**Ingress** (PD1):
- SIP over **TLS** with SRTP `REQUIRE` is the target.
- It is gated on proving `<Dial><Sip secure=true>` and trunk encryption on the canary first. C0 runs TCP with encryption DISABLE today (§0.1), and deploy.md marks TLS as UNVERIFIED.
- If TLS fails on the canary, Carter decides whether to accept TCP (§9 Q3).

**LiveKit production objects** (WP-E; readiness F8):
- A **separate project** named `grizzly-voice-prod`.
- Inbound trunk:
  - `numbers=[+14698963862]`
  - digest auth
  - `allowed_numbers` = staff during C4, empty at C5
  - `headers_to_attributes {X-VP-Call: vp.callSid}`
  - ringing 15 s
  - `max_call_duration` = PD9
- Dispatch rule: individual rooms with prefix `vp-`, **explicit trunkIds**, `hidePhoneNumber:true`, agent `grizzly-voice-prod`.
- Keys: one runtime key with no admin grants, and one SIP-admin key used only for provisioning on the PC.
- `livekit-sip.ts` reconciles resources **by name**. It must be parameterized so it can never touch the canary objects (A2 §6).

**Twilio production objects** (WP-A):
- A main-account Serverless service `grizzly-voice-prod`, production environment, with:
  - `/ingress`
  - `/dial-action`
  - `/fallback` and `/fallback-next`: Carter/Jaime roles, geography, emergency
  - `/whisper`: name + reason
  - `/voicemail-done`: Slack #ops-alerts alert with SMS fallback, HCP message shell through the delivery-worker intake
  - a hours-aware closed branch
- The Sync service holds per-CallSid lease, transfer and admission documents.
- A new Restricted key.

**Coexistence:**
- The old voice-server (host-root PM2, :8765 behind Funnel :10000) keeps running untouched as the **rollback target** for a window Carter sets (proposed 14 days after C5).
- Decommissioning is a separate approval (§8 P18).
- While both exist, only one receives calls, because `voice_url` points at one or the other.

**AIWA process** (`aiwa-deployment.md`, `AIWA-RECIPE.md:30-47`):
1. Author locally and push an exact ref.
2. Use the Orca environment `aiwa-orca` (CT101) for the sandbox install and dry runs.
3. Then `mcc-prod-103` (CT103) with a recorded rollback ref.
4. Every unit, restart and credential action needs its own approval.
5. No SSH or SCP, no live patching, no `git clean` or reset.

`AIWA-DEPLOY-RUNBOOK.md` is marked **DO NOT EXECUTE** because it predates the Orca-only rule; it is reference only (B §1.1).

**Network from CT103:**
- Outbound to LiveKit Cloud, `api.openai.com`, `api.twilio.com`, Twilio Sync, `slack.com`, CT102 hcp-mcp :7332, host RAG `192.168.1.12:8181`, and `geocoding.geo.census.gov`.
- No inbound.
- The readiness egress-deny evidence rule (§3.8) becomes: CT103 has **no route to Proxmox API :8006**. It does reach CT102, which is intended.

---

## 4. Practice-call gate (mandatory, before ANY production change)

The gate runs **on the canary DID …2642**, never on …3862:
- The canary's LiveKit project and Functions are re-pointed to the **parity build**, hosted in the **CT101 sandbox**. That also proves AIWA hosting.
- Approvals §8 P2–P4 apply.
- HCP writes go only to a designated test customer, "ZZ TEST Carter Voice", and are cleaned up afterwards (§9 Q16).

**Rules:**
- Carter calls from his allow-listed cell and hears the complete flow end to end: intake, HCP lookup, booking read-back, transfer, and voicemail.
- The scenarios are the existing `canary/c0/REHEARSAL.md` A–H plus the new parity scenarios **PG1–PG15** added to that file in this commit.
- **If any §1 row with a caller-facing effect is missing, or any PG row fails, the gate fails and cutover does not proceed.**

| Gate | Result / date (Carter) | Evidence path(s) | Notes |
|---|---|---|---|
| REHEARSAL A–H re-run on the parity build |  |  |  |
| PG1–PG15 (see REHEARSAL.md "Parity gate") |  |  |  |
| §1 parity table: every row carried, improved or waived in §8 |  |  |  |
| Voice and greeting choice (Q5) heard and accepted |  |  |  |
| HCP test records cleaned up; no stray customers or estimates |  |  |  |
| **Carter sign-off: practice-call gate PASSED** |  |  | Signature, date, time |

---

## 5. Cutover and rollback on …3862

**Scripts and timing:**
- Every step uses the parameterized route script (WP-A, `voice-prod/provision/route-number.ts`) under PD3.
- **Rollback** = one `voice_url` write back to `https://aiwa.tailf72e3f.ts.net:10000/twiml`. The target is **≤ 60 s** from decision to effect for new calls.
- The time-to-effect is measured twice: on the canary (REHEARSAL E) and at C3.
- If the Funnel or old server is unhealthy (watchdog heartbeat), roll back to **C2 humans-first** instead, which is host-independent.

**Before each step:**
1. The previous step's evidence is complete.
2. A production-guard fresh snapshot with `--compare` passes.
3. The watchdog heartbeat reads `ok`.

| Step | Twilio change on …3862 | Precondition | Evidence to capture | Rollback |
|---|---|---|---|---|
| **C0 baseline** | none (read-only) | §4 gate signed | Masked IncomingPhoneNumber snapshot and hash, guard baseline, Monitor alerts (24 h), watchdog heartbeat, line-check state | n/a |
| **C1 apply fallback** | `voice_fallback_url` (+ method) = gateway-autofix `…/voice-fallback`. The SMS fallback fields are **not** part of this plan; they need their own gateway-autofix decision, §9 Q2. | gateway-autofix branch pushed and promoted to a production environment; canary …3978 re-test passed (its STATUS.md gate) | Before/after snapshot: only the fallback fields changed | Clear the field (`CHANGE-SET.md:91-97`) |
| **C2 humans-first** | `voice_url` → `grizzly-voice-prod/fallback` (every caller rings Carter/Jaime screened, then voicemail + alert) for a window Carter sets (proposed one business morning) | C1 done; production Functions deployed (P10) | Snapshot (only voice_url changed), ≥ 3 real calls handled, voicemail alert delivered | voice_url → `:10000/twiml` |
| **C3 staff-only AI** | `voice_url` → `grizzly-voice-prod/ingress` with admission `staff-only` (customers still reach humans) | CT103 units running (P11); LiveKit prod trunk allows staff only | Carter's production rehearsal call (§6.1), rollback drill timed, first-audio marker, delivery record in HCP test customer | voice_url → `:10000/twiml` (or C2) |
| **C4 line-check + watchdog** | none on the number | line-check v2 and watchdog v2 installed (P13, P14) | 06:30 and 21:00 checks green on the new path; watchdog heartbeat shows the new probes | Uninstall v2 units (restore v1) |
| **C5 open** | none on the number. Admission flips to `open` (Function env + agent config), and the LiveKit trunk `allowed_numbers` is cleared. | C3 and C4 green; Carter go (P15) | First 10 customer calls reviewed (redacted), delivery success rate, zero `failed_needs_manual` older than 30 min | Admission → `staff-only` (humans-first) or voice_url → `:10000/twiml` |

**Kill switch** (any time after C2), in order of preference:
1. `route-number.ts --apply --to rollback`, back to the old server.
2. `--to humans`, back to C2.
3. Admission `staff-only`.

All three are pre-staged in the supervising session. Each prints the before/after diff.

---

## 6. Verification after cutover

### 6.1 Production rehearsal (at C3, again at C5 + 1 h)

Carter calls …3862 from his allow-listed cell and runs PG1 (booking against the test customer), PG2 (lookup), PG7 (transfer), PG8 (voicemail) and PG10 (emergency wording, **without** dialing emergency routing live unless Carter chooses to).

Evidence: call SIDs (masked), HCP record ids, alert delivery, first-audio timing and rollback drill timing.

### 6.2 Line check (WP-G1, Hermes-Supervisor repo)

**Required changes:**
- `line_check.py:577-583` asserts `<ConversationRelay` and `ttsProvider=`. It becomes a **mode**, `LINE_CHECK_VOICE_MODE=livekit`, which skips the local TwiML probe. The Function is Twilio-hosted and signature-protected, so a local POST proves nothing.
- `LINE_CHECK_VOICE_HEALTH_URL` points at the CT103 agent health endpoint, reached via an Orca-approved LAN binding, or is dropped (§9 Q17).
- The real 1546 → 3862 call stays.

**PD5 probe policy:** the probe is admitted to the agent and flagged. The agent greets, the call must complete with **duration ≥ 10 s**, and there must be **no Monitor alert**. In addition, it asserts the agent's per-call record shows `first_audio` and `probe=true`, published by the agent to a small read-only status file the line check can read (mechanism in §9 Q17).

**Timing:** the 06:30 check after C5 must exercise the new path. The check at C4 exercises it in staff-only mode, because the probe number is admitted by the probe policy.

**Downstream:** the installer (`tools/aiwa-install-line-check-env.py:100-101`) and the `ops-digest` readers (`ops_digest.py:500-505`) are updated in the same WP.

### 6.3 Watchdog (WP-G2, grizzly-hcp `barnscarter-ops/voice-watchdog`)

- Missed-call detection is unchanged, since the number is in the same account.
- New probes: the Function `/ingress` returns 403 unsigned (proving the service is up), the CT103 agent is registered and healthy, and the delivery backlog is below threshold.
- Funnel probes are kept for the rollback target while coexistence lasts.
- Also fix the current watchdog's shared `/opt/grizzly-hcp/.env`, which violates `SECRETS-MATRIX.md:3` (B §5.5), with its own EnvironmentFile.

### 6.4 Go/no-go gates (Carter signs)

| Gate | When | Criteria | Carter |
|---|---|---|---|
| G-C3 | after staff-only rehearsal | §6.1 passed; rollback drill ≤ 60 s; zero stray HCP writes |  |
| G-C5 | before opening | line check 2× green on new path; watchdog v2 clean 24 h; delivery worker 0 failures |  |
| G-24h | C5 + 24 h | no missed call without a callback alert; `failed_needs_manual` = 0 or reconciled; no silence reports |  |
| G-7d | C5 + 7 d | same, 7 days; cost within §9 Q4 budget; approve old-server decommission timeline |  |

---

## 7. Execution model: Orca Pi teams

**Structure (binding):**
- **One Pi orchestrator per work package.** Each spawns its own pi-subagents: `feature-implementer` writers and `reviewer` checkers, all on **`deepseek/deepseek-v4-pro`**, passed explicitly on every spawn. The settings overrides would otherwise land reviewers on glm-5.2 (C §2).
- The children talk to their orchestrator over the **pi-subagents supervisor bridge** (`contact_supervisor` / `subagent_supervisor`). Intercom is optional (C §2).
- **A Claude session monitors only.** It reads `STATUS.md` and terminals, types `MONITOR:` or `CARTER:` messages, and verifies diffs and tests independently ("verify, never relay").
- **Nothing live is touched by any worker.**
- Every live step in §5 and §8 is Carter-approved and **executed by the supervising session**.

**Launch** (verified facts from C §1; the exact 09-20 command was not recorded, so this template is marked [U] until its first use succeeds):
```
orca terminal create --worktree path:<WP worktree> --title "<WP> — orchestrator" --command
  '$env:AGENT_INTERCOM_SCOPE_ID="<wp-slug>-<yyyymmdd>";  # >= 16 chars, [A-Za-z0-9_-]
   pi -ne
     -e C:\Users\carte\.pi\agent\npm\node_modules\pi-subagents\index.ts
     -e C:\Users\carte\.pi\agent\npm\node_modules\@ctliz\agent-intercom-pi\index.ts
     -e C:\Users\carte\.pi\agent\extensions\orca-agent-status.ts
     --provider zai --model glm-5.3 --thinking medium --name <wp>-orch'
```

**Launch rules:**
- `-ne` disables discovery, and the explicit `-e` list **omits `@arhen/pi-core-vision`**, which replaces the built-in `read` and breaks child reads (C §4).
- After launch, verify with `orca terminal read --limit 500`: the status line must show `(zai) glm-5.3`.
- First message: point at `.session/<wp>/MISSION.md` and `ROLE-orchestrator.md`.
- Max 3 children alive at once. Max 2 active work packages machine-wide (`WORKBOARD.md:3-9`).
- The orchestrator model is **zai/glm-5.3**. **gpt-6-astra only if Carter explicitly asks:** it costs about 7–11× more per token, and an earlier Astra orchestrator cost $20+ for one slice (C §6).

**STATUS.md protocol** (C §5):
- Location: `.session/<wp>/STATUS.md` in the main grizzly-hcp checkout, not committed, owned by the orchestrator.
- The first line is exactly one of `STATE: WORKING`, `BLOCKED-NEEDS-CARTER`, `DONE-AWAITING-APPROVAL` or `DONE`.
- Then newest-first CDT bullets.
- Update it at every milestone and at least every 20 minutes.
- A BLOCKED or DONE-AWAITING-APPROVAL state carries the exact ask, with cost and blast radius.
- One screen maximum.
- The kit per WP is `MISSION.md` (goal, hard gates, done criteria, cost cap), `ROLE-orchestrator.md`, `ROLE-worker.md`, `STATUS.md`, `ACCEPTANCE.md` and `evidence/`.

**Cost control:**
- Nothing caps the orchestrator's own spend automatically (C §6), so the cap is enforced by the monitor.
- Children: pi-subagents `usageBudget.costUsd.hard` = 60% of the WP cap, and `modelScope` is enforced to v4-pro.
- The DeepSeek prepaid balance is checked before each WP.
- The monitor reads the aggregate cost at every STATUS check. At 80% of the cap it sends `MONITOR: wrap up`. At 100% it stops the orchestrator (closes the terminal) and reports.

**Pricing basis:**
- glm-5.3 is catalogued at $1.40/$4.40 per 1M tokens; plan-quota billing is [U] §9 Q18.
- v4-pro is $1.10–1.32 / $3.96–4.40.

**Hard gates (every WP):**
- No Twilio, LiveKit, OpenAI or HCP account calls.
- No AIWA or Orca remote environments.
- No `.env*` reads.
- No deploys.
- No changes to `voice-server.ts`, `ecosystem.config.cjs`, host PM2 or the canary's live config.
- Children never commit. The orchestrator commits only on its WP branch after a reviewer child's ACCEPT. The supervising session verifies and merges into the integration branch `barnscarter-ops/voice-prod-migration` (created from this branch).

**Done criteria (every WP):**
- All `*.check.ts` pass (`npx tsx`).
- `tsc --noEmit` shows zero new errors in touched files.
- An independent reviewer child returns ACCEPT.
- STATUS reads `DONE-AWAITING-APPROVAL` with evidence paths.
- The supervising session has re-run the checks itself.

| WP | Scope | Worktree / branch | Orch. model | Est. cost | Hard cap | WP-specific gates / done |
|---|---|---|---|---|---|---|
| **WP-A prod-ingress** | Main-account Functions (`/ingress` with staff-only, open and probe admission; per-CallSid lease; `/dial-action`; Carter/Jaime/geo/emergency fallback; name + reason whisper; hours-aware closed branch; voicemail → alert + intake), deploy and route scripts (dry-run default, PD3 asserts), Functions checks | grizzly-hcp `vpm-wp-a-ingress` | zai/glm-5.3 | $6–10 | $15 | No deploy. Route script refuses any change to …3862 other than voice_url, and has a unit test against a fixture snapshot. |
| **WP-B agent-parity** | GPT-Live instructions ported from `VOICE_INSTRUCTIONS`; controller tools (§1 rows 7-27); admission modes; limits (PD9) with the 480 s race fix; mid-call error/close handler; health on 127.0.0.1; parameterized identity (`vp-`, `grizzly-voice-prod`, `VOICE_PROD_*`); typed email; knowledge filter | grizzly-hcp `vpm-wp-b-agent` | zai/glm-5.3 | $12–20 | $30 | Fake-transport tests for every PG scenario. No provider calls. |
| **WP-C hcp-delivery** | Outbox consumer: from-voice chain via hcp-mcp with checkpoints and pre-create probe (§2.3); pending rows in production-compatible format; Slack/SMS alerts; message, reschedule and unreached-transfer records; `human_reconciliation_required` | grizzly-hcp `vpm-wp-c-delivery` | zai/glm-5.3 | $10–16 | $25 | Fake hcp-mcp tests, including crash between steps with no duplicates. No HCP calls. |
| **WP-D poller-coexist** | Second poller instance on the new store with `id-required` SMS mode; CT103 unit template | grizzly-hcp `vpm-wp-d-poller` | zai/glm-5.3 | $3–5 | $8 | Tests prove id-less replies are ignored. The old poller file is unchanged. |
| **WP-E livekit-prod** | Parameterized provisioning (by-name reconcile can never match canary names); TLS/SRTP settings; key separation | grizzly-hcp `vpm-wp-e-livekit` | zai/glm-5.3 | $4–6 | $10 | Dry-run only; test that canary names are refused |
| **WP-F ct103-hosting** | systemd units (PD8, PD10), EnvironmentFile templates (PD7), service user, install/uninstall doc `docs/AIWA-DEPLOY-voice-prod.md` (Orca-only, CT101 then CT103), health checks, replacement for c0ctl | grizzly-hcp `vpm-wp-f-hosting` | zai/glm-5.3 | $6–10 | $15 | `systemd-analyze verify` in tests where available. No AIWA contact. |
| **WP-G1 line-check + digest** | `LINE_CHECK_VOICE_MODE=livekit`, probe assertions, installer, ops-digest reader for the new store | Hermes-Supervisor `vpm-wp-g1-linecheck` | zai/glm-5.3 | $5–8 | $12 | pytest green. Existing ConversationRelay mode still passes its tests. |
| **WP-G2 watchdog v2** | New probes (§6.3), own EnvironmentFile, dual-path coexistence | grizzly-hcp `barnscarter-ops/voice-watchdog` → `vpm-wp-g2` | zai/glm-5.3 | $3–5 | $8 | Existing watchdog checks still pass |
| **Total** |  |  |  | **$49–80** | **$123** | Runtime cost is separate (§9 Q4) |

**Order:** WP-E and WP-A first, then WP-B and WP-C, then WP-D and WP-F, then WP-G1 and WP-G2. At most two run at a time.

---

## 8. Authorization record

### 8.1 Approved so far (Carter, in chat)

- **2026-09-22 (canary only):**
  - Build, wire and enable the C0 canary.
  - Carter created the Twilio subaccount himself and bought LiveKit.
  - …2642 was moved from the main account into the canary subaccount at his direction.
  - The LiveKit project `grizzly-c0-canary` was created.
  - The canary was enabled.
  - Recorded in readiness §5. **This did not authorize any production change.**
- **2026-09-23 (production, named actions only):**
  - AIWA `systemctl restart tailscaled`.
  - Add `CARTER_PHONE`/`JAIME_PHONE` to `/opt/grizzly-hcp/.env`, then `pm2 restart voice-server`.
  - One test call.
  - Install the voice watchdog "once it passes", later updated to Slack-first.
- **2026-09-23:** write this plan (planning only).
- **Not approved:** anything in §5, any production build, any HCP write, any CT101/CT103 action, any purchase.

### 8.2 Approvals the migration still needs (one per step; each is separate)

| # | Approval | Blast radius |
|---|---|---|
| P1 | Start the Pi WPs (§7) at the stated caps | Local branches only; ~$123 cap |
| P2 | CT101 sandbox install of the parity build (Orca `aiwa-orca`) | Sandbox LXC |
| P3 | Re-point the canary (Functions redeploy plus canary LiveKit reprovision) to the parity agent in CT101 | Canary number only |
| P4 | HCP writes during the gate, limited to the test customer, plus cleanup | HCP test records |
| P5 | Practice-call gate sign-off (§4) | none (decision) |
| P6 | LiveKit production project and plan purchase | Recurring cost |
| P7 | OpenAI production project key with GPT-Live access, and the ZDR/retention decision | Recurring cost, privacy |
| P8 | hcp-mcp scoped voice token, and `update_estimate_notes` if absent (CT102 change) | CT102 production |
| P9 | Deploy `grizzly-voice-prod` Functions to the main account (no routing) | New Twilio service, inert |
| P10 | CT103: service user, EnvironmentFiles, units installed but not started | CT103 production |
| P11 | CT103: start units | CT103 production |
| P12 | **C1** apply gateway-autofix `voice_fallback_url` on …3862 | Production number (fallback field only) |
| P13 | **C2** humans-first `voice_url` | Production number: all callers go to humans |
| P14 | **C3** staff-only AI `voice_url`, plus the production rehearsal | Production number |
| P15 | **C4** line-check v2 and watchdog v2 install (env, code, daemon-reload on AIWA host) | AIWA host units |
| P16 | **C5** admission `open` plus clearing the LiveKit trunk allowlist | All customers reach the AI |
| P17 | G-24h and G-7d sign-offs | none (decision) |
| P18 | Decommission the old voice-server (later, separate) | Removes the rollback target |

---

## 9. Open questions and risks

| # | Question / risk | Owner | Default if no answer |
|---|---|---|---|
| Q1 | Hosting: CT103 (policy) vs host root ("same place as today"). Host root needs a recorded exception. | Carter | CT103 |
| Q2 | The gateway-autofix fallback is on the `dev` domain and an unpushed branch, and its STATUS is BLOCKED-NEEDS-CARTER. It must be pushed and promoted to production before C1. SMS fallback fields need their own decision. | Carter + gateway-autofix supervising session | C1 blocked until done |
| Q3 | SIP TLS/SRTP proven on the canary? If not, accept TCP/RTP for production? | Supervising session (proof), Carter (accept) | Block C3 |
| Q4 | Production limits (PD9 values), daily ceilings, expected call volume, runtime budget (GPT-Live $0.05/min + tokens, LiveKit SIP, Twilio) | Carter | PD9 proposals |
| Q5 | Greeting, voice choice and the two-voice seam (Twilio `<Say>` then GPT-Live voice) | Carter at the gate | Decide at PG |
| Q6 | Confirmation wording: keep "You're all set… next business day", or use D7's "The office will review your request and contact you"? | Carter | D7 line |
| Q7 | Behaviour changes that fix production defects (§1 rows 9, 16, 17, 20, 25; §2.3). Approve each, or keep production behaviour. | Carter | Fixes applied, listed at the gate |
| Q8 | Holiday calendar (none today) | Carter | None (parity) |
| Q9 | Estimate-status lookup: implement it or drop the promise? | Carter | Drop the promise |
| Q10 | After-hours fallback: ring humans anyway, or go straight to voicemail? | Carter | Voicemail + alert after hours; emergencies still dial |
| Q11 | Emergency direct dial without whisper can hit personal voicemail (production today). Add press-1 for emergencies? | Carter | Keep production behaviour |
| Q12 | Why …2642 is labelled "Gateway Autofix Canary". The documented gateway-autofix canary is …3978. Read-only compare `date_created`. | Supervising session | Relabel "Grizzly C0 Canary" at P3 |
| Q13 | Full-call recording or transcripts, OpenAI retention/ZDR, customer notice | Carter (privacy) | None; voicemail only |
| Q14 | hcp-mcp `update_estimate_notes` availability vs keeping the cookie jar plus keepalive (`9063f42` is only on main) | Supervising session (read-only check) + Carter (P8) | Block WP-C finalization |
| Q15 | Is LiveKit's local CPU end-of-turn model allowed on the customer path (`AIWA-VRAM-PLACEMENT.md:14`)? | Carter | Allowed with PD10 caps |
| Q16 | HCP test-customer convention for the gate, and cleanup | Carter | "ZZ TEST Carter Voice" |
| Q17 | Line-check path to CT103 health and first-audio evidence (LAN binding vs status export) | WP-G1 orchestrator → Carter | Status export file via approved mount |
| Q18 | glm-5.3 billing (Z.AI Coding Plan quota vs catalog price); DeepSeek balance | Carter | Monitor tracks both |
| Q19 | `Shared/Agents/AGENTS.md:90` still says "Pi agents paused (2026-08-28)", and no written unpause exists. Record the unpause for this program. | Carter | Treat this plan's P1 as the unpause |
| Q20 | Two pending stores during coexistence: ops-digest must read both, and id-less SCHEDULE replies go only to the old store (§2.5) | WP-D / WP-G1 | As designed |
| Q21 | Old path still carries prod defects (TTS default, unsigned webhooks, Funnel drops) while it is the rollback target | Supervising session | Watchdog covers detection; no changes to old path |
| Q22 | C0 production-guard hashes drifted between snapshots with no compare. Fresh baseline plus `--compare` is required before C0 of §5. | Supervising session | Required |
| Q23 | GPT-Live alpha access and tier on the production OpenAI project are unproven. No canary call has been admitted yet. | Carter (rehearsal) | Gate PG requires it |
| Q24 | **Risk:** CT103 co-tenancy with `mcc-prod` (`/opt/maverick-integrations`) and resource contention | Supervising session | PD10 caps |
| Q25 | **Risk:** Twilio Functions and LiveKit Cloud become production single points of failure. Mitigations: humans-first `/dial-action`, detector, `voice_fallback_url`, watchdog. | Supervising session | Covered by C1 + WP-G2 |
