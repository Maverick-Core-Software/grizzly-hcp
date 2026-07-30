# Voice agent — contact capture, HCP address writes, and schedule unblock

**Created:** 2026-07-29 by Claude Opus 5 (orchestrator)
**Target repo:** `C:\Workspace\Active\grizzly-hcp`
**Branch:** `voice-booking-capture` (off `sync-estimates-aiwa`)

**Why this plan exists.** Callers to the voice number are booked into HCP without a
usable service address or email, and no booking has ever reached `scheduled` —
`data/schedule-payload-template.json` still carries the `_UNCAPTURED` sentinel, so
`buildSchedulePayload` throws on every approval-poller tick. Three real bookings have
been stuck `pending` since 2026-07-24.

**Filename note.** This repo's `PLAN.md` is a *different, still-live* plan (HCP
credential consolidation, awaiting its 2026-08-02 timer observation). It must not be
overwritten or archived. This plan lives alongside it under its own name.

---

## Codebase Primer (orchestrator context — Qwen never sees this)

**Environment.** Windows 11, Node 20+, npm. TypeScript run through `tsx` — there is no
build step for the voice path and **no test framework**. Self-checks are standalone
`*.check.ts` files run directly (`npx tsx src/foo.check.ts`), using
`node:assert/strict` and printing `<name>.check OK` on success. Follow that convention
exactly; do not introduce Jest/Vitest.

**Voice call path.**
`voice-server.ts` (PM2 `voice-server`, port 8765) runs Twilio ConversationRelay. The
persona in `src/agent/resolver.ts` (`VOICE_INSTRUCTIONS`) emits a `[BOOKING_REQUEST]`
JSON block; `voice-server.ts` spawns `src/automations/bookings/from-voice.ts` as a tsx
subprocess with that payload on stdin. That pipeline writes to HCP and appends
`data/pending-bookings.jsonl`. `approval-poller.ts` (PM2 `booking-approval-poller`)
watches those estimates for a `SCHEDULE ...` note from Carter or Jaime.

**HCP access is dual-routed.** `src/hcp/gateway.ts` picks between `src/hcp/estimates.ts`
(direct HTTP, cookie session) and `src/hcp/mcp-client.ts` (the CT102 daemon) based on
`HCP_VIA_MCP`. Any new HCP write must be added to **both** modules and exported through
the gateway, or it will break under one of the two configurations.

**Gotchas.**
- `add_customer_address` on the MCP daemon takes the **numeric** customer id, not the
  `cus_xxx` UUID. `HcpCustomer.id` is the UUID. The numeric id comes from
  `GET /api/v2/pro/customers/{uuid}` → `contact_info.id`.
- `.env` is real and live — never print or commit secret values.
- Do not touch `PLAN.md`, `.serena/project.yml`, or `.pi-subagents/` (pre-existing
  dirty state belonging to other work).
- The MCP transport leaks a socket unless closed; entry points call `closeHcp()` on the
  success path. Anything new that runs as a one-shot CLI must do the same.

**Out of scope.** Jaime's missing dispatch notification is an HCP account setting, not a
code defect — live data confirms both pros are already in `assigned_pro_ids` on every
booking. Carter is handling it in the HCP UI.

---

## Session 1 — Census address geocoder

**Goal:** a standalone module that turns a spoken street-and-city string into complete,
structured address fields, with a passing self-check.
**Independent:** yes
**Stack / decisions:** US Census Bureau geocoder — free, no API key, no account, US-only.
Endpoint `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` with query
params `address` (URL-encoded), `benchmark=Public_AR_Current`, `format=json`. Use global
`fetch` (Node 20+). No new npm dependencies. The module must know nothing about HCP,
bookings, or the voice agent — address in, address out.

**Tasks:**
1. Create `src/hcp/geocode.ts` exporting `resolveAddress`. It takes one free-text
   address string and returns the structured result on a confident match, or `null`
   when the geocoder returns no match, the request fails, or the input is blank.
   Read the first entry of `result.addressMatches` from the response. Take `city`,
   `state`, and `zip` from that entry's `addressComponents`; take latitude from
   `coordinates.y` and longitude from `coordinates.x`; derive the street line from the
   leading portion of `matchedAddress` (the text before the first comma). Never throw on
   a network error or unexpected shape — catch and return `null`, because the caller
   treats `null` as "ask a human", and an exception here would kill a live booking.
   Apply a request timeout (10 seconds) via `AbortSignal.timeout` so a hung geocoder
   cannot stall the booking pipeline.
