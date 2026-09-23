# A1 — Production voice-server parity inventory (Grizzly business line +1 469-896-3862)

Source of truth: `git show dc31c9b:<path>` in `D:\Workspace\Active\grizzly-hcp` (production commit).
All citations are `file:line` **at dc31c9b** unless marked otherwise.
Legend: **[R]** = read directly in source. **[I]** = inferred (not directly verifiable from the repo: live `.env`, Twilio number config, Funnel config, platform defaults).
Not visible: the production host's uncommitted edits to `data/employee-phones.json`, `ecosystem.config.cjs`, `package-lock.json`, and the live `/opt/grizzly-hcp/.env`.

Deployment context:
- Production runs under **AIWA root PM2**, install root `/opt/grizzly-hcp`, env from `/opt/grizzly-hcp/.env`. [I from 7bc341b commit msg "Deleted from AIWA root PM2" and the unmerged `voice-watchdog` deploy doc at b7cb4ed.] Note: `memory/HANDOFF.md` at dc31c9b still says "Live on CartersPC PM2 (not AIWA): voice-server (:8765), booking-approval-poller". That line is stale; the move happened after 2026-08-15.
- Twilio voice_url `https://aiwa.tailf72e3f.ts.net:10000/twiml` means a Tailscale Funnel on :10000 in front of `VOICE_PORT` (default 8765). `VOICE_PUBLIC_URL` must be `https://aiwa.tailf72e3f.ts.net:10000`, because every callback URL and the WS URL are built from it (voice-server.ts:41,118,121,182,188,222). [I]

---

## 1. Call flow today

1. **Inbound call → `POST /twiml`** (voice-server.ts:180-193) [R]. Returns:
   `<Connect action="{PUBLIC_URL}/handoff"><ConversationRelay url="wss://…/ws" welcomeGreeting="…" [ttsProvider] [voice] dtmfDetection="true"/></Connect>`
   - No Twilio signature validation on any route (no `validateRequest` import) [R].
   - No `language`, `transcriptionProvider`, `speechModel`, `interruptible`, `hints`, `welcomeGreetingInterruptible` attributes. Twilio defaults apply: en-US, platform STT, barge-in on. [R absence / I defaults]
   - TTS attributes come from env: `VOICE_TTS_PROVIDER` (default `''`, so the attribute is omitted) and `VOICE_TTS_VOICE` (default `Polly.Joanna-Neural`) (voice-server.ts:46-47,183-185) [R]. **Risk:** if prod `.env` doesn't set a provider, Twilio's new default provider (ElevenLabs) rejects the Polly voice name. That causes relay error 64106 and callers hear silence (outage 2026-09-11, fixed only on main in 9195ff9). Whether prod `.env` works around this is unknown. [I]
2. **Twilio speaks the welcome greeting** (TTS, before any LLM call): "Thanks for calling Grizzly Electrical! This is Maverick, the automated assistant. How can I help you today?" (voice-server.ts:50,189) [R].
3. **WS `/ws` session** (voice-server.ts:286-461) [R]. `WebSocketServer({server})` has no path filter and no auth, so it accepts WS on any path [R].
   - `setup`/`start` → a session `{callSid, from, history:[]}` is created in an in-memory Map (297-306). Only `callSid` and `from` are used; `to`, `callerName` (CNAM) and `customParameters` are ignored [R].
   - `prompt` (308-439): for each final caller utterance (`voicePrompt`):
     - push the text to history (cap `MAX_HISTORY=30` messages, 48,315);
     - build a **fresh Mastra Agent per turn** `createMaverickAgent('voice')` (316; index.ts:209-217);
     - flatten history into one prompt string of the form `Caller: …\nMaverick: …`, then append `(Caller ID: +1…)` and `(Office is currently OPEN|CLOSED)` (320-326);
     - `await agent.generate(fullPrompt)`. This is **non-streaming**: nothing is spoken until the full LLM and tool loop finishes (328). Mastra's default step limit applies, likely 5 [I];
     - parse inline control blocks with priority TRANSFER > RESCHEDULE > BOOKING_REQUEST > MESSAGE (333-336);
     - strip the blocks, `[ESTIMATE_READY]`, `**bold**` and markdown links from the spoken text (338-346);
     - act on the block (350-419, see §2), then send one `{type:'text', token, last:true}` (463-466);
     - log to the console, then `logAudit()` to `data/audit.jsonl` (421-433).
   - `interrupt` is ignored, and history keeps the full un-truncated assistant text (441-442) [R].
   - `error` → console only (444-446). `stop` → session deleted (448-456) [R].
   - There is no `dtmf` case, so caller keypresses are dropped even though `dtmfDetection="true"` [R].
   - Turns are not serialized. Two quick utterances run two concurrent `generate()` calls, and replies can interleave [I].
