VERDICT: REJECT

## Findings

### BLOCKER — screened-call timeout/decline is treated as a successful human handoff

**Files:** `canary/c0/twilio-functions/functions/whisper.js:7-12`, `canary/c0/twilio-functions/functions/lib/c0.private.js:66-68`, `canary/c0/twilio-functions/functions/fallback-next.js:5-16`

The whisper correctly keeps the original caller unbridged until the destination presses `1`: no digit causes `<Gather>` to end and `<Hangup>` to reject the screened leg. However, Twilio documents that a `<Hangup>` or `<Reject>` in a screening URL now delivers `DialCallStatus=completed`; the code defines any `completed` result with duration greater than zero as answered and returns `<Hangup>` to the parent. Thus an office or backup recipient can answer, provide no input (or decline), and cause the staff caller to be disconnected instead of moving to backup or voicemail — a direct violation of the no-silence/human-or-voicemail contract. Preserve acceptance as an explicit signal that survives the screening leg (or use a separately controlled parent-call transition), and make `fallback-next` continue to the backup/voicemail path unless that signal is present; add no-digit and non-`1` tests. [Twilio changelog](https://www.twilio.com/docs/voice/twiml/changelog) and [Twilio `<Number>`](https://www.twilio.com/docs/voice/twiml/number) document the screening behavior.

### MAJOR — only ingress is protected; action, fallback, whisper, and alert callbacks are publicly deployable

**Files:** `canary/c0/twilio-functions/functions/ingress.protected.js:1`, `canary/c0/twilio-functions/functions/dial-action.js:1`, `canary/c0/twilio-functions/functions/fallback.js:1`, `canary/c0/twilio-functions/functions/fallback-next.js:1`, `canary/c0/twilio-functions/functions/whisper.js:1`, `canary/c0/twilio-functions/functions/voicemail-done.js:1`, `canary/c0/twilio-functions/deploy.md:15`

With the Serverless Toolkit, the `.protected.js` filename is what makes a function require a valid `X-Twilio-Signature`; all the callbacks other than ingress are plain `.js` files. An unauthenticated request can therefore invoke `/voicemail-done` and send a forged alert, or exercise the other call-control callback URLs without Twilio signature validation. Deploy every Twilio-invoked callback as protected (with the same stable route names) or enforce signature validation before processing every event, then add a deployment/route check. [Twilio Function visibility](https://www.twilio.com/docs/serverless/functions-assets/visibility) and [Serverless Toolkit naming](https://www.twilio.com/docs/serverless/functions-assets/quickstart/make-a-call) describe this behavior.

### MAJOR — the single-call admission check is not a lease and admits concurrent calls

**File:** `canary/c0/twilio-functions/functions/ingress.protected.js:21-26`

Two incoming requests can both list no other active call before either one reaches `<Dial>`, so both are admitted despite the binding one-call limit. The current list is an observation, not an atomic acquisition; it cannot provide the D1 single-call lease. Use an atomic, short-lived canary-DID lease (with deterministic cleanup/expiry and an acquire-failure fallback) before generating ingress TwiML, and add a concurrent-acquire fake test.

### MAJOR — the ntfy payload is not redacted against callback spoofing

**File:** `canary/c0/twilio-functions/functions/voicemail-done.js:3-16,22-25`

`RecordingSid` is copied verbatim into the ntfy body without format validation, while this endpoint is public. A direct request can supply phone digits, caller text, or arbitrary content as `RecordingSid`; that content then reaches the operator alert, defeating the redaction requirement. Protect the endpoint as above and independently accept only a Twilio Recording SID shape (otherwise emit `unknown`); test a phone-shaped/malformed value never appears in the alert body.

### MAJOR — invalid dial timeout values are returned as TwiML instead of failing closed

**Files:** `canary/c0/twilio-functions/functions/lib/c0.private.js:22-28`, `canary/c0/twilio-functions/functions/ingress.protected.js:11,32-37`

`positiveInteger` accepts values such as `1` or `601` for `C0_DIAL_TIMEOUT_S`, but Twilio permits `<Dial timeout>` only from 5 through 600 seconds. A malformed canary environment can therefore produce rejected TwiML rather than the local fallback response, undermining the missing/invalid-config safety intent. Validate the documented range (and the approved 20-second default/bound) before creating the `<Dial>`, so invalid configuration returns `/fallback`; add lower- and upper-bound tests. [Twilio `<Dial>`](https://www.twilio.com/docs/voice/twiml/dial) documents the range and the additional five-second buffer.

### MAJOR — active parent-call redirect has no verified or coordinated `<Dial action>` outcome

**Files:** `canary/c0/twilio-functions/functions/dial-action.js:5-10`, `canary/c0/twilio-functions/functions/lib/c0.private.js:66-68`, `canary/c0/twilio-functions/functions/fallback.js:15-19`

The agent-side transfer adapter redirects the parent CallSid to `/fallback` while the ingress `<Dial>` is active, but this package has no correlation or test for the resulting action callback. Twilio calls a `<Dial action>` URL when the Dial ends and makes that response control the initial call; if the terminated SIP leg reports `completed` with duration, `dial-action` returns `<Hangup>`, which can race and clobber the parent fallback redirect. The approved design already marks this teardown behavior unverified, so do not accept the route until a staff rehearsal proves the exact event ordering and a deterministic correlation/precedence rule prevents `/dial-action` from terminating a transfer-to-fallback. [Twilio `<Dial>`](https://www.twilio.com/docs/voice/twiml/dial) documents action ownership after Dial; the binding plan requires this specific rehearsal.

## Controls verified

- The ingress TwiML uses `<Dial action>`, `answerOnBridge`, timeout, and timeLimit, and its SIP URI includes username/password plus a URL-encoded `X-C0-Call` custom header. Those forms match the cited Twilio `<Dial>` and `<Sip>` guidance.
- The whisper response is correctly limited to pre-bridge `<Gather>`/`<Hangup>` TwiML, and it does not bridge a timeout or non-accepting input; the blocker is the parent action's incorrect interpretation of the resulting status.
- `fallback-next` itself cannot loop indefinitely: only `office` advances once to `backup`; all other roles reach voicemail. The source contains no phone-shaped literals, and the normal voicemail alert body contains only an event name and recording identifier, but the missing validation above prevents accepting its redaction guarantee.

## Verification performed

- `npm run check` in `canary/c0/twilio-functions` — **PASS** (`c0-functions.check OK`).
- Read-only inspection of all handlers, helper, package manifest, deployment guidance, and existing fake checks — completed; no dotenv file was opened and no provider/account request was made.
- Public Twilio documentation checked for protected-function visibility, `<Dial>` action/status/timeout semantics, and `<Number url>` pre-bridge screening semantics.

## Fix response

- **BLOCKER — screened-call timeout/decline:** `fallback-next.protected.js` now regards only `DialBridged === 'true'` as a completed human handoff; all other outcomes advance office to backup and then voicemail. Covered by `c0-functions.check.ts` cases for no digit/missing bridge signal, non-`1`, declined/completed-without-bridge, busy/no-answer, and bridged acceptance.
- **MAJOR — unprotected callbacks:** all six Twilio-invoked handlers now use `.protected.js` filenames without changing their URL paths. `c0-functions.check.ts` scans the functions root and fails on any non-protected JavaScript handler.
- **MAJOR — non-atomic admission:** ingress now acquires the `c0-lease` Sync Document with TTL `C0_TIME_LIMIT_S + 120`, conditionally takes over a stale lease using the document `If-Match` revision, and fails closed to `/fallback` on Sync errors; dial action and voicemail completion release only their own lease. Covered by the concurrent-acquire and stale-takeover fake tests in `c0-functions.check.ts`.
- **MAJOR — redirect/action race:** `dial-action.protected.js` consumes `c0-transfer-<ParentCallSid>` before interpreting Dial status and redirects to the recorded office/backup fallback route. Covered by the completed-Dial-with-transfer-flag test, which asserts no hangup.
- **MAJOR — voicemail alert redaction:** `voicemail-done.protected.js` admits only shaped `RE…` recording IDs, masks valid `CA…` call IDs to six characters, and emits `unknown` otherwise. Covered by the poison-input ntfy-body test in `c0-functions.check.ts`.
- **MAJOR — invalid timing:** ingress now defaults to 20/480 seconds and rejects Dial timeout outside 5–600 or time limit outside 60–14,400 with fallback TwiML. Covered by the lower/upper bound and invalid-value tests in `c0-functions.check.ts`.