2. Create `src/hcp/geocode.check.ts` following the existing `*.check.ts` convention
   (`node:assert/strict`, prints `geocode.check OK`). It must cover: a real full
   address resolving with the expected state and a 5-digit zip; a street-plus-city
   input with no zip still resolving to a state and zip; a nonsense input returning
   `null`; and an empty string returning `null` **without** issuing a network request.
   Mark the network-dependent assertions so a reader can tell they need connectivity.

**Interfaces:**
- `resolveAddress(freeText: string): Promise<ResolvedAddress | null>`
- `interface ResolvedAddress { street: string; city: string; state: string; zip: string; latitude: number; longitude: number }`

**Verification:**
- Run: `npx tsx src/hcp/geocode.check.ts` — expected: prints `geocode.check OK`, exit 0.
- Run: `npx tsc --noEmit` — expected: no errors reported in `src/hcp/geocode.ts` or
  `src/hcp/geocode.check.ts`.

**Commit:** `feat(hcp): census geocoder for partial voice addresses`

---

## Session 2 — HCP customer-address write path

**Goal:** the codebase can write a service address onto an existing HCP customer through
both the direct-HTTP and MCP-daemon routes, selected by the existing gateway.
**Independent:** yes
**Stack / decisions:** This repo routes every HCP write through `src/hcp/gateway.ts`,
which chooses between `src/hcp/estimates.ts` (direct HTTP via the cookie session) and
`src/hcp/mcp-client.ts` (the CT102 MCP daemon) based on the `HCP_VIA_MCP` env flag. A
write added to only one of those modules breaks the other configuration, so both are
required. Do not add npm dependencies. Follow each file's existing style — the direct
module uses the local `hcpGet`/`hcpPost` helpers, the MCP module uses its local
`callTool` helper.

**Tasks:**
1. Modify `src/hcp/mcp-client.ts` — add an exported `addCustomerAddress` that calls the
   daemon's existing `add_customer_address` tool via `callTool`. The tool's arguments
   are named `customer_id`, `street`, `city`, `state`, `zip`, and optionally `latitude`,
   `longitude`, `street_line_2`. **`customer_id` must be the numeric HCP customer id,
   not the `cus_xxx` UUID** — the tool rejects the UUID. The tool responds with an
   `address` object carrying `id` (an `adr_xxx` UUID) and `printableAddress`; return
   that id.
2. Modify `src/hcp/estimates.ts` — add an exported `addCustomerAddress` with the
   identical signature, implemented against the direct HTTP path:
   `POST /api/v2/pro/customers/{numericId}/addresses`. The response carries `uuid` and
   `printable_address`; return the uuid. Also add an exported helper that resolves a
   `cus_xxx` UUID to its numeric id via `GET /api/v2/pro/customers/{uuid}`, reading
   `contact_info.id` — both routes need it, and Session 3 calls it directly.
3. Modify `src/hcp/gateway.ts` — export `addCustomerAddress` switched on `HCP_VIA_MCP`,
   matching the exact pattern of the existing exports on the lines above it.

**Interfaces (spell these exactly):**
- `addCustomerAddress(numericCustomerId: string, addr: { street: string; city: string; state: string; zip: string; latitude?: number; longitude?: number; streetLine2?: string }): Promise<string>` — resolves to the new `adr_xxx` address UUID.
- `resolveNumericCustomerId(customerUuid: string): Promise<string>` — exported from `src/hcp/estimates.ts`.
- MCP tool name: `add_customer_address`. Gateway export name: `addCustomerAddress`.

**Verification:**
- Run: `npx tsc --noEmit` — expected: no errors in `src/hcp/mcp-client.ts`,
  `src/hcp/estimates.ts`, or `src/hcp/gateway.ts`.
- Confirm by reading the files: `addCustomerAddress` is exported from all three modules,
  and the gateway line follows the same `HCP_VIA_MCP ? mcp.x : direct.x` shape as its
  neighbours.
