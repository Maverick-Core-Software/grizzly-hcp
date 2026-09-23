# C0 staff rehearsal

This is a staff-only live test after GO-LIVE step 15 says **READY FOR REHEARSAL**. Carter calls only from the `VOICE_C0_ALLOWED_CALLERS`/allowlist cell, records times and redacted evidence, and invokes the kill switch on any silence, unexpected route, production impact, or unredacted data; no customer calls and no production numbers participate.

Before each scenario, confirm the canary DID is on ingress, `VOICE_C0_ENABLED=true`, and `pwsh -NoProfile -File canary/c0/c0ctl.ps1 status all` reports the three C0 processes running; keep the fallback command ready: `npx tsx canary/c0/provision/twilio-number-route.ts --apply --to fallback`.

| Scenario | Carter action | Expected caller experience | Evidence to collect / stop condition |
|---|---|---|---|
| A. Normal intake | Call the canary DID; provide name, callback, service address, broad scope, and preferred windows; confirm the read-back. | Agent reads details back, never promises booking/price/availability, says: “The office will review your request and contact you.” | Redacted agent launcher-log timing; one C0 outbox record; masked ntfy alert only. Stop if copy promises service or any identifier appears in alert/log evidence. |
| B. Requested person | Say “let me talk to a person”; office recipient answers the screen and presses `1`. | Caller is transferred to office only after the screen acceptance and is bridged. | Function/Dial action evidence, masked transfer intent/marker, and staff confirmation of bridge. Stop if destination is bridged before `1` or caller is disconnected. |
| C. Office decline/no answer | Repeat B but do not press `1` or do not answer; let office timeout, then repeat for backup and leave voicemail. | No acceptance advances to backup; backup failure reaches voicemail; caller hears voicemail copy and can leave a message. | Masked Function callback/ntfy evidence and staff timing; voicemail notification must be redacted. Stop on silence, looping, or a Dial result treated as success without `DialBridged=true`. |
| D. Silence | During a connected agent call, remain silent for 20 seconds. | Agent gives one check-in after the 15-second away timeout, then transfers to office/humans if silence persists. | Launcher redacted timing plus transfer/fallback evidence. Stop if no check-in/transfer occurs or the call is silent. |
| E. Kill switch | During an active session, run the fallback route command; then place a **new** staff call. | Existing call may complete/fallback according to current TwiML; the new call goes directly to humans through the fallback route within 60 seconds. | Route evidence proving only `voice_url` changed, timestamped new-call result. Stop if new call reaches LiveKit/agent or no human path. |
| F. Non-allowlisted caller | If a second phone is available, call from it. | It bypasses agent admission and goes straight to human fallback. | Masked route/callback evidence and staff observation. Mark `NOT RUN` if no second phone is safely available; do not fabricate a caller identity. |
| G. Agent-independent fallback | With the DID restored to ingress under a separate explicit approval, stop only `c0-agent`: `pwsh -NoProfile -File canary/c0/c0ctl.ps1 stop agent`; call the DID; after test, do not restart until approved. | Twilio `<Dial>` times out and fallback reaches humans without the agent process. | Launcher status, Dial timeout/action evidence, and staff confirmation. Stop if silence occurs or a non-C0 process is targeted. |
| H. Detector first audio | Carter manually adds `VOICE_C0_REHEARSAL_SILENT_START=true` to the protected `canary/c0/.env.c0`, then—under the separate approved launcher lifecycle action—restarts only `c0-agent` with `pwsh -NoProfile -File canary/c0/c0ctl.ps1 restart agent`. `set-enabled.ts` is not used: it changes only `VOICE_C0_ENABLED`. | The agent joins but remains silent and writes no first-audio marker for 15 seconds; the independent detector redirects the answered staff call to office/humans at about 6 seconds after answer, with a redacted detector alert. | Collect redacted detector log, `redirected` marker timing, transfer flag, and fallback result. Immediately after H, Carter manually removes `VOICE_C0_REHEARSAL_SILENT_START` from `.env.c0` and, under separate approval, restarts only `c0-agent` before any further calls; stop if the switch remains present or any caller is silent without the detector route. |

## Sign-off

| Gate | Carter result/date | Evidence path(s) | Notes |
|---|---|---|---|
| A normal intake and outbox/ntfy redaction |  |  |  |
| B screened office bridge |  |  |  |
| C decline/no-answer to voicemail |  |  |  |
| D silence transition |  |  |  |
| E kill switch new-call effect |  |  |  |
| F non-allowlisted fallback |  |  | `NOT RUN` allowed only when no second phone is available. |
| G agent-independent fallback |  |  |  |
| H detector first-audio |  |  | `bench-verified only` must be explicit if not safely simulated. |
| Production guard hash unchanged after rehearsal |  |  | Re-run GO-LIVE step 15; any difference is a stop condition. |

## Parity gate (PG1–PG15): business-line migration

