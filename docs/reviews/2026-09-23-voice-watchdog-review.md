# Voice-line watchdog production review — 2026-09-23

**VERDICT: REJECT**

This was a read-only review of the new watchdog surface intended to run as root on
AIWA every two minutes.  The normal/default write destinations are under
`/opt/grizzly-hcp/data`, and the observed `/twiml` handler returns static TwiML while
the WebSocket check sends no message; those are good containment properties.  The
items below nevertheless leave detection unreliable or create false public-path
incidents, so this should not be installed until they are corrected and covered by
offline checks.

## Findings

### HIGH — unbounded operations can exceed the unit deadline

- **Files:** `src/ops/voice-watchdog.ts:213-224, 362-380, 420-434, 488-515, 588`; `deploy/aiwa/voice-watchdog.service:13`
- **Failure scenario:** Twilio `fetch`, public DNS, `journalctl`, and alert delivery have no
  overall abort/deadline.  The per-request socket inactivity timeout covers only the two
  HTTPS probes and does not bound a slow response stream; all other operations can run until
  systemd kills the process at `TimeoutStartSec=90`.  A still-active oneshot service will not
  be run concurrently by this timer, but it can occupy/skips scheduled elapses and be killed
  mid-run instead of ending within a controlled budget.
- **Fix:** Put every external read, child process, and alert sender behind explicit bounded
  deadlines, and use one run-level deadline strictly below 90 seconds (with enough margin for
  state writes).  Make probes parallel per address or budget their sequential work, cancel on
  expiry, and exit nonzero on a deadline so systemd reports an operational failure.

### HIGH — exact watermarks permanently miss late or skewed Twilio records