- Do **not** call the live HCP API in this session. There is no self-check to write
  here; the live exercise happens in Session 3's verification.

**Commit:** `feat(hcp): add customer service addresses via both routes`

---

## Session 3 — Voice booking pipeline writes real contact data

**Goal:** a voice booking creates an HCP customer carrying the caller's real phone,
email, and geocoded service address, and the estimate is attached to that address.
**Independent:** no — requires Sessions 1 and 2.
**Stack / decisions:** Modify only `src/automations/bookings/from-voice.ts`. It is spawned
per call by `voice-server.ts` with JSON on stdin shaped
`{ kind, payload, callerPhone, callSid }` and must keep that contract. Its current order
is create-customer → create-estimate → note → assign, and the address is written only
into the note text, never onto the customer — that is the defect. The existing failure
path, which appends a `failed_needs_manual` record so a caller is never lost, must be
preserved. These interfaces exist as of Sessions 1 and 2:
`resolveAddress(freeText) -> Promise<ResolvedAddress | null>` from `src/hcp/geocode.js`;
`addCustomerAddress(numericCustomerId, addr) -> Promise<string>` from
`src/hcp/gateway.js`; `resolveNumericCustomerId(customerUuid) -> Promise<string>` from
`src/hcp/estimates.js`.

**Tasks:**
1. Rework the `booking` and `reschedule` path ordering in
   `src/automations/bookings/from-voice.ts` to: geocode the address → find or create the
   customer → write the address onto that customer → create the estimate against the
   returned `adr_xxx` → post the note → assign pros → append the pending record. The
   estimate must be created against the address id returned by `addCustomerAddress`,
   **not** the current `customer.addressId ?? ''` fallback, which is what produces
   addressless estimates today. The `message` kind does not collect an address and must
   keep its current behaviour.
2. Close the existing-customer update gap. Today, when `searchCustomer(name)` returns a
   match, the phone, email, and address from this call are silently discarded. On a
   match, still write the new address, and record in the note that this was an existing
   customer match so the office can reconcile contact details by hand. Do not attempt to
   overwrite an existing customer's stored name.
3. Handle a failed geocode without losing the booking. When `resolveAddress` returns
   `null`, do **not** invent an address and do not call `addCustomerAddress`. Create the
   estimate the old way, set the pending record's status to `needs_address_review`
   instead of `pending`, and state plainly at the top of the note that the spoken address
   could not be verified — including the raw text the caller gave. `needs_address_review`
   must be a status the approval poller ignores; it only acts on `pending`.
4. Replace the misleading synthetic email. The current fallback builds
   `voicemail+<digits>@grizzlyelectrical.net`, which looks like a real address. When the
   caller gave no email, use `no-email+<digits>@grizzlyelectrical.net` instead and add an
   explicit `Email: NOT PROVIDED` line to the note. When the caller did give one, use it
   and show it in the note. Keep a non-empty value — HCP's customer create currently
   requires an email field.

**Interfaces:**
- Pending-record statuses after this session: `pending`, `needs_address_review`,
  `message_delivered`, `reschedule_pending`, `failed_needs_manual`.
- Note must carry, on their own lines: `Address:`, `Email:`, `Callback:`.

**Verification:**
- Run: `npx tsc --noEmit` — expected: no errors in
  `src/automations/bookings/from-voice.ts`.
- Run the pipeline against a **fake** caller by piping a booking JSON payload into
  `npx tsx src/automations/bookings/from-voice.ts` on stdin, using the obviously-test
  name `Test Voice Capture` and a real-looking street-and-city address with no zip.
  Expected: exit 0, and the printed JSON reports an `estimateUuid`. Then confirm the
  appended line in `data/pending-bookings.jsonl` has status `pending` and a non-empty
  `address`. Report the created estimate id in your summary so it can be cleaned up.
- Feed a second payload with a deliberately unresolvable address (e.g.
  `zzz nonexistent street, nowhere`). Expected: exit 0 and a `needs_address_review`
  record — the run must not throw.

**Commit:** `fix(voice): write caller address, phone, and email into HCP`

---

## Session 4 — Voice persona capture rules