4. **Tools available to the LLM on voice** (allow-list, resolver.ts:6-11,49-53) [R]: `search_pricebook`, `lookup_pricing`, `search_knowledge`, `lookup_my_appointments`. The system prompt is `VOICE_INSTRUCTIONS` only (resolver.ts:67-149,312). The base Maverick prompt and `data/mav-rules.md` are **not** used on voice [R].
5. **Side-effecting actions happen only through inline blocks** the server parses, never through tools (resolver.ts:3-5) [R]:
   - `[BOOKING_REQUEST]`, `[MESSAGE]`, `[RESCHEDULE]` → `spawnPipeline()` spawns `node node_modules/tsx/dist/cli.mjs src/automations/bookings/from-voice.ts` with JSON on stdin (voice-server.ts:131-167). The call continues and the caller can keep talking.
   - `[TRANSFER]` → spoken text, then 100 ms later `ws.send({type:'end', handoffData})` (379-388). Twilio then POSTs `/handoff`.
6. **End of call → `POST /handoff`** (195-213) fires whenever the relay session ends. It returns `<Hangup/>` with no HandoffData, or dial TwiML for a transfer (see §4). The agent **cannot hang up by itself**: `end` is only sent for transfers, so calls otherwise last until the caller hangs up [R].
7. **Post-call async:** `from-voice.ts` writes to HCP, sends ops alerts, and appends to `data/pending-bookings.jsonl`. The PM2 `booking-approval-poller` then schedules the booking once Carter or Jaime replies `SCHEDULE …` (approval-poller.ts) [R].

---

## 2. Capability table

Legend for deps: HCP-direct = cookie client `pro.housecallpro.com` (src/hcp/client.ts). MCP = housecall-pro-mcp daemon at `HCP_MCP_URL` (CT102 :7332 per deploy/ct103/README-BOOKING-POLLER.md:66). Which path runs depends on `HCP_VIA_MCP` (gateway.ts:10-19; client.ts:77-83).