- **File:** `src/ops/voice-watchdog.ts:183-186, 415, 436-445, 520`
- **Failure scenario:** After successful list reads, `lastRunAt` becomes the local time sampled
  at the beginning of the run.  The next query starts exactly there.  A call/Monitor Alert
  whose event time predates that boundary but is not yet visible in Twilio (or whose timestamp
  differs slightly from AIWA's clock) is excluded forever, despite being a missed call.
- **Fix:** Query a bounded overlap window (for example, saved watermark minus several minutes)
  on every normal run, retain the existing SID/incident dedupe, and document the overlap.
  Continue to advance the durable watermark only after complete successful reads.

### HIGH — a host without IPv6 egress produces a false public-path outage

- **File:** `src/ops/voice-watchdog.ts:346-358, 383-397, 498-516`
- **Failure scenario:** The explicit `node:dns.Resolver` with `1.1.1.1` and `8.8.8.8` does
  bypass AIWA's configured MagicDNS resolver (`100.100.100.100`) and correctly returns A and
  AAAA records.  However, any resolved IPv6 address is treated as a required healthy probe;
  `ENETUNREACH`/lack of AIWA IPv6 egress therefore opens `Voice line: public path failing`
  after two runs even while every IPv4 Funnel address works.
- **Fix:** Preserve per-address IPv6 observability, but classify a local IPv6-unavailable
  condition as untestable rather than an external outage (and include that state in the
  heartbeat).  Only alert on a reachable-address failure, or use an independently reachable
  probe location for IPv6.

### HIGH — incomplete pagination is indistinguishable from a successful complete read

- **File:** `src/ops/voice-watchdog.ts:213-224, 227-242, 520`
- **Failure scenario:** Each Twilio collection silently stops after ten pages and supplies no
  `PageSize`; if the window contains more results, the remainder is omitted but both list calls
  resolve and the watermark advances.  Those omitted missed calls and Monitor Alerts are then
  outside every future window.
- **Fix:** Request an appropriate documented page size and either consume pages within the
  run budget or fail the run whenever a continuation remains.  Do not advance the watermark on
  a truncated collection; add fixtures for continuation past the allowed bound.

### HIGH — Twilio/read failures still leave a successful systemd invocation and a misleading zero count

- **Files:** `src/ops/voice-watchdog.ts:426-429, 520-545, 591`; `docs/AIWA-DEPLOY-voice-watchdog.md:29-41`
- **Failure scenario:** A failed Calls or Alerts request sets `heartbeat.ok` false and preserves
  the watermark, which avoids a broad repeat-alert storm through the existing SID state.
  But `main` ignores `result.ok`, exits zero, and the oneshot unit reports success; an unavailable
  `journalctl` is likewise recorded as `drops: 0`.  An operator can therefore see successful
  service execution/zero drops rather than an explicit inability to inspect the source.
- **Fix:** Carry per-source `unknown`/failure details into the heartbeat and journal, make
  essential source-read failure exit nonzero, and do not represent a failed journal query as a
  counted zero.  Update the runbook's dry-run wording accordingly.

### MEDIUM — root service permits writes outside `data/` through a configuration override

- **Files:** `src/ops/voice-watchdog.ts:154-159, 542-543, 579`; `.env.example:53-58`; `docs/AIWA-DEPLOY-voice-watchdog.md:20-25`
- **Failure scenario:** The default state and heartbeat paths are correctly under `data/`, but
  `VOICE_WATCHDOG_STATE_PATH` is accepted verbatim by a root service.  A mistaken environment
  value can make the watchdog atomically create/replace an arbitrary root-writable path and
  writes the heartbeat beside it.
- **Fix:** Remove the override, or resolve and validate it as a regular file strictly beneath
  `/opt/grizzly-hcp/data` before any write; reject paths outside that tree.

### MEDIUM — Monitor resource lookup can lose the caller and dedupe by transient alert SID

- **File:** `src/ops/voice-watchdog.ts:244-250, 449-483`
- **Failure scenario:** If a relevant Monitor Alert's `resource_sid` Call GET returns non-2xx,
  `fetchTwilioCall` turns it into `null`; the code emits an `alert:<alert-sid>` incident with
  `Caller: unknown`.  Further Monitor Alerts for the same failed leg then have new alert SIDs,
  so they are not incident-deduped and can create repeated callback alerts during an API fault.
- **Fix:** Treat a failed resource lookup as an incomplete Twilio read (visible/nonzero), retry
  within the bounded budget, and retain a resource-SID/parent incident key so duplicate monitor
  records cannot fan out.  Do not claim a customer callback alert when the caller could not be
  resolved.

### MEDIUM — journal drop detection has no explicit unavailable state

- **Files:** `src/ops/voice-watchdog.ts:22, 168-170, 420-429`; `docs/AIWA-DEPLOY-voice-watchdog.md:31, 65`
- **Failure scenario:** The pattern correctly counts the supplied IPv6 Funnel-style
  `Drop: TCP{[fd7a:...]:... > [...]...} ... no rules matched` lines.  But any journal command
  failure is collapsed to zero, and the runbook says that absence is zero; this makes collection
  failure indistinguishable from observed absence of drops.
- **Fix:** Record `drops: unknown` plus a redacted collection-error class when `journalctl`
  cannot be read, reserve numeric zero for a successful empty scan, and test both branches.

## Accepted/verified properties

- `voice-watchdog.ts` has no process-control or restart operation.  Its default writes are the
  atomic state and heartbeat files under `data/`; output uses `redactPhoneNumbers`, and its
  normal log does not include Twilio credentials.
- `src/agent/voice-server.ts:205-215` shows `/twiml` returns static ConversationRelay TwiML
  without reading a body or changing call state.  The watchdog's WebSocket probe performs only
  the HTTP upgrade and immediately destroys the socket without `ws.send`, so the observed probe
  path does not send a relay message.
- The explicit `Resolver#setServers(['1.1.1.1', '8.8.8.8'])` is a real bypass of the host's
  system/MagicDNS resolver choice.  The timer targets the single oneshot service, has
  `OnUnitActiveSec=2min`, and the service intentionally has no `[Install]`; the unit paths,
  `EnvironmentFile`, and `TZ=America/Chicago` match the stated AIWA layout.
- Incident state is bounded to 500 IDs per list, and parent/child plus `resource_sid` grouping
  is covered for the successful lookup fixture.  Full caller number appears at the top of the
  private alert body while dry-run/stdout data is masked; alert credentials are not logged by
  the reviewed watchdog code.

## Checks run

- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsx.cmd src/ops/voice-watchdog.check.ts` — passed (`voice watchdog self-check passed`).
- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsx.cmd src/ops/alert.check.ts` — passed (`ops alert self-check passed`).
- Read-only inspection: `git status --short`, scoped `git diff --check`, the reviewed source,
  service/timer, runbook, `.env.example` block, and the existing `/twiml` implementation.  No
  watchdog execution, `.env*` credential read, network call, or AIWA action was performed.

## Fix response

| Finding | Change | Offline coverage |
| --- | --- | --- |
| HIGH — unbounded operations can exceed the unit deadline | Added one 70-second run deadline below the unchanged `TimeoutStartSec=90`, with bounded signals around Twilio fetches, DNS, probes, `journalctl`, and alert delivery; address probes start in parallel and a deadline produces a nonzero result. | The watchdog check forces the injected deadline and asserts `deadlineHit` plus a nonzero exit result. |
| HIGH — exact watermarks permanently miss late or skewed Twilio records | Every normal read starts from saved watermark minus ten minutes; the watermark advances only when calls and alerts, including required resource lookups, are complete. | The watchdog check asserts the query overlap and preserves the watermark for incomplete reads. |
| HIGH — a host without IPv6 egress produces a false public-path outage | `ENETUNREACH`, `EHOSTUNREACH`, and `EADDRNOTAVAIL` on IPv6 are recorded as `untestable`; public-path alerting excludes them and requires an IPv4 failure or IPv6 wrong HTTP status. | The watchdog check runs two IPv6-unreachable passes and asserts no public-path alert. |
| HIGH — incomplete pagination is indistinguishable from a successful complete read | Twilio collections request `PageSize=1000`, follow `next_page_uri`, and mark a continuation aborted before completion as `incomplete`; such a source cannot move the watermark. | The continuation fixture aborts the second calls page and asserts incomplete/nonzero/no callback alert. |
| HIGH — Twilio/read failures still leave a successful systemd invocation and a misleading zero count | Heartbeats now report `calls`, `alerts`, `probe`, and `journal` statuses; Twilio failed/incomplete reads and deadline exit nonzero, while journal failure is `drops: null` and `unavailable`. | The check covers journal unavailability and Monitor lookup failure as nonzero incomplete states. |
| MEDIUM — root service permits writes outside `data/` through a configuration override | Removed `VOICE_WATCHDOG_STATE_PATH`; the executable always uses its repository `data/voice-watchdog-state.json` path. | Focused source/check review confirms no environment override is read and dry run still writes nothing. |
| MEDIUM — Monitor resource lookup can lose the caller and dedupe by transient alert SID | A non-2xx or absent resource call makes Alerts incomplete and suppresses a callback alert; successful resources join the existing call/parent incident grouping. | The check injects a 503 resource lookup and asserts incomplete/nonzero/no unknown-caller alert; the existing parent/resource fixture remains green. |
| MEDIUM — journal drop detection has no explicit unavailable state | Journal read errors now serialize `drops: null`, `journal: unavailable`, and a redacted error class; numeric zero remains a successful empty scan. | The journal-failure fixture inspects the persisted heartbeat for null/unavailable. |

## Re-review (VW4)

**VERDICT: REJECT**

VW4 implements most of the requested functional changes, and the two executable
self-checks pass.  It is not ready for the root AIWA timer because the promised
deadline does not actually cancel all in-flight I/O, a failed alert run can resend
previously delivered missed-call alerts on every overlap pass, and the reviewed
watchdog code itself fails the available TypeScript check.

### Original findings

1. **HIGH — unbounded operations can exceed the unit deadline: NOT RESOLVED.**
   `src/ops/voice-watchdog.ts:154-171` adds a 20-second `bounded` race and
   `:524-525` adds the 70-second parent controller; probes and `execFile` receive
   a signal at `:442-481` and `:711`.  But `response.json()` at `:277` is raced
   without receiving or cancelling on that operation's signal, while the fetch
   controller from `:273-275` is cleared as soon as headers arrive; a slow body
   can therefore remain alive after the watchdog has stopped waiting.  Similarly,
   the `Resolver` wrapper at `:419-438` rejects its wait on abort but never calls
   `Resolver.cancel()`, so it does not cancel the underlying c-ares request.
   The deadline fixture at `src/ops/voice-watchdog.check.ts:318-329` uses a fake
   fetch that cooperates with the signal and does not cover either non-cancellable
   body or DNS case.  Use a request/body lifecycle that preserves the same abort
   controller through body consumption (and cancels the body), call/correctly wrap
   resolver cancellation on abort, and add adversarial fixtures proving no active
   operation survives the deadline.

2. **HIGH — exact watermarks permanently miss late or skewed Twilio records: RESOLVED.**
   `src/ops/voice-watchdog.ts:234-238` reads from saved watermark minus ten minutes,
   retains bounded dedupe at `:178-180, 346-357`, and advances the watermark only
   after complete Calls and Alerts sources at `:637-645`.  The overlap assertion is
   present at `src/ops/voice-watchdog.check.ts:242-250`.

3. **HIGH — IPv6 egress absence produces a false public-path outage: RESOLVED.**
   Public DNS still explicitly uses `1.1.1.1` and `8.8.8.8` at
   `src/ops/voice-watchdog.ts:413-439`, bypassing AIWA's MagicDNS resolver.  The
   listed local IPv6 connect errors become `untestable` at `:505-509`, and public
   failure alerting excludes them at `:512-516, 618-635`; the two-run IPv6 fixture
   at `src/ops/voice-watchdog.check.ts:273-286` proves no path alert opens.

4. **HIGH — incomplete pagination is indistinguishable from a complete read: RESOLVED.**
   Both collections request `PageSize=1000` at `src/ops/voice-watchdog.ts:290-306`;
   `fetchJsonPages` follows `next_page_uri` and converts an aborted continuation
   into `IncompleteReadError` at `:264-287`.  The continuation fixture at
   `src/ops/voice-watchdog.check.ts:252-271` verifies `incomplete`, nonzero exit,
   no watermark advance, and no callback alert.

5. **HIGH — failed reads look successful and journal failure becomes zero: RESOLVED.**
   Per-source heartbeat statuses and nullable drops are emitted at
   `src/ops/voice-watchdog.ts:535-545, 640-645`; `main` applies `result.exitCode`
   at `:715-717`.  The journal-unavailable and Monitor lookup fixtures at
   `src/ops/voice-watchdog.check.ts:288-316` pass, and the runbook accurately
   describes a failed unit at `docs/AIWA-DEPLOY-voice-watchdog.md:66-68`.

6. **MEDIUM — root service permits state writes outside `data/`: RESOLVED.**
   The environment override was removed from `.env.example:53-57` and from the
   executable; `src/ops/voice-watchdog.ts:701-707` unconditionally derives the
   state path as `<WorkingDirectory>/data/voice-watchdog-state.json`.  The service
   fixes that directory to `/opt/grizzly-hcp` at
   `deploy/aiwa/voice-watchdog.service:6-11`.

7. **MEDIUM — Monitor resource lookup can lose the caller and dedupe by alert SID: NOT RESOLVED.**
   The specific non-2xx resource lookup case is now incomplete/nonzero and covered
   at `src/ops/voice-watchdog.ts:570-579` and
   `src/ops/voice-watchdog.check.ts:302-316`.  However, a relevant Monitor Alert
   that has no `resource_sid` still creates `alert:<alert-sid>` with
   `Caller: unknown` at `src/ops/voice-watchdog.ts:590-596`; a new Monitor record
   then has a new dedupe key and can generate an un-actionable callback alert.
   Treat a relevant alert missing `resource_sid` as Alerts `incomplete` and suppress
   its callback alert, with a fixture for that schema/error case.

8. **MEDIUM — journal drop collection has no unavailable state: RESOLVED.**
   A rejected journal read now becomes `journal: unavailable` and `drops: null` at
   `src/ops/voice-watchdog.ts:535-543, 640-643`, with the passing fixture at
   `src/ops/voice-watchdog.check.ts:288-300`.  The runbook's dry-run wording at
   `docs/AIWA-DEPLOY-voice-watchdog.md:30-42` matches that behavior.

### New findings

#### HIGH — one failed alert delivery replays already delivered incidents across the overlap window

- **File:** `src/ops/voice-watchdog.ts:605-616`
- **Scenario:** If multiple new missed-call incidents are found, an early alert can be delivered
  and a later alert can time out/throw.  The single `alertDeliveryFailed` flag then prevents
  persistence of *all* incident SIDs and keys, including the successfully alerted one.  Every
  subsequent two-minute run re-reads the ten-minute overlap and re-sends that successful alert
  until the later alert succeeds or the incident ages out — an alert storm introduced by the
  all-or-nothing state update.
- **Fix:** Track alert delivery per incident and persist only successfully delivered incident
  keys/SIDs.  Preserve a separate bounded retry/backoff record for unsent incidents so retrying
  one does not replay its already delivered siblings; add a fixture with two incidents where the
  second alert fails and assert the first is not re-sent.

#### HIGH — the available repository type check fails in the reviewed watchdog source

- **File:** `src/ops/voice-watchdog.ts:272-281`
- **Scenario:** `tsc --noEmit` reports five watchdog errors: implicit-any/circular inference for
  `pageUrl`, `response`, `json`, and `nextPage`, plus use of `response`/`json` as `unknown`.
  `tsx` transpiles the self-checks, so their success does not establish a type-clean production
  candidate.
- **Fix:** Add explicit `URL`, `Response`, and `Record<string, unknown>` annotations (and an
  explicit async return type where necessary) in `fetchJsonPages`, then rerun the project type
  check.  The full check also has pre-existing failures outside this review surface, but these
  five errors are in the new watchdog code and must be cleared.

#### MEDIUM — production alert delivery is not observable by the watchdog

- **Files:** `src/ops/voice-watchdog.ts:606-616, 712-714`; `src/ops/alert.ts:81-119`
- **Scenario:** The production adapter delegates to `sendOpsAlert`, whose per-channel failures
  are caught and logged before it resolves.  Thus an ntfy/SMS outage can leave
  `alertDeliveryFailed` false, persist the incident as seen, and exit successfully even though
  Carter received no callback alert; the injected throwing-alert path does not model this.
- **Fix:** Have the alert layer return structured per-channel delivery status and make the
  watchdog retain/retry a missed-call incident when no configured delivery channel accepted it.
  Keep the retry bounded/backed off to avoid a separate alert storm.

### Regression and containment checks

- The executable still has no restart/process-control path, and the systemd unit remains a
  root `Type=oneshot` under `/opt/grizzly-hcp` with `TZ=America/Chicago`, no service
  `[Install]`, and a two-minute timer (`deploy/aiwa/voice-watchdog.service:5-16`,
  `deploy/aiwa/voice-watchdog.timer:4-12`).
- Default executable writes remain confined to its `data/` state/heartbeat paths
  (`src/ops/voice-watchdog.ts:701-707, 662-664`); state arrays remain bounded to 500
  (`:178-180, 613-615`).  Normal stdout applies phone redaction at `:664`, and the
  code does not print Twilio credentials.
- The WebSocket probe still only requests the upgrade and destroys its socket without a relay
  message (`src/ops/voice-watchdog.ts:442-481`).  The prior static `/twiml` review evidence
  remains applicable; no watchdog, account, network, or AIWA execution was performed here.

### Checks run

- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsx.cmd src/ops/voice-watchdog.check.ts` — passed.
- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsx.cmd src/ops/alert.check.ts` — passed.
- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsc.cmd --noEmit` — failed.  It reports
  existing errors outside this review surface and five new errors in
  `src/ops/voice-watchdog.ts:272-281` described above.

## Fix response (VW5)

| Open finding | Change | Offline coverage |
| --- | --- | --- |
| HIGH — deadline did not cancel all I/O | Fetch now retains a linked `AbortController` until `response.json()` finishes and cancels the response body on abort; every DNS lookup creates its own Resolver and calls `cancel()` on abort; `main()` explicitly exits after a completed run. | Adversarial fixtures use a response body that never settles until cancelled and a resolver whose lookups never settle; each asserts the deadline returns nonzero and reaches the cancellation hook. |
| HIGH — one failed delivery replayed delivered siblings | State now records successful incidents individually and retains only failed incidents in a bounded 100-entry retry list. Retries use 2/4/8/16/32-minute backoff, stop after six attempts, and then record a redacted given-up incident counted in `undeliverableAlerts`. | Two-incident fixture makes the second delivery fail, verifies a nonzero run and one retry record, then advances to its due time and verifies only the second incident is delivered. |
| HIGH — watchdog TypeScript errors | `fetchJsonPages` and its body-reading helper now use explicit `URL`, `Response`, `Record<string, unknown>`, and async return types. | `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsc.cmd --noEmit 2>&1 | Select-String 'src/ops/voice-watchdog(\.check)?\.ts'` reports zero matching errors; unrelated project errors remain outside this review surface. |
| MEDIUM — relevant Monitor Alert without `resource_sid` generated an unknown-caller callback | Such records now add only their SID to `seenAlertSids`, write a redacted log entry, and appear in heartbeat `unattributedAlerts` with the error code. They neither create an incident nor make Alerts incomplete. | Missing-`resource_sid` fixture asserts no callback alert, the expected unattributed heartbeat result, and suppression on the next overlap pass. |
| MEDIUM — alert delivery was not observable | The watchdog now calls local `deliverWatchdogAlert`: SMS uses exported `sendOpsSms(formatOpsSms(...))` with the run signal injected through fetch, while ntfy performs its own checked POST with the existing URL/topic/header semantics. A run fails if neither channel accepts an incident and heartbeat includes redacted per-channel status. | Retry fixture models both channels failing for the second incident, verifies retained state and nonzero exit, then verifies a later ntfy-only success. |

### VW5 checks

- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsx.cmd src/ops/voice-watchdog.check.ts` — passed.
- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsx.cmd src/ops/alert.check.ts` — passed.
- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsc.cmd --noEmit` — still exits 2 for pre-existing errors in `src/automations/estimates/from-proposal.ts` and `src/hcp/mine-pricebook-candidates.ts`; filtering the output for `src/ops/voice-watchdog.ts` and `src/ops/voice-watchdog.check.ts` reports zero errors.

## Re-review (VW5)

**VERDICT: ACCEPT-WITH-FIXES**

VW5 resolves the three prior HIGH findings and the two prior MEDIUM findings in the
reviewed watchdog behavior.  The required production safeguards now exist and pass
the supplied offline checks, but one bounded-retry overflow path silently loses an
undelivered incident after the overlap window; it is a MEDIUM remediation before
unusually high-volume/outage conditions can be considered fully safe.

### Prior open findings

1. **HIGH — real I/O survived the watchdog deadline: RESOLVED.**
   `src/ops/voice-watchdog.ts:353-372` keeps the fetch controller through
   `response.json()` and cancels `response.body` upon operation abort; DNS now creates
   a resolver per lookup and calls `cancel()` at `:497-524`.  The 70-second deadline
   remains below the 90-second unit timeout (`:609-610`,
   `deploy/aiwa/voice-watchdog.service:11-14`), and `main` explicitly terminates with
   the completed result at `src/ops/voice-watchdog.ts:817-845`.  The adversarial body
   and resolver fixtures at `src/ops/voice-watchdog.check.ts:353-390` passed and
   prove their cancellation hooks are reached.

2. **HIGH — a failed delivery replayed an already delivered sibling: RESOLVED.**
   Successful deliveries persist only that incident's identifiers at
   `src/ops/voice-watchdog.ts:694-729`; failed incidents receive their own bounded
   retry record with 2/4/8/16/32-minute progression and the sixth failure is marked
   undeliverable.  The two-incident fixture at
   `src/ops/voice-watchdog.check.ts:324-350` passed: it retains only the failed
   second incident and later sends only that retry.

3. **HIGH — watchdog-local TypeScript errors: RESOLVED.**
   `fetchJsonPages` and `fetchJsonRecord` now use explicit `URL`, `Response`, and
   `Record<string, unknown>` types at `src/ops/voice-watchdog.ts:329-373`.  Full
   `tsc --noEmit` still exits 2 on four pre-existing errors in unrelated estimate and
   pricebook files, but its output has zero matches for either watchdog file; both
   watchdog self-checks also pass.

4. **MEDIUM — a relevant Monitor Alert without `resource_sid` created an unknown-caller callback: RESOLVED.**
   `src/ops/voice-watchdog.ts:655-666` records only a masked SID/error-code entry,
   dedupes it in `seenAlertSids`, and deliberately keeps Alerts complete; it never
   creates a callback incident.  The missing-resource fixture at
   `src/ops/voice-watchdog.check.ts:102-114` passed, including the subsequent
   overlap-pass suppression.

5. **MEDIUM — alert delivery was not observable to the watchdog: RESOLVED.**
   The shared `src/ops/alert.ts` is byte-identical to the required hash:
   `D1E4ED8CCC0BEA0EA4B7347C9B4E7D89F99F88DEFC82205CC049764677D05A1C`.
   Instead, `src/ops/voice-watchdog.ts:297-327` implements local, signal-injected
   delivery: SMS uses exported `formatOpsSms`/`sendOpsSms`, ntfy checks
   `response.ok`, and the result is delivered only when at least one channel
   accepts.  The retry fixture at `src/ops/voice-watchdog.check.ts:324-350` verifies
   the delivery-status contract and nonzero result when both channels fail; the
   existing `src/ops/alert.check.ts` also passed its SMS success/failure boundary.

### Regression checks

- The ten-minute watermark overlap, complete-only watermark advance, PageSize 1000,
  and incomplete-continuation handling remain at
  `src/ops/voice-watchdog.ts:267-270, 329-391, 756-767`; the overlap and continuation
  fixtures at `src/ops/voice-watchdog.check.ts:248-277` passed.
- Public DNS continues to bypass MagicDNS with a fresh resolver pointed at
  `1.1.1.1`/`8.8.8.8` (`src/ops/voice-watchdog.ts:497-524`).  IPv6 local-connect
  failures remain heartbeat-only `untestable`, while reachable IPv4/HTTP failures
  remain actionable (`:590-601, 731-753`); the IPv6 fixture at
  `src/ops/voice-watchdog.check.ts:279-292` passed.
- Per-source heartbeat status, `drops: null` journal-unavailable behavior, dry-run
  no-alert/no-write behavior, and redacted output remain covered at
  `src/ops/voice-watchdog.ts:620-627, 759-789` and
  `src/ops/voice-watchdog.check.ts:215-227, 294-306`.  State is still bounded to
  500 seen/given-up keys and 100 retry records (`:202-226, 729`); the state path is
  fixed below the service working directory's `data/` directory (`:825-836`,
  `deploy/aiwa/voice-watchdog.service:5-16`).