**Goal:** the phone persona asks for an email, treats phone and address as required
before booking, and stops asking callers for their zip code.
**Independent:** yes
**Stack / decisions:** Modify only the `VOICE_INSTRUCTIONS` string in
`src/agent/resolver.ts`. This text is spoken aloud through text-to-speech, so every rule
in the existing `## SPEECH RULES` block still applies — short sentences, one question at
a time, no markdown. Do not restructure the prompt or touch any other channel's
instructions (`CLI_SUFFIX`, `SLACK_SUFFIX`, `EMPLOYEE_INSTRUCTIONS`,
`CUSTOMER_INSTRUCTIONS`). The `[BOOKING_REQUEST]` JSON block already has an `email`
field; its shape does not change.

**Tasks:**
1. Rewrite the `## BOOKING FLOW` collection steps so the agent asks for the caller's
   email as its own numbered step, phrased as a single best-effort ask — if the caller
   declines or does not have one, accept that, move on, and send an empty string. The
   agent must never invent, guess, or spell out an email on the caller's behalf.
2. Make phone and address hard requirements in that same block. State explicitly that
   the agent must not emit `[BOOKING_REQUEST]` without both a callback number and a
   service address, and that if the caller will not give an address it should switch to
   the existing MESSAGE FLOW so the lead is still captured as a message rather than a
   booking.
3. Change the address ask to request street and city only, and add an explicit
   instruction not to ask for a zip code — the system now completes it. Keep the existing
   rule that the agent must ask a caller to repeat anything it did not catch rather than
   guessing an address.

**Verification:**
- Run: `npx tsc --noEmit` — expected: no errors in `src/agent/resolver.ts`.
- Read the modified `VOICE_INSTRUCTIONS` back and confirm all of: an email step exists
  and is marked optional; the no-booking-without-phone-and-address rule is stated; the
  do-not-ask-for-zip rule is stated; the `[BOOKING_REQUEST]` block's field list is
  unchanged from before your edit.
- Confirm no other exported string in the file was modified.

**Commit:** `feat(voice): require phone and address, ask for email`

---

## Operator Session O1 — schedule payload template (orchestrator + Carter)

**Not for Qwen.** This session reads live HCP data and performs one production write
against a real customer booking. It is executed by the orchestrator with Carter's
explicit approval, following the same operator-session pattern as this repo's other
plan. Recorded here so the plan is complete.

1. Using the read-only `hcp_api_get` passthrough on the CT102 daemon, inspect a job that
   is already scheduled in HCP and reconstruct the `update_schedule` request body from
   its schedule fields. Note that `assigned_pro_ids` are **numeric** (e.g. 722501), while
   `assignTechnician` uses `pro_xxx` UUIDs — the template's `"%PRO_UUIDS%"` token may
   need to become numeric ids.
2. Write the reconstructed body into `data/schedule-payload-template.json`, replacing
   the `_UNCAPTURED` sentinel, with the `%START_ISO%`, `%END_ISO%`, and `"%PRO_UUIDS%"`
   tokens substituted per the contract in `src/hcp/schedule-payload.ts`.
3. Validate against exactly **one** of the three stuck bookings, with Carter's approval
   for that specific write. Confirm the job shows as scheduled in HCP and that the
   customer received HCP's built-in appointment notification — the job data already
   shows `notification_enabled.estimate_scheduled = true`, so no new notification code
   is needed.
4. If the reconstruction does not produce a working payload, **stop**. Fall back to the
   designed manual path (`npm run intercept` while Carter schedules one job by hand).
   Do not guess at a write body against live customer records.

---

## Session 5 (final) — docs + brain-write

**Goal:** project docs and memory reflect this build. All three targets are REQUIRED.
**Independent:** no

You are documenting an already-completed build. Do not change any source file. Write
only the three documentation targets below, then commit. Every fact you need is listed
here — do not infer, and do not go looking for more.

**The facts this build established (record these, not a summary of the code):**

- The voice booking path now captures and writes real contact data. `from-voice.ts`
  geocodes the spoken street + city through the US Census geocoder (zip is completed by
  the system, never asked of the caller), resolves or creates the customer, attaches a
  service address, creates the estimate against that address, posts a
  `MAVERICK BOOKING REQUEST` note, and assigns Carter + Jaime so HCP pushes them a
  notification.