These scenarios implement the practice-call gate in `docs/2026-09-23-business-line-migration-plan.md` §4. They run **only after** these are approved:
- the parity build (WP-A–WP-D) is on the canary, hosted in the CT101 sandbox, under approvals P2 and P3 of that plan;
- HCP writes are limited to the test customer "ZZ TEST Carter Voice" (P4).

A–H above are re-run on the parity build first.

**Ground rules:**
- Carter calls only from the allow-listed cell.
- Any failed row, or any §1 parity row that cannot be exercised, **fails the gate**, and production cutover does not proceed.
- Emergency routing is exercised with the destinations pointed at staff phones that expect the test.

| Scenario | Carter action | Expected caller experience | Evidence / stop condition |
|---|---|---|---|
| PG1 New-customer booking | As a new caller, give name, callback, address (house # + street + city), email by voice, lead source, issue, and 2-3 windows. Confirm the read-back. | One question at a time. Correct read-back, including the email. The confirmation line approved in Q6 is spoken only after the save. No firm price. | Test-customer estimate created with Service Fee + Troubleshoot line, the SCHEDULE note, and Carter/Jaime assigned. Pending row created. #ops-alerts alert with the SCHEDULE hint. Stop if the confirmation is heard before the save, or a duplicate estimate appears. |
| PG2 Duplicate-confirmation guard | During PG1, say "yes, that's right" twice, or ask to "save it again". | No second booking. | Exactly one estimate and one pending row for the call (intent key). Stop on any duplicate. |
| PG3 Appointment lookup | Ask "when is my appointment?" from the test customer's number, and give the last name. | The scheduled time is read back. With a wrong last name, nothing is disclosed. | Redacted audit shows `verified` / `refused`. Stop if any detail is disclosed without verification. |
| PG4 Reschedule request | Ask to reschedule the test job and give 2-3 windows. | The current time is read back. "We'll confirm the new time…" is said. The job is never said to be moved. | HCP shell with the RESCHEDULE note and **the job's address** (not `needs_address_review`). Alert delivered. |
| PG5 Message | Ask to leave a message. | "Got it. I'll pass that along right away." | HCP message shell plus push, **and** an #ops-alerts alert. |
| PG6 Price range | Ask "how much to add an outlet?" | A range plus "confirmed on-site". Never a firm price. | Tool result shape is range-only. Stop on any firm quote. |
| PG7 Knowledge / privacy | Ask about service area, then ask about "my neighbor's job on Elm St". | Service area is answered. Other customers are refused. | Knowledge filter log shows `[CUSTOMER]` records dropped. |
| PG8 General transfer (office hours) | Ask for Jaime by name and give the reason. | "One moment while I try to connect you." Jaime's whisper states the name and reason. Pressing 1 bridges the call. | Function and Dial evidence showing `DialBridged=true`. Stop if the call bridges before 1 is pressed. |
| PG9 Decline → other → voicemail | Repeat PG8. Jaime declines and Carter doesn't answer. | "Still connecting you…", then voicemail copy and a beep. | #ops-alerts voicemail alert with the recording reference, plus an HCP message shell. Stop on silence or looping. |
| PG10 Emergency | (a) "I smell smoke": expect 911 advice and **no transfer**. (b) "Sparking panel in Rowlett": the city is asked, then a direct dial to the NE target. | Production emergency wording. | Routing evidence (target role only, masked). Stop if (a) transfers, or (b) is screened or misrouted. |
| PG11 After hours | With the sandbox office-clock override set to Closed (sandbox only), ask for a person. | The call becomes a message. The closed-hours fallback copy plays. | Message shell plus alert. The override is removed afterwards and its removal is recorded. |
| PG12 HCP outage | In the sandbox, make hcp-mcp unreachable from CT101 (approved sandbox action), then do a booking and a lookup. | Lookup: "can't pull that up… have the office call you". Booking: the confirmation is still honest, because the save is local. | `failed_needs_manual`/retry, then `human_reconciliation_required` plus an alert. After restore, a retry creates no duplicate. |
| PG13 Mid-call model drop | During a session, block OpenAI egress from CT101 (approved sandbox action). | Transfer to humans within the silence window. **Never** silence. | Agent error/close handler log plus fallback evidence. |
| PG14 Rollback timing | Run the canary kill switch mid-session, then place a new call. | The new call reaches humans. | Only `voice_url` changed. Time to effect is ≤ 60 s. |
| PG15 Line-check probe policy | From the ops probe number (…1546), place a call to the canary. | The agent answers, and the call is **never forwarded to a human**. | Per-call record `probe=true`, `first_audio` present. Call completed and lasted at least 10 s. |

| Parity gate row | Carter result/date | Evidence path(s) | Notes |
|---|---|---|---|
| A–H re-run on parity build |  |  |  |
| PG1–PG15 |  |  |  |
| HCP test records cleaned up |  |  |  |
| **Gate PASSED (Carter)** |  |  |  |

## TBD list

- No agent-owned TBD remains. Scenario H is deliberately a Carter-performed manual `.env.c0` edit because `set-enabled.ts` changes only `VOICE_C0_ENABLED`; remove the rehearsal switch and restart only `c0-agent` before another call.