- No process control/restart path was introduced; the two-minute timer still targets
  the oneshot service and only the timer is installable
  (`deploy/aiwa/voice-watchdog.timer:4-12`).  The WebSocket probe still performs an
  upgrade then destroys the socket without a relay message
  (`src/ops/voice-watchdog.ts:527-567`).  The runbook matches the deadline, source
  statuses, alert retry semantics, fixed paths, and systemd operation at
  `docs/AIWA-DEPLOY-voice-watchdog.md:7-11, 55-78`.

### New findings

#### MEDIUM — retry-cap overflow silently drops an undelivered missed-call incident

- **File:** `src/ops/voice-watchdog.ts:694-729`
- **Scenario:** During an alert-channel outage, 101 new missed-call incidents in one
  watchdog window all fail delivery.  The loop appends 101 retry records, then
  `slice(-MAX_RETRY_RECORDS)` retains only 100; the discarded incident is neither
  seen nor recorded as given-up.  It is retried every overlap pass with its attempt
  count effectively reset, and after it ages outside the ten-minute query window it
  disappears without delivery or `undeliverableAlerts` evidence.
- **Fix:** Before truncating, explicitly mark each overflow incident as given-up
  (and log a redacted capacity warning), or retain a bounded overflow summary that
  prevents repeat attempts and exposes the loss.  Add a 101-incident, both-channels-
  failed fixture proving no record is silently lost or retried indefinitely.