- Status `needs_address_review` is written when geocoding fails. The approval poller
  ignores it — it only acts on status `pending`. An operator must fix the address in HCP
  by hand and then schedule it manually; nothing retries automatically.
- The voice persona (`src/agent/resolver.ts`) now requires a callback number and a
  street + city before it may emit `[BOOKING_REQUEST]`. Email is one best-effort ask and
  an empty string is acceptable. If the caller refuses phone or address, the persona
  falls back to the message flow instead of booking.
- `update_job_schedule` requires **numeric** pro ids — `CARTER_PRO_ID=722501`,
  `JAIME_PRO_ID=723719` — not the `pro_xxx` UUIDs used by `assignTechnician` for
  dispatch. Both are now in `.env`. Confusing the two was why scheduling silently failed.
- Schedule times are emitted with an explicit local UTC offset by `toOffsetIso()` in
  `approval-poller.ts`. `Date.toISOString()` cannot be used here: it always emits `Z`, so
  any Central evening appointment rolled the calendar date forward a full day in the
  `start_date` HCP derives from it.
- Repeat callers no longer accumulate duplicate address records.
  `findCustomerAddress()` in `src/hcp/estimates.ts` matches an existing address on house
  number + 5-digit zip + unit. Exact string matching does not work, because the Census
  geocoder normalizes what the caller said ("15221 Berry Trail" → "15221 BERRY TRL"), so
  the same house yields two different strings. A failed lookup falls through to creating
  an address rather than blocking the booking.
- Operator Session O1 is complete. The real `update_schedule` body was captured live and
  written into `data/schedule-payload-template.json`; the `_UNCAPTURED` sentinel is gone.
- The path was verified end to end on a test customer, unattended, through the poller —
  the first time that path ran without a human in the loop.
- Deployment is PM2 on CartersPC, not AIWA. `from-voice.ts` needs no restart because
  `voice-server` spawns it fresh per call. The persona is an in-process import, so
  `voice-server` **was** restarted on 2026-07-29 to pick it up, as was
  `booking-approval-poller` for its fix.
- Relevant commits on branch `voice-booking-capture`: `8a30855` / `efb0886` (contact
  data written to HCP), `d9e1b6f` (persona capture rules), `bb34f01` (schedule payload
  captured; pro-id and timezone bugs fixed), `a1e13f5` (existing service address reused
  instead of duplicated).

**Tasks:**
1. Update `memory/HANDOFF.md` — describe the current state of the voice booking path
   using the facts above. Correct the `Repo Facts` section: the branch is now
   `voice-booking-capture`, and list the four commits above. Leave the existing
   `Loose Ends` entries alone.
2. Append a dated `## 2026-07-29 — voice booking captures real contact data` entry to
   `memory/JOURNAL.md`. **Append only** — the file is dated history and existing entries
   must not be edited or reordered.
3. Append a dated `## 2026-07-29 — voice booking captures real contact data` section to
   the brain vault project note at `C:\Workspace\Active\brain\projects\grizzly-hcp.md`.
   That file follows the same append-only dated-section convention; the newest section
   there is `## 2026-07-29 — Weekly sync jobs monitored; on-host test venv on AIWA`, so
   add yours after it. This target is **not optional** — skipping it fails the session.
   It is outside the repo, so it is committed separately in the brain vault, not here.

**Verification:** run `git diff --stat` in the repo and confirm only `memory/HANDOFF.md`
and `memory/JOURNAL.md` changed — no source files. Run
`git diff memory/JOURNAL.md` and confirm it shows additions only, no deletions.
Confirm `C:\Workspace\Active\brain\projects\grizzly-hcp.md` contains the new section.
**Commit:** `docs: update handoff + journal + brain note - voice contact capture`

---

## Revisions

**2026-07-29 — Session 5 rewritten before dispatch.** The original text predated two
fixes that only surfaced during Operator Session O1 and the live e2e: the numeric-pro-id
and `toISOString()` timezone bugs in the approval poller (`bb34f01`), and address
duplication on repeat callers (`a1e13f5`). Session 5 now carries the specific facts to
record, since the executor receives only its own section and cannot observe an operator
session. Also added the append-only constraint on the brain vault note and the explicit
"do not change source files" boundary. No scope or design change.
