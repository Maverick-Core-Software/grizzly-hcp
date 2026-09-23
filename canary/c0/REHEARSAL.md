# C0 staff rehearsal

This is a staff-only live test after GO-LIVE step 15 says **READY FOR REHEARSAL**. Carter calls only from the `VOICE_C0_ALLOWED_CALLERS`/allowlist cell, records times and redacted evidence, and invokes the kill switch on any silence, unexpected route, production impact, or unredacted data; no customer calls and no production numbers participate.

Before each scenario, confirm the canary DID is on ingress, `VOICE_C0_ENABLED=true`, the three filtered PM2 apps are online, and keep the fallback command ready: `npx tsx canary/c0/provision/twilio-number-route.ts --apply --to fallback`.

| Scenario | Carter action | Expected caller experience | Evidence to collect / stop condition |
|---|---|---|---|
| A. Normal intake | Call the canary DID; provide name, callback, service address, broad scope, and preferred windows; confirm the read-back. | Agent reads details back, never promises booking/price/availability, says: “The office will review your request and contact you.” | Redacted agent/PM2 log timing; one C0 outbox record; masked ntfy alert only. Stop if copy promises service or any identifier appears in alert/log evidence. |
| B. Requested person | Say “let me talk to a person”; office recipient answers the screen and presses `1`. | Caller is transferred to office only after the screen acceptance and is bridged. | Function/Dial action evidence, masked transfer intent/marker, and staff confirmation of bridge. Stop if destination is bridged before `1` or caller is disconnected. |
| C. Office decline/no answer | Repeat B but do not press `1` or do not answer; let office timeout, then repeat for backup and leave voicemail. | No acceptance advances to backup; backup failure reaches voicemail; caller hears voicemail copy and can leave a message. | Masked Function callback/ntfy evidence and staff timing; voicemail notification must be redacted. Stop on silence, looping, or a Dial result treated as success without `DialBridged=true`. |
| D. Silence | During a connected agent call, remain silent for 20 seconds. | Agent gives one check-in after the 15-second away timeout, then transfers to office/humans if silence persists. | PM2 redacted timing plus transfer/fallback evidence. Stop if no check-in/transfer occurs or the call is silent. |
| E. Kill switch | During an active session, run the fallback route command; then place a **new** staff call. | Existing call may complete/fallback according to current TwiML; the new call goes directly to humans through the fallback route within 60 seconds. | Route evidence proving only `voice_url` changed, timestamped new-call result. Stop if new call reaches LiveKit/agent or no human path. |
| F. Non-allowlisted caller | If a second phone is available, call from it. | It bypasses agent admission and goes straight to human fallback. | Masked route/callback evidence and staff observation. Mark `NOT RUN` if no second phone is safely available; do not fabricate a caller identity. |
| G. Agent-independent fallback | With the DID restored to ingress under a separate explicit approval, stop only `c0-agent`: `pm2 stop c0-agent`; call the DID; after test, do not restart until approved. | Twilio `<Dial>` times out and fallback reaches humans without the agent process. | Filtered PM2 output, Dial timeout/action evidence, and staff confirmation. Stop if silence occurs or a production PM2 app changes. |
| H. Detector first audio | Carter manually adds `VOICE_C0_REHEARSAL_SILENT_START=true` to the protected `canary/c0/.env.c0`, then—under the separate approved PM2 lifecycle action—restarts only `c0-agent`. `set-enabled.ts` is not used: it changes only `VOICE_C0_ENABLED`. | The agent joins but remains silent and writes no first-audio marker for 15 seconds; the independent detector redirects the answered staff call to office/humans at about 6 seconds after answer, with a redacted detector alert. | Collect redacted detector log, `redirected` marker timing, transfer flag, and fallback result. Immediately after H, Carter manually removes `VOICE_C0_REHEARSAL_SILENT_START` from `.env.c0` and, under separate approval, restarts only `c0-agent` before any further calls; stop if the switch remains present or any caller is silent without the detector route. |

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

## TBD list

- No agent-owned TBD remains. Scenario H is deliberately a Carter-performed manual `.env.c0` edit because `set-enabled.ts` changes only `VOICE_C0_ENABLED`; remove the rehearsal switch and restart only `c0-agent` before another call.