### Checks run

- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsx.cmd src/ops/voice-watchdog.check.ts` — passed.
- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsx.cmd src/ops/alert.check.ts` — passed.
- `D:\Workspace\Active\grizzly-hcp\node_modules\.bin\tsc.cmd --noEmit` — exits 2
  only for the four pre-existing errors outside the watchdog files; filtering for
  `src/ops/voice-watchdog.ts` and `src/ops/voice-watchdog.check.ts` produced zero
  errors.

## Change (VW6 Slack)

The watchdog now has its own Slack configuration: `VOICE_WATCHDOG_SLACK_TOKEN`
and `VOICE_WATCHDOG_SLACK_CHANNEL` (default `C0BV3678T9N`, private
`#ops-alerts`). It posts the existing alert content as `*title*` plus the body,
caps it at 3000 characters, and accepts a Slack delivery only when both the HTTP
status and JSON `ok` result succeed; failed or unconfigured Slack falls back to
the existing SMS and ntfy paths. The local delivery adapter keeps the operation
abort controller through Slack body consumption, records an `accepted`,
`not-configured`, or redacted `failed:<code>` Slack status in `lastDelivery`, and
does not read the retired `SLACK_BOT_TOKEN` or `SLACK_CHANNEL_ID` variables.

## Fix response (VW6)