| # | Capability | What the caller experiences | Implementing files:lines (dc31c9b) | External deps | Side effects / writes | Notes |
|---|---|---|---|---|---|---|
| 1 | Health endpoint | n/a | voice-server.ts:174-178 | none | none | `GET /health` returns "Maverick Voice Server running". |
| 2 | Call answer + relay handoff | The call connects to the AI | voice-server.ts:180-193 | Twilio ConversationRelay | none | Unsigned webhook. WS URL = `PUBLIC_URL` with `http` replaced by `ws`, plus `/ws`. |
| 3 | Welcome greeting / AI disclosure | Hears the fixed greeting, which says it is an automated assistant | voice-server.ts:50,189 | Twilio TTS | none | Constant string; not time-of-day aware. |
| 4 | TTS voice | Voice depends on env | voice-server.ts:44-47,183-185 | Twilio TTS (Amazon/ElevenLabs) | none | Prod defaults can produce silence (see §1.1 and §6). |
| 5 | STT / language | English only | ConversationRelay defaults; persona in English (resolver.ts:67-149) | Twilio STT | none | No `language` attribute and no Spanish handling [R absence]. |
| 6 | Barge-in | Caller can interrupt the TTS | voice-server.ts:441-442 | Twilio platform | none | Server ignores `interrupt`, so LLM history thinks the full reply was heard [R]. |
| 7 | DTMF | Keypresses do nothing | voice-server.ts:189 (`dtmfDetection="true"`), no handler in 295-457 | — | none | No IVR menu [R]. |
| 8 | Speech style rules | Short, warm, one question at a time, under ~40 words, numbers spoken naturally, asks to repeat instead of guessing | resolver.ts:71-77 | LLM | none | Persona only. |
| 9 | LLM brain | Conversational replies | index.ts:209-217; model-router.ts:30-35,117-152 (Venice `zai-org-glm-5-2` default, overridable via `MAVERICK_REASONING_MODEL`); fallback model-router.ts:23-28,43-81,87-107 (z.ai `glm-5.2`) | Venice API; z.ai (fallback); optional DeepSeek/Anthropic | none | `withRetry` resolves the fallback model inside the proxy getter (93), so a missing fallback key breaks **every** turn, not just retries [R/I]. Voice-server also crashes at import if `VENICE_API_KEY` is missing (index.ts:220 → model-router.ts:146) [R]. |
| 10 | Conversation memory | Remembers earlier turns in the call | voice-server.ts:48,314-326,330 | — | in-memory only | 30-message window; flattened into a string, not role messages. Lost on process restart. |
| 11 | Caller-ID awareness | Agent knows the calling number and can ask "is the number you're calling from the best one?" | voice-server.ts:300,324; resolver.ts:98 | Twilio `from` | none | Anonymous callers get no note appended. |
| 12 | Office-hours awareness | Told whether the office is open; hours recited on request (M-F 8a-6p, Sat 8a-2p, Sun closed, Central) | office-hours.ts:6-21; voice-server.ts:325; resolver.ts:79-80 | none | none | Hours are hard-coded constants. **No holiday calendar** [R]. |
| 13 | General Q&A / company knowledge | Answers questions about services, service area and electrical topics | resolver.ts:83-84; rag.ts:69-94; rag/client.ts:48-56 | Mav RAG `POST {RAG_URL}/ask` (default `http://192.168.1.12:8181`) | none | RAG is a weekly HCP snapshot plus NEC/Oncor docs. **Privacy gap:** `search_knowledge` can return other customers' records (`[CUSTOMER]` filter); only the persona forbids sharing them (resolver.ts:148) [R/I]. |
| 14 | Price ranges | "That typically runs between X and Y… we confirm the exact price on-site." Never a firm price | resolver.ts:92-93; rag.ts:18-53; rag/client.ts:92-100,121-143 | RAG `/pricebook/search`, RAG `/ask` | none | Ranges come from the LLM plus RAG. No hard numeric guardrail in code. |
| 15 | Booking intake | Collected one at a time: name → callback # → address (house # + street + city required; never asks zip/state) → email (spoken "at/dot" assembled) → lead source (optional) → issue → 2-3 time windows. Then "You're all set. We'll confirm one of those times with you within the next business day." | resolver.ts:95-110 (block schema :109); voice-server.ts:403-416 | LLM | spawns from-voice (row 16) | If name, phone or address is missing, falls back to the MESSAGE flow (resolver.ts:105). **The spoken "you're all set" does not depend on pipeline success** [R]. Bad block JSON → `{}` payload → pipeline fails → FAILED alert (393-395,407-409). |
| 16 | Booking → HCP (from-voice `booking`) | Nothing live; the caller later gets HCP's scheduling notification | from-voice.ts:219-381 | Census geocoder (geocode.ts:21-67, 10 s timeout); HCP (see §3); RAG + local `data/pricebook.csv` + Anthropic Haiku for line matching; ntfy + Twilio SMS | HCP customer (create or reuse), service address (reuse or add), estimate, line items, note, assignment of Carter + Jaime with push; `data/pending-bookings.jsonl` status `pending`; `data/pricebook-misses.jsonl` | Gates: name, valid phone, address, geocode success (219-241). Otherwise throws → `failed_needs_manual`. |
| 17 | Booking line items | n/a (visible in HCP) | booking-line-items.ts:114-208; rag/price-book.ts:190-257; build-line-item.ts:44-59 | RAG `/health`, `/pricebook/search`; Anthropic `claude-haiku-4-5-20251001` fallback (price-book.ts:91-123) | HCP line items | Always "Service Fee" (`BOOKING_DEFAULT_LINE_ITEM`). Troubleshooting issues add Troubleshoot Level 1 (single) or Level 2 (multiple) via regex (38-107). Other issues add a free-text pricebook match. Unmatched items go in at $0 with a "⚠ NEEDS PRICING" flag. Zero lines → forced fallback line. **Line-item failure is non-fatal and log-only** (from-voice.ts:299-314) [R]. |
| 18 | Price-concern discount | If the caller balks at the fee, they get nothing spoken; the office sees a 50% discount line | resolver.ts:110; booking-line-items.ts:46-47,109-112,169-179,241-259 | same | extra "fixed discount" line = Service Fee / 2 (fee fallback $79) | Triggered by the LLM flag or a regex on the issue text. |
| 19 | Address normalization / dedupe | n/a | geocode.ts:24-67; contact-normalize.ts:21-57; estimates.ts:350-376 | Census geocoder; HCP GET `/alpha/customers/{uuid}?expand[]=addresses` | reuses an existing address when house # + zip5 + unit match; otherwise adds | Title-cases Census ALL-CAPS output. |
| 20 | Existing-customer match | n/a | from-voice.ts:244-257; estimates.ts:295-331 | HCP `/alpha/customers?q=<name>` | Note flags "⚠️ Matched EXISTING CUSTOMER — reconcile contact details by hand" | **Name-only, first hit wins** (estimates.ts:320). Phone and email are not updated on existing customers. A wrong same-name match is possible [R]. |
| 21 | Message taking | Collects name, callback number and message, then "Got it. I'll pass that along right away." | resolver.ts:112-115; voice-server.ts:403-416; from-voice.ts:170-213 | HCP (search/create customer, create estimate, note, assign) | Estimate shell with a "📞 MAVERICK PHONE MESSAGE" note; Carter + Jaime assigned (HCP push); pending row status `message_delivered` | **No ops alert (ntfy/SMS) on a successful message.** The path `process.exit(0)`s at 212 before any `sendOpsAlert`. HANDOFF.md claims messages alert; they don't. The HCP push is the only notice [R]. |
| 22 | Appointment lookup (caller's own) | "Can I get your full name?", then reads back the upcoming scheduled time. If caller ID doesn't verify, asks for name + service address | resolver.ts:125-129; voice-lookup.ts:93-169 | HCP GET `/alpha/customers?q=<10 digits or name>&expand[]=addresses`, `/alpha/jobs?customer_id=…&work_status=scheduled&page_size=10` (via MCP `hcp_api_get` when `HCP_VIA_MCP=true`, client.ts:79-83) | none | Verifies by phone + last-name token, or by name + (house # + street word) (23-39,99-121). Returns up to 5 **scheduled** jobs only; in-progress and unscheduled jobs aren't shown. |
| 23 | Estimate status lookup | Persona says it can check on estimates, but **it can't**: the tool returns appointments only | resolver.ts:88,125; voice-lookup.ts:150-151 ("Estimates omitted") | — | none | Latent capability gap: the prompt promises more than the code does [R]. |
| 24 | Reschedule request | After verification and read-back, collects 2-3 new windows, then "Okay. We'll confirm the new time with you within the next business day." Never says it's moved | resolver.ts:130-132; voice-server.ts:390-402; from-voice.ts:215-381 | HCP | New estimate **shell** carrying a RESCHEDULE note (HCP job id, current time, windows); Carter + Jaime assigned; pending row; ops alert | Office moves the job by hand; the poller ignores it. **Quirk:** the RESCHEDULE block has no address field, so `resolvedAddress` is null and the status is always `needs_address_review` (not `reschedule_pending`). The alert says "ADDRESS UNVERIFIED — office must fix" (from-voice.ts:334-336,376-378). If the name-matched customer has no address id, it throws → FAILED (289-291) [R]. |
| 25 | Human transfer (general, office open) | Asks name + one-line reason → "One moment while I try to connect you." → dials Jaime or Carter, screened | resolver.ts:117-123; voice-server.ts:350-389,195-213,115-128,215-240,242-278 | Twilio `<Dial>`, `<Number url>`, `<Gather>` | `data/voice-messages.jsonl` `general_transfer` | Target: the name asked for, else the geography rule, default Carter. Details in §4. |
| 26 | After-hours transfer backstop | Asks for a person after hours → "The office is closed right now, so I've passed your message along instead. Someone will call you back the next business day." | voice-server.ts:356-370 | HCP via from-voice `message` | Message estimate shell + pending row | Persona should offer MESSAGE instead (resolver.ts:119); this is the code backstop. |
| 27 | Emergency handling | Fire or smoke → "hang up and call 911" (no transfer). Other hazards → asks city → "Okay, connecting you now — please hold." → direct dial, 24/7 | resolver.ts:134-141; voice-server.ts:350-389,195-213,115-128 | Twilio `<Dial>` | `voice-messages.jsonl` `emergency_transfer` | Geography: NE (Rowlett, Garland, Rockwall, Plano, Richardson, Mesquite, Wylie, N/E Dallas) → Jaime; S (Waxahachie, Ennis, Midlothian, Red Oak, DeSoto, Cedar Hill, Duncanville, S Dallas) → Carter; unclear → Carter. No whisper, so **personal voicemail can "answer" an emergency** (status completed, no fallback) [I]. |
| 28 | Transfer fallback chain | First person no-answer → "Still connecting you, one moment please." → dials the other | voice-server.ts:253-259 | Twilio | none | 25 s timeout per leg (126). |
| 29 | Both unreachable | Emergency: "…If this is a life threatening emergency, please hang up and call nine one one. Otherwise, we have your number…" General: "Nobody was able to pick up just now. We have your number and someone will call you back…" | voice-server.ts:260-277 | Twilio `<Say>` | `data/voice-messages.jsonl` `{kind}_unreached` only | **No ops alert, no HCP record, no pending row** for unreached callers. Only the jsonl and the missed-call logs on Carter's and Jaime's phones [R]. Nothing in the repo reads `voice-messages.jsonl` [R]. |
| 30 | Payment refusal | "the office handles payment" | resolver.ts:147 | — | none | Persona only. |
| 31 | Privacy / no-internal-info rules | Won't share personal numbers, other customers, internal costs, firm timelines or confirmations | resolver.ts:143-149 | — | none | Persona-enforced except row 22, which is code-enforced. |
| 32 | Out-of-scope requests | Offers to take a message | resolver.ts:149 | — | — | Persona. |
| 33 | LLM/agent error | "I'm having a little trouble on my end. Let me take your name and number and we'll call you right back." | voice-server.ts:434-437 | — | console error only | No automatic message capture. If the LLM is fully down, every turn repeats this line [I]. |
| 34 | Pipeline failure alerting | Caller already heard success | voice-server.ts:144-163; from-voice.ts:383-400 | ntfy + ops Twilio SMS | pending row `failed_needs_manual` (with error); alert "Maverick {kind} FAILED — {who}" with a stderr tail | No timeout on the child, so a hung pipeline never alerts [I]. |
| 35 | Booking/reschedule ops alert | n/a | from-voice.ts:367-381; alert.ts:81-120 | ntfy (`NTFY_URL`/topic), Twilio Messages API from `OPS_SMS_FROM` → `OPS_SMS_TO` (≤320 chars) | outbound ops SMS | Includes callback, address, email, lead source, issue, estimate #, and `Reply: SCHEDULE <id> MM/DD h:mm am - h:mm pm` (schedule-command.ts:97-99). |
| 36 | Schedule approval → HCP appointment | Customer gets HCP's own schedule notification (not sent by this code) | approval-poller.ts:120-269; schedule-command.ts:11-78; schedule-payload.ts:20-42; ops-sms-inbound.ts:19-77 | MCP `get_job_notes`, `update_job_schedule`; HCP-direct `POST /api/estimates/{uuid}/notes`; Twilio List Messages API | HCP schedule on the estimate; confirmation note "✅ MAVERICK: scheduled…"; ops SMS "✅ Scheduled #…"; pending row → `scheduled`; `data/ops-sms-schedule-seen.json` | Separate PM2 process `booking-approval-poller`, 60 s tick. Needs the **same cwd/data dir** as voice-server. Numeric pro IDs `CARTER_PRO_ID`/`JAIME_PRO_ID`. Needs `TZ` Central. |
| 37 | SMS to the caller | **None.** Voice never texts the customer | — | — | — | Only HCP notifications, and only after scheduling. Messages and reschedules get no customer-facing follow-up from code [R]. |
| 38 | Call recording / voicemail | **None.** No `<Record>` and no record attribute | — | — | — | Twilio number-level recording is unknown [I]. |
| 39 | Transcripts / logging | n/a | voice-server.ts:303,312,421,452 (console → PM2 logs; caller lines full, Maverick lines truncated to 120 chars); audit-log.ts:5,46-50 (`data/audit.jsonl`: first 120 chars of caller text, intent, `toolsInvoked: []` always, retention field `AUDIT_RETENTION_DAYS`) | — | `data/audit.jsonl`, PM2 logs | No full transcript stored anywhere durable; the HCP note holds structured fields only [R]. |
| 40 | Spam / robocall handling | **None** | — | — | — | No allow/deny list, no CNAM check, no rate limit, no max turns [R absence]. |
| 41 | Max call duration / silence timeout | **None in code** | — | Twilio platform defaults | — | `<Dial>` has no `timeLimit`; relay has no idle timeout configured [R absence / I defaults]. |
| 42 | Employee phones / allowlist | **Not used by voice** | (SMS only: customer-chat-server.ts:68-74) | — | — | Employees calling the line get the customer persona [R]. |
| 43 | Security | Anyone who knows the URL can hit `/twiml` or `/handoff` or open the WS and drive bookings | voice-server.ts:171-282,286 | — | could create HCP records | No Twilio signature check and no WS auth [R]. |
| 44 | Twilio-level fallback | If voice-server or the Funnel is down, Twilio can't fetch TwiML or open the WS: no `/handoff`, and the caller hears a Twilio error or silence | — | Twilio number `voice_fallback_url` (unknown) | none | Watchdog for this exists only on the unmerged branch `voice-watchdog` (b7cb4ed; codes 64102/64106/64107/11200/11205/12100). Likely not deployed [I]. |

---

## 3. HCP integration today

**No HCP writes from the LLM.** The voice LLM only has read tools. All writes come from `src/automations/bookings/from-voice.ts`, spawned per block with the parent's env: the PM2 snapshot plus `.env` for missing keys, because dotenv never overrides. This is exactly why `HCP_VIA_MCP=true` didn't take effect in the Jul 31–Aug 8 outage (HANDOFF.md §2026-08-10) [R].

Path selection is `HCP_VIA_MCP` (gateway.ts:10-36; client.ts:77-88):

| Step | Function (gateway) | MCP tool (`HCP_VIA_MCP=true`) | Direct cookie endpoint (otherwise) |
|---|---|---|---|
| find customer | `searchCustomer(name)` | `search_customer {name}` | `GET /alpha/customers?q=…&expand[]=addresses` (estimates.ts:295-331), first hit |
| create customer | `createCustomer` | `create_customer {name,email,phone}` | `POST /alpha/customers` with first/last, email, `mobile_number`+`phone_number` (10-digit), `addresses_attributes:[{street:''}]` (estimates.ts:400-433) |
| address dedupe | `findCustomerAddress` (estimates.ts, via `hcpGet`) | `hcp_api_get` | `GET /alpha/customers/{uuid}?expand[]=addresses` (350-376) |
| numeric id | `resolveNumericCustomerId` (via `hcpGet`) | `hcp_api_get` | `GET /api/v2/pro/customers/{uuid}` (336-339) |
| add address | `addCustomerAddress(numericId,…)` | `add_customer_address` (street/city/state/zip/lat/lng) | `POST /api/v2/pro/customers/{numeric}/addresses` (379-397) |
| create estimate | `createEstimate(customerId, addressId)` | `create_estimate {customer_id,address_id}` | `POST /pro/add_estimate/customer/{id}` form `service_address_uuid`, `is_virtual=false` (40-49) |
| line items | `addLineItem` | `add_line_item` | `POST /alpha/jobs/{est}/line_items` (estimates.ts:76-124) |
| note | `updateEstimateNotes` | `update_estimate_notes`, **falling back to direct on "unknown tool / -32602"** (gateway.ts:25-36) | `POST /api/estimates/{uuid}/notes` (255-262) |
| notify pros | `assignTechnician(est, [CARTER_PRO_UUID, JAIME_PRO_UUID])` | `assign_technician` | `GET /api/estimates/{est}`, then `PUT /api/estimates/{best_uuid}/assignees {service_pro_uuids, notify_pro:true}` (445-452) |
| voice appointment read | `hcpGet` | `hcp_api_get` | `GET /alpha/customers…`, `GET /alpha/jobs?customer_id=…&work_status=scheduled` (voice-lookup.ts:70-84,138-140) |
| poller: read notes | `getJobNotes` (mcp-client **always**) | `get_job_notes {estimate_id}` | — (MCP-only) |
| poller: schedule | `updateJobSchedule` (mcp-client **always**) | `update_job_schedule {request_id: numeric estimateId, schedule_data}` built from `data/schedule-payload-template.json` | — (MCP-only) |
| poller: confirm note | `updateEstimateNotes` imported **directly** from estimates.ts | — | `POST /api/estimates/{uuid}/notes` (approval-poller.ts:21,141-148) |

- **Cookie jar still load-bearing even on the MCP path.** The note fallback and the poller confirmation note always use `auth/hcp-cookies.json` (or `HCP_COOKIES_FILE`) (auth-cookies.ts:12-13). The `update_estimate_notes` tool is absent from the hcp-mcp tool list visible to this session, so the direct fallback probably still fires [I]. The keepalive that rolls the cookie forward (9063f42) is **not** in dc31c9b [R].
- **Approval model: queue + human approval.** Nothing is scheduled automatically.
  - The pending row (`status: pending`) is scheduled only after Carter or Jaime adds an HCP note `SCHEDULE MM/DD h:mm am - h:mm pm` (notes containing "MAVERICK" are skipped), or replies to the ops SMS with `SCHEDULE <estimateId> MM/DD …`. The id can be omitted if exactly one row is pending (approval-poller.ts:107-118,159-258).
  - HCP then notifies the customer [I, per note text].
- **Idempotency / dup guards:**
  - Address dedupe by house # + zip5 + unit [R].
  - Customer dedupe by name, first hit [R].
  - **No callSid idempotency.** A second BOOKING_REQUEST in the same call spawns a second pipeline, which creates a second estimate. `callSid` is stored but never checked [R].
  - Poller acts only on `status==='pending'` and flips it to `scheduled`. It keeps up to 500 seen SMS SIDs (approval-poller.ts:80-86) [R].
  - Dual-run warning for two pollers (README-BOOKING-POLLER.md:53) [R].
  - Possible lost-append race: the poller rewrites the file via tmp + rename (64-68) while voice appends concurrently [I].
- **Failure behavior:**
  - Validation, geocode, create or note/assign errors → pending row `failed_needs_manual` with the error, exit 1, ops FAILED alert with stderr tail (from-voice.ts:383-400; voice-server.ts:149-163) [R].
  - **Partial writes stay** (e.g., customer and estimate created, then the note fails). A manual retry would duplicate them [R].
  - Line-item errors → log only [R].
  - `searchCustomer` swallows errors and returns null, which leads to **creating a duplicate customer** when a search fails (estimates.ts:328-330) [R].
  - HCP 401 clears the cached cookie, throws, and the message says "run npm run login" (client.ts:67-72) [R].
  - Alert delivery failures are swallowed (alert.ts:104-116) [R].
- **Logging:**
  - `[from-voice]` stdout/stderr is piped into voice-server's PM2 log as `[voice-pipeline]`/`[voice-pipeline:err]` (voice-server.ts:138-143).
  - `data/pending-bookings.jsonl` is the durable record.
  - `data/pricebook-misses.jsonl` holds match misses.

---

## 4. Transfers / handoff

- **Numbers (env names only):** `CARTER_PHONE`, `JAIME_PHONE` (voice-server.ts:42-43,87-89). If either is missing at startup the server only warns (470-472) [R]. There's no dialed fallback number beyond the other person.
- **Trigger:** the LLM emits `[TRANSFER]{"kind":"general"|"emergency","target":"carter"|"jaime",...}`. The server speaks the text, logs to `data/voice-messages.jsonl`, then sends WS `{type:'end', handoffData}` after 100 ms. Unknown target → Carter; unknown kind → **emergency** (353-354,208) [R]. The preceding TTS may be cut off by the `end` [I].
- **`/handoff`** (195-213): parses `HandoffData`. No valid target → `<Hangup/>` (the normal end-of-call path). Otherwise returns `dialTwiml(target, kind, info, tried=target)`.
- **`dialTwiml`** (115-128): `<Dial timeout="25" action="/dial-result?tried=&kind=&info=">`.
  - **General** calls go through `<Number url="/whisper?info=…">`, a callee-side screen: "Grizzly call from {name}, about: {reason}. Press one to accept." with `<Gather numDigits=1 timeout=6>` (215-228). Digit 1 → empty `<Response/>`, which bridges. Anything else → `<Hangup/>` on the callee leg (230-240).
  - **Emergency** dials the bare number, no screen.
  - No `callerId` attribute, so Twilio's default caller ID applies. Likely the original caller's number is shown [I]. No `record`, no `timeLimit` [R].
- **`/dial-result`** (242-278):
  - `completed` → `<Hangup/>`.
  - First failure → "Still connecting you, one moment please." and dial the other person (`tried=both`).
  - Second failure → `voice-messages.jsonl {kind}_unreached`, spoken give-up message, hangup. **No alert and no HCP record.**
  - Unverified assumption in the code: a declined or unanswered screen reports as no-answer. If Twilio reports `completed` for a whisper-then-hangup leg, the fallback never fires and the caller is dropped. Needs a live test [I].
- **After hours (general):** blocked at voice-server.ts:356-370 and converted to a MESSAGE pipeline. Emergencies go through 24/7 [R].
- **WebSocket failure:**
  - WS drops mid-call → Twilio ends the relay and POSTs `/handoff` without HandoffData → `<Hangup/>`. The caller is disconnected, and nothing is captured unless a block was already emitted [R/I].
  - TRANSFER parsed after the WS closed → `ws.readyState` check skips the `end` → no transfer (385) [R].
  - WS can't be established at all (server or Funnel down, TLS/DNS) → Twilio never calls `/handoff` and the caller gets a Twilio error or silence. There's no detection in prod code; the watchdog branch is unmerged [I].
  - WS `error` → console only (460) [R].

---

## 5. Env var names and ports

**voice-server process** (PM2 `voice-server`: ecosystem.config.cjs:42-51, `node_modules/tsx/dist/cli.mjs src/agent/voice-server.ts`, cwd repo root, autorestart, max_restarts 10, restart_delay 5000, **no `env` block**, so everything comes from `.env`/dotenv plus the PM2 snapshot):
- Voice: `VOICE_PORT` (default 8765), `VOICE_PUBLIC_URL` (default `https://voice.grizzlyelectrical.net`, must be the Funnel :10000 URL), `VOICE_TTS_PROVIDER`, `VOICE_TTS_VOICE`, `CARTER_PHONE`, `JAIME_PHONE`.
- LLM (model-router.ts):
  - Venice: `VENICE_API_KEY` (**required at import**), `VENICE_BASE_URL`, `VENICE_TEXT_MODEL`, `VENICE_VISION_MODEL`.
  - z.ai: `ZAI_API_KEY` (effectively required for fallback resolution), `ZAI_BASE_URL`, `ZAI_MODEL`, `ZAI_VISION_MODEL`.
  - Per-role overrides: `MAVERICK_REASONING_MODEL`, `MAVERICK_REASONING_FALLBACK_MODEL` (and the other roles).
  - Optional: `MAVERICK_OPENAI_BASE_URL`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`.
- RAG: `RAG_URL` (default `http://192.168.1.12:8181`).
- HCP: `HCP_VIA_MCP`, `HCP_MCP_URL`, `HCP_MCP_TOKEN`, `HCP_COOKIES_FILE` (default `auth/hcp-cookies.json`).
- Audit: `AUDIT_RETENTION_DAYS`.
- Ops alerts (alert.ts:12-17): `NTFY_TOPIC`/`OPS_NTFY_TOPIC`, `NTFY_URL`, `OPS_TWILIO_ACCOUNT_SID`/`TWILIO_ACCOUNT_SID`, `OPS_TWILIO_AUTH_TOKEN`/`TWILIO_AUTH_TOKEN`, `OPS_SMS_FROM`, `OPS_SMS_TO`. `TWILIO_PHONE_NUMBER` is read only to refuse sending ops SMS from the customer line.

**from-voice child** (inherits the above), plus `CARTER_PRO_UUID`, `JAIME_PRO_UUID` (pro_ UUIDs for assign/notify) and `BOOKING_DEFAULT_LINE_ITEM`. The Anthropic SDK in price-book `claudeMatch` implicitly reads `ANTHROPIC_API_KEY` [I].

**booking-approval-poller** (ecosystem.config.cjs:52-61): `BOOKING_POLL_INTERVAL_MS`, `CARTER_PRO_ID`, `JAIME_PRO_ID` (numeric), `HCP_MCP_URL`, `HCP_MCP_TOKEN`, the ops SMS/Twilio vars above, cookie jar for the confirm note, and `TZ=America/Chicago` (required; README-BOOKING-POLLER.md:51).

**Ports / endpoints:**

| Endpoint | Where |
|---|---|
| voice-server :8765 → Funnel `aiwa.tailf72e3f.ts.net:10000` [I] | routes `/health`, `/twiml`, `/handoff`, `/whisper`, `/whisper-ok`, `/dial-result`, WS `/ws` |
| customer-chat-server :3012 (`CUSTOMER_CHAT_PORT`) → Funnel `/customer/webhook/twilio` [I] | SMS line |
| RAG | 192.168.1.12:8181 |
| HCP MCP daemon | CT102 :7332 |
| Census geocoder | `geocoding.geo.census.gov` |
| ntfy | default `ntfy.sh` |
| Twilio REST | `api.twilio.com` |
| Venice | `api.venice.ai` |
| z.ai | `api.z.ai` |
| HCP | `pro.housecallpro.com` |

**Persistent files under cwd `data/`:**
- `pending-bookings.jsonl` (shared with the poller; same cwd required)
- `voice-messages.jsonl`
- `audit.jsonl`
- `pricebook-misses.jsonl`
- `ops-sms-schedule-seen.json`
- `pricebook.csv` (read)
- `schedule-payload-template.json` (read)
- `auth/hcp-cookies.json`

**SMS (secondary, different service):** `customer-chat-server.ts` handles `POST /webhook/twilio` (457-476):
- Twilio signature validated against `${PUBLIC_URL}/webhook/twilio` (448). For the `/customer/...` path to validate, `PUBLIC_URL` must include `/customer` [I].
- `To == EMPLOYEE_PHONE_NUMBER` → employee agent with allowlist `data/employee-phones.json` (68-74,378-423).
- Everything else → customer price-range funnel persona (resolver.ts:211-295) with MessageSid claim idempotency in `data/sms-inbound-events.sqlite`, a 24 h session and 20 messages of history.
- `[ESTIMATE_READY]` → `from-chat.ts` subprocess (90 s timeout) creates the HCP estimate and sends it by HCP text/email, with ops alerts.
- Env: `CUSTOMER_CHAT_PORT`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `PUBLIC_URL`, `EMPLOYEE_PHONE_NUMBER`, plus the LLM, HCP and ops vars.
- It shares no state with voice. `employee-phones.json` has uncommitted prod edits.

---

## 6. What main (ac42ac9) changes vs dc31c9b for the voice path

`git diff dc31c9b ac42ac9 --stat`: 19 files. For voice:
- **9195ff9 `fix(voice)`** (the only voice-server change): `ttsProvider` is **always emitted**, with defaults `VOICE_TTS_PROVIDER=ElevenLabs` and `VOICE_TTS_VOICE=UgBBYS2sOqTuMpoF3BR0`. Adds `buildRelayTtsAttrs()` and `normalizeTtsVoice()` (strips the legacy `Polly.` prefix for Amazon), logs the TTS config at startup, adds `src/agent/voice-server.twiml.test.ts` (node:test), and documents `VOICE_TTS_*` in `.env.example`. Root cause: relay error 64106 ("callers heard silence", 2026-09-11). **Prod at dc31c9b lacks this**, so prod is safe only if its `.env` sets a compatible provider/voice pair [I].
- **9063f42 `fix(hcp)`:** adds `src/hcp/session-keepalive.ts`, `scripts/hcp-keepalive.ts`, `scripts/verify-keepalive.ts`, and a relogin rework. This keeps the **cookie jar** that voice booking still depends on (note fallback, poller confirm note, `HCP_VIA_MCP=false` path) alive without a browser. Its self-description calls the jar "the only thing standing between the voice booking path and another silent 401 outage". The jar is not in prod code. Whether AIWA has another refresh mechanism is unknown [I].
- **7bc341b:** removes `mav-slack` from `ecosystem.config.cjs`. Not voice. Prod's uncommitted ecosystem edit likely mirrors this [I].
- **ac42ac9:** customer-chat-server `POST /internal/thumbtack/reply` (loopback-only, `thumbtack` channel), a CT103 `booking-approval-poller.service` plus env template (**prep only**, not live), and a one-shot `scripts/add-booking-lines-once.ts`. No change to `from-voice.ts`, `approval-poller.ts`, `resolver.ts` (persona), tools, gateway or estimates.
- **Not on main:**
  - Branch `barnscarter-ops/voice-watchdog` (b7cb4ed, 3 commits, worktree `voice-watchdog/`): a systemd-timer watchdog for missed calls and Funnel failures, alerting to Slack #ops-alerts with SMS fallback. It is a proposed new ops capability, reviewed 2026-09-23, and deployment status is unknown.
  - Worktree `grizzly-livekit-c0-stage1` (102bc6a) is the migration candidate and was not reviewed here.

---

## 7. Parity checklist (must-carry) and known prod defects (don't copy blindly)

**Must carry:**
1. Greeting with AI disclosure
2. Office-hours gating (M-F 8-6, Sat 8-2, Central)
3. Caller-ID injection
4. Price ranges only, from the pricebook/RAG
5. Booking intake with required name/phone/house-number address, optional email/lead source, 2-3 windows, and the exact "next business day" promise
6. The from-voice HCP chain: geocode, customer and address dedupe, estimate, Service Fee + Troubleshoot L1/L2 lines, price-concern 50% discount, note format with the SCHEDULE instructions, assigning Carter + Jaime with push, pending row
7. Ops alert with the SCHEDULE reply hint, and the poller approval loop (HCP note or ops SMS)
8. Message taking to an HCP shell plus push
9. Verified caller-scoped appointment lookup (phone + last name, or name + address)
10. Reschedule request to an HCP shell
11. General transfer with whisper screen and "press 1", other-person fallback, give-up message
12. After-hours transfer converted to a message
13. Emergency: 911 advice for fire/smoke, geography routing, direct 24/7 dial
14. Refuse payments, never share personal numbers or other customers
15. Failure → `failed_needs_manual` + FAILED alert
16. audit/voice-messages/pending logs

**Prod defects / gaps to fix rather than replicate:**
- Successful messages send no ops alert.
- Unreached transfers leave only a jsonl line, with no alert or HCP record.
- Every reschedule is marked `needs_address_review`.
- Estimate lookup is promised but not implemented.
- "You're all set" is spoken before, and regardless of, pipeline success.
- No callSid idempotency, which allows duplicate estimates.
- Name-only customer match; a failed search creates a duplicate customer.
- `search_knowledge` can surface other customers' data.
- No Twilio signature or WS auth.
- DTMF enabled but ignored; interrupts ignored.
- Non-streaming replies cause dead air during tool calls.
- No spam/robocall filter, no call or silence limits, no recording or transcript retention.
- Emergency direct dial can land in personal voicemail.
- Whisper-decline semantics (`completed` vs `no-answer`) are untested.
- TTS default is broken unless `.env` overrides it.
- No detection when Twilio can't reach the server.
- No holiday hours.
- English only.
