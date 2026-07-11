# Maverick Voice — Full-Time Phone Line Upgrade

**Date:** 2026-07-11
**Repo:** grizzly-hcp
**Status:** Approved by Carter (design conversation 2026-07-11)

## Goal

Make the Maverick Twilio voice line the full-time number behind Grizzly's public phone number. Maverick answers every call, triages, and handles: pricing questions (ranges + disclaimer), booking requests, messages for Carter/Jaime, screened transfers during business hours, and caller-verified appointment/estimate lookups with reschedule requests.

## What already exists (unchanged)

- `src/agent/voice-server.ts` — Twilio ConversationRelay adapter (greeting, WS session, block extraction, emergency transfer with dial fallback, booking/message pipeline spawn).
- `src/agent/resolver.ts` — `VOICE_INSTRUCTIONS` persona and `VOICE_INCLUDED` tool allow-list (`search_pricebook`, `lookup_pricing`, `search_knowledge`).
- `src/automations/bookings/from-voice.ts` — pipeline for `booking` and `message` kinds.
- Emergency flow: 24/7 transfer, geography-routed (Jaime northeast / Carter south), fallback to the other person, then polite give-up + logged message. Stays exactly as-is.

## Decisions made

1. **Estimates on the call** = current behavior, polished: give general price ranges from `search_pricebook`/`lookup_pricing` with an explicit disclaimer that real pricing varies with many factors and is confirmed on-site; then offer the booking flow. No on-call estimate creation, no `ESTIMATE_READY` from voice.
2. **General transfers**: screen first (who's calling + what about), transfer only during business hours, message after hours. Emergencies always transfer.
3. **Reschedules**: request-only. Maverick never writes to HCP. Office confirms and moves the appointment.
4. **Caller verification**: caller-ID match + name confirmation; if caller ID doesn't match a customer record, name + service address must both match before any account details are shared.
5. **Appointment/estimate data**: live read-only HCP lookup scoped to the verified caller, enforced in code — not RAG snapshots.
6. **Public number**: keep (469) 863-9804 on the website and everywhere else. Carter sets up carrier call-forwarding to the Twilio number. No website changes. Optional future step: port the number into Twilio. Test that forwarded calls preserve the original caller ID before going full-time.

## Components

### 1. Persona update — `resolver.ts` `VOICE_INSTRUCTIONS`

- Strengthen the pricing disclaimer wording ("pricing depends on many factors — panel condition, wire runs, permits — so we confirm the exact price on-site").
- New **TRANSFER REQUEST flow** (non-emergency): collect caller name + one-line reason. If the office-hours note (injected by the server, see below) says OPEN, emit `[TRANSFER]{"kind":"general","target":"<jaime|carter>","callerName":"...","reason":"..."}`. Target by the same geography rule as emergencies when the caller mentions a city; otherwise default Carter. If CLOSED, explain the office is closed and offer to take a message (existing MESSAGE flow).
- New **APPOINTMENT LOOKUP flow**: verify identity per decision 4, call `lookup_my_appointments`, read back only that caller's upcoming visit(s)/open estimate(s) in natural speech. For reschedules, collect 2–3 new preferred windows and emit `[RESCHEDULE]{"jobId":"...","customerName":"...","callbackPhone":"...","currentTime":"...","preferredWindows":[...]}`; say the office will confirm the new time within the next business day. Never promise the change is made.
- "Never discuss other customers" rule stays; the tool makes it structurally true.

### 2. Business-hours awareness — `voice-server.ts`

- Server computes office status in **America/Chicago**: Mon–Fri 08:00–18:00, Sat 08:00–14:00 (matches website schema). Constants in code with env overrides unnecessary (ponytail: edit source to change hours).
- Each prompt turn appends a note alongside the existing caller-ID note: `(Office is currently OPEN)` / `(Office is currently CLOSED)`. The persona keys transfer behavior off this.
- Server also guards: a `[TRANSFER]` block with `kind:"general"` received while CLOSED is not dialed — logged, and the pipeline files it as a message instead (belt and suspenders against persona drift). Emergency transfers (no `kind` or `kind:"emergency"`) always dial.

### 3. Screened (whisper) transfer — `voice-server.ts`

- `/handoff` for a general transfer dials with `<Dial><Number url="PUBLIC_URL/whisper?...">` where the whisper endpoint returns `<Gather numDigits="1"><Say>Call from {name} about {reason}. Press 1 to accept.</Say></Gather>` and hangs up the callee leg if no digit — so voicemail never swallows the call and no-answer/decline falls through to the existing `/dial-result` fallback chain (other person → both-failed message).
- Emergency transfers keep today's direct dial (no whisper — speed matters).
- Screen info (`callerName`, `reason`) travels in `handoffData` and is URL-encoded into the whisper endpoint query.

### 4. Caller-scoped lookup tool — new `src/agent/tools/reads/voice-lookup.ts`

- One tool: `lookup_my_appointments`.
  - Input: `callerPhone` (from caller ID or stated), optional `name`, optional `address`.
  - Behavior: find the HCP customer whose phone matches `callerPhone`; if none, require BOTH `name` and `address` to match a customer record (fuzzy-tolerant on formatting, strict on identity). Return only that customer's upcoming scheduled jobs (id, scheduled window, short description, address) and open estimates (id, status, scope summary, total range) via live HCP reads (`hcpGet` on jobs/estimates endpoints already used by `check_schedule`/`estimates.ts`).
  - No match → returns a "no record found" result; the persona apologizes and offers to take a message. Never returns other customers' data — scoping enforced in the tool, not the prompt.
- Add `lookup_my_appointments` to `VOICE_INCLUDED` in `resolver.ts`. The broad tools (`check_schedule`, `list_open_jobs`, `lookup_customer`) stay excluded from voice.

### 5. Reschedule pipeline — `src/automations/bookings/from-voice.ts`

- New kind `reschedule` alongside `booking`/`message`: same notification path to Carter/Jaime, payload includes HCP `jobId`, current scheduled time, and new preferred windows so whoever handles it can move the job in HCP in one step.

### 6. Manual/ops steps (Carter)

- Set up carrier call-forwarding: (469) 863-9804 → Twilio voice number.
- Joint test call before going full-time: confirm original caller ID passes through forwarding (Maverick's verification depends on it). If the carrier masks caller ID, fall back to name+address verification always, or prioritize porting the number to Twilio.

## Error handling

- HCP lookup failure/timeout → tool returns an error field; persona says it can't pull records right now and offers a message/callback (mirrors existing agent-error fallback).
- Bad/missing digit on whisper Gather → treated as decline → normal fallback chain.
- After-hours general `[TRANSFER]` → converted to message (component 2).

## Testing

- Unit-ish: business-hours function (boundaries, Saturday, Sunday, timezone); block parsing for new `kind` and `[RESCHEDULE]`; lookup tool scoping (phone match, name+address match, no-match returns nothing).
- Manual end-to-end via `scripts/test-voice-local.ts` + real test calls: general transfer accept/decline/no-answer, after-hours message path, appointment verify + reschedule, emergency path regression.

## Out of scope

- Website changes, HCP writes from voice, number porting, payments, RAG re-indexing of jobs (live lookup replaces the need).