| Finding / change | Implementation | Offline coverage |
| --- | --- | --- |
| MEDIUM — retry-cap overflow silently lost an undelivered incident | Before the 100-record retry cap is applied, every discarded record is marked given-up and seen, contributes to `undeliverableAlerts`, and produces a redacted capacity warning. | A 101-incident all-channel failure retains 100 retries, gives up exactly one overflow incident, and proves only the retained 100 are retried. |
| Slack-primary delivery | Slack `chat.postMessage` is tried first with the watchdog-only token/channel, strict HTTP-plus-JSON acceptance, 3000-character formatting, and token-redacted failure text. SMS and ntfy run only when Slack does not accept. | Fixtures cover Slack success without SMS, HTTP 200 `ok:false` with SMS fallback, dual failure retaining retry state, absent Slack retaining SMS, token absence from state/heartbeat/log capture, and dry run invoking no Slack delivery. |
| Public DNS NXDOMAIN blind spot | Cloudflare and Google now use independent resolvers for each A/AAAA query; their answers are unioned and recorded in heartbeat/dry-run `dns`. | The first-resolver NXDOMAIN plus second-resolver A-answer fixture proves the usable address is retained and the probe is `ok`. |
| Empty or untestable public path looked healthy | No DNS records and no usable IPv4 verification increment the path-failure counter and issue the normal alert after two runs; `sources.probe` becomes `unverified` when there is no testable address. Recovery requires a successful IPv4 TwiML and WebSocket probe. | Fixtures cover two total-DNS-failure runs with one alert, only-AAAA/unreachable-IPv6 with one alert, and `sources`/`dns` in dry-run output. |

## Re-review (VW6)

**VERDICT: ACCEPT-WITH-FIXES**

VW6 resolves the prior retry-overflow loss and correctly adds watchdog-local,
strictly accepted Slack delivery with SMS/ntfy fallback, redacted status, and no
change to the shared alert adapter.  The independent DNS union removes the
Cloudflare-NXDOMAIN blind spot, but the production resolver set has only one
known working A-record source on AIWA; a short Google resolver outage can
therefore create a false public-path outage despite the known-good Quad9 and
OpenDNS answers.  There are **0 open HIGH/BLOCKER findings**; the remaining
MEDIUM should be remediated before this now-live detector is relied on as a
high-confidence public-path signal.

### Prior open finding

1. **MEDIUM — retry-cap overflow silently dropped an undelivered missed-call incident: RESOLVED.**
   `src/ops/voice-watchdog.ts:811-821` explicitly marks records displaced by
   the 100-entry retry cap as given-up, persists their incident and leg dedupe
   identifiers, and emits only a masked capacity warning.  The 101-incident
   fixture at `src/ops/voice-watchdog.check.ts:500-518` passes: it retains 100
   retry records, counts exactly one undeliverable incident, and proves only
   the retained records are retried.

### VW6 implementation and regression evidence

- **Slack delivery: RESOLVED/implemented as specified.**
  `src/ops/voice-watchdog.ts:307-386` reads only
  `VOICE_WATCHDOG_SLACK_TOKEN` and `VOICE_WATCHDOG_SLACK_CHANNEL` (default
  `C0BV3678T9N`), accepts `chat.postMessage` only on both HTTP success and
  JSON `ok: true`, and keeps its abort controller through `response.json()`.
  Any Slack rejection—including an API-level `not_in_channel` response—falls
  through to the signal-injected SMS and ntfy sends; an accepted Slack send
  suppresses those fallbacks.  `lastDelivery` retains statuses only, and the
  `xox*` error redactor is applied before a Slack error can enter state or a
  heartbeat.  Fixtures at `src/ops/voice-watchdog.check.ts:421-497` cover
  accepted-Slack suppression, API rejection plus SMS fallback, redaction and
  retry retention, unconfigured-Slack SMS use, and dry-run non-delivery.

- **Independent public DNS and failure semantics: PARTIALLY RESOLVED.**
  `createPublicDnsResolve` now creates a resolver for each server/family and
  unions answers at `src/ops/voice-watchdog.ts:556-605`; the first-resolver
  NXDOMAIN/second-resolver-A fixture at
  `src/ops/voice-watchdog.check.ts:166-210` passes.  Empty results and no
  usable IPv4 now become `unverified`, increment the ordinary two-run
  public-path counter, and require a healthy IPv4 for recovery at
  `src/ops/voice-watchdog.ts:823-855`; fixtures at `:315-360` pass.  A single
  transient failure does not alert while the other configured resolver returns
  an A record, and the open-state guard prevents a delivered outage alert from
  being repeated every two minutes.

- **Previously resolved safety boundaries: no regression found.**
  The run still has the 70-second deadline under `TimeoutStartSec=90`, writes
  only beneath the fixed `data/` path, has no process-control path, and its
  WebSocket test only upgrades then destroys the socket without relay traffic
  (`src/ops/voice-watchdog.ts:19-20, 632-647, 887-948`;
  `deploy/aiwa/voice-watchdog.service:5-16`).  The overlap watermark,
  PageSize-1000 pagination, complete-only watermark advance, Monitor
  `resource_sid` handling, bounded state, IPv6 `untestable` classification,
  journal-unavailable result, dry-run non-write/non-send behavior, per-source
  heartbeat, service/timer topology, and runbook all remain consistent.
  `src/ops/alert.ts` hashes to the required unchanged SHA-256
  `D1E4ED8CCC0BEA0EA4B7347C9B4E7D89F99F88DEFC82205CC049764677D05A1C`.

### New findings

#### MEDIUM — a known-bad Cloudflare resolver leaves Google as the sole effective IPv4 source

- **File:** `src/ops/voice-watchdog.ts:560-605, 823-855`
- **Scenario:** AIWA has already demonstrated that `1.1.1.1` returns NXDOMAIN
  for this Funnel host, while `8.8.8.8`, `9.9.9.9`, and OpenDNS return the A
  record.  VW6 queries only Cloudflare and Google.  Thus, if Google has a
  transient resolver/connectivity failure on two consecutive timer runs, both
  configured sources yield no A record; the watchdog records `unverified` and
  sends a false `public path failing` alert even though Quad9/OpenDNS could
  still verify the healthy Funnel address.  The alert-open state avoids a
  message every two minutes after delivery, but this is still an avoidable
  live-host false incident and recovery remains dependent on Google answering
  again.
- **Fix:** Query at least the known-good `9.9.9.9` and `208.67.222.222`
  independently per A/AAAA family as well (or replace the known-NXDOMAIN
  server with two independently verified good resolvers).  Retain the current
  union and all-resolvers-empty rule, and add a fixture where Cloudflare is
  NXDOMAIN and Google fails but Quad9/OpenDNS supplies the A record; it must
  remain `sources.probe: ok` and not increment the public-outage counter.

### Release-hygiene observation (non-verdict)

`src/ops/voice-watchdog.check.ts:458-474` contains the static fixture literal
`xoxb-secret-token`.  It is not a credential and does not alter runtime
behavior, but it can resemble a Slack token to generic push-protection rules.
Construct the fixture and its assertion pattern at runtime (for example, join
the token segments) before committing if the repository's push protection
flags it; this is not counted as a production defect.

### Checks run

- `D:\\Workspace\\Active\\grizzly-hcp\\node_modules\\.bin\\tsx.cmd src/ops/voice-watchdog.check.ts` — passed (`voice watchdog self-check passed`).
- `D:\\Workspace\\Active\\grizzly-hcp\\node_modules\\.bin\\tsx.cmd src/ops/alert.check.ts` — passed (`ops alert self-check passed`).
- `D:\\Workspace\\Active\\grizzly-hcp\\node_modules\\.bin\\tsc.cmd --noEmit`, filtered for `src/ops/voice-watchdog.ts` and `src/ops/voice-watchdog.check.ts` — zero matching errors.  The command exits 2 only for four pre-existing errors in `src/automations/estimates/from-proposal.ts` and `src/hcp/mine-pricebook-candidates.ts` outside this review surface.
