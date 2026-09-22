# C0 Voice Canary — Implementation-Seam Audit (read-only)

**Date:** 2026-09-22 (America/Chicago)
**Worktree:** `C:\Users\carte\orca\workspaces\grizzly-hcp\grizzly-livekit-c0-stage1`, branch `barnscarter-ops/grizzly-livekit-c0-stage1` @ `ac42ac9` (same commit as primary tree `D:/Workspace/Active/grizzly-hcp` @ `main`)
**Task:** read-only seam audit for the approved Stage 1 **C0** voice canary; propose exact new module/test paths for a disabled-by-default C0 controller, a durable outbox, a stale-outbox monitor, a transfer-adapter contract, and the LiveKit / GPT-Live integration seams.
**Scope:** documentation only. No production voice/SMS/HCP/CT102/poller code was modified. No credentials, `.env`, provider API, network service, Proxmox, Twilio, LiveKit, OpenAI, or Housecall Pro access. Nothing installed, committed, pushed, or deployed.
**Deliverable:** this file. `git status` in this worktree shows only this file as new (verified: `?? docs/2026-09-22-c0-voice-canary-seam-audit.md`, empty `git diff --stat`).

---

## 0. Stage 1 isolation invariant (binding — state this in every C0 artifact)

Stage 1 code must be **inert when disabled**. It must not fail open to, fall back to, import, call, or take any dependency on the existing ConversationRelay adapter or `src/agent/voice-server.ts` — in either direction — and it must not reroute production traffic or reuse a production code path.

Production is preserved **by absence**, not by rerouting:

- C0 ships as **new files only**, imported by nothing that currently runs. No file in production is edited, and no production module imports a C0 module.
- C0 runs in **its own process with its own entry point** (its own port if it ever listens). If that process is stopped, crashed, or never started, the live line behaves exactly as it does today — that is the test of the invariant.
- C0's **fallback contract is its own and canary-only**: when a C0-side action fails, C0 does its own give-up / record / alert. It does not hand the caller back to ConversationRelay, and it does not invoke production helpers to recover.
- There is **no per-call transport switch inside production** and **no shared helper extracted out of production**. Anything that would require touching `voice-server.ts` is out of Stage 1 by definition.

Sections 4.4, 4.5 and 4.6 below are written to satisfy this invariant; §5 states the resulting (zero) production touchpoints.

---

## 1. What exists today (descriptive context for the seams — not a dependency surface)

| Concern | Path | Anchors |
|---|---|---|
| Twilio ConversationRelay adapter (HTTP + WS, block dispatch, transfer chain) — **production; not to be imported, called, or modified by Stage 1** | `src/agent/voice-server.ts` | endpoint doc `:1-27`; env + TTS consts `:40-50`; `sessions` Map `:68`; `buildRelayTtsAttrs` / `normalizeTtsVoice` `:82-96`; `appendJsonl` `:120-124`; `dialTwiml` `:140-153`; `spawnPipeline` `:155-192`; HTTP routes `:196-305`; give-up copy `:291-299`; WS `:309-484`; `sendText` `:486-489`; `server.listen` `:491-497` |
| Voice persona + tool allow-list | `src/agent/resolver.ts` | `Channel` union `:1`; `VOICE_INCLUDED` `:6-11` (rationale `:3-5`); voice filter in `resolveTools` `:49-54`; `VOICE_INSTRUCTIONS` `:67`; wired `:312` |
| Agent factory used per turn | `src/agent/index.ts` | `createMaverickAgent` `:209` (called with `'voice'` from `voice-server.ts:339`) |
| Business hours (America/Chicago) | `src/agent/office-hours.ts` | whole file, imports nothing |
| Audit trail | `src/agent/audit-log.ts` | `makeAuditEntry` `:23`, `logAudit` `:46` (voice intents assigned `voice-server.ts:371-442`, logged `:445-456`) |
| Post-call pipeline (booking / message / reschedule) | `src/automations/bookings/from-voice.ts` | stdin JSON contract `:67-73`; `PENDING_FILE` `:60`; `appendPending` `:62-65`; `STATUS_BY_KIND` `:160-164`; success row `:342-358`; failure-to-disk `:383-401` |
| Schedule parsing + offset ISO + reply hint | `src/automations/bookings/schedule-command.ts` | `parseScheduleCommand` `:57`, `toOffsetIso` `:84`, `formatScheduleReplyHint` `:97` |
| Approval poller (durable list + capped seen set) | `src/automations/bookings/approval-poller.ts` | consts `:31-33`; atomic `.tmp`+rename `:52-68`; capped seen set `:70-86`; tick loop `:260-269` |
| Durable claim store precedent (SQLite) | `src/server/sms-inbound-event-store.ts` | WAL + unique PK + `claim`/`mark` `:29-104` |
| Ops alerting (ntfy + ops SMS) | `src/ops/alert.ts` | `formatOpsSms` `:29`, `resolveOpsSmsConfig` `:35`, `sendOpsSms` `:51`, `sendOpsAlert` `:81` |
| Loopback-only internal endpoint (pattern to mirror, not to call) | `src/server/customer-chat-server.ts`, `src/server/thumbtack-reply.ts` | route + loopback gate `:465-483`; argv listen guard `:499-501`; `isLoopbackAddress` `thumbtack-reply.ts:61-64` |
| Process supervision | `ecosystem.config.cjs` | `voice-server` `:33-41`; `booking-approval-poller` `:43-49`; tsx-CLI-as-script pattern `:14` |
| Host deployment template (prep only) | `deploy/ct103/booking-approval-poller.service`, `deploy/ct103/README-BOOKING-POLLER.md` | `Environment=TZ=America/Chicago` `:19`; absolute tsx `ExecStart` `:23`; "prep only until Phase 1 gate" `README:3-5` |
| Live voice design of record | `docs/superpowers/specs/2026-07-11-maverick-voice-fulltime-design.md` | components 1-6, "Testing" |

**No LiveKit, GPT-Live/Realtime, outbox, stale-monitor, or canary code exists in this repo or the primary tree** (case-insensitive grep over `*.ts|*.md|*.json|*.cjs`, plus `package.json` deps). The nearest existing pieces are `ws`, `@ai-sdk/openai`, `dotenv`. C0 is greenfield.

---

## 2. House conventions a C0 module must follow

1. **Plain `http` + `ws`, no framework.** The house shape is one `http.createServer` with `new URL(req.url, …)` and `method`/`pathname` comparisons (`voice-server.ts:196-305`) and a bare `new WebSocketServer({ server })` (`:309`). C0's own listener, if it has one, copies the shape; it does not share the file.
2. **Dependency-free modules are the ones that actually run.** `src/agent/office-hours.ts`, `src/ops/alert.ts`, and `src/automations/bookings/schedule-command.ts` import **nothing**. This worktree has **no `node_modules`** (the primary tree does), so dependency-free checks are the only ones executable here — measured, §7. Stage 1 modules must therefore be import-free (Node builtins only) so the canary's checks run from a bare worktree and nothing forces an install.
3. **Disabled-by-default gates are env string compares, with the unsafe branch simply absent.** Precedents: `HCP_VIA_MCP` (`.env.example:22`, default `false`) and `AUDIT_LOG_RESPONSES === 'true'` (`src/agent/run.ts:113`). `src/hcp/mcp-read.check.ts:29-40` proves the gate by grepping **its own source** for the guard string — the accepted evidence style for "nothing else can run".
4. **Allow-list, not deny-list, for anything customer-facing.** `VOICE_INCLUDED` (`resolver.ts:6-11`) with the rationale at `:3-5`, restated for advisory at `:14-16`: any future entry is locked **out** by default. C0 inherits this: no new tool, no HCP write, and its caller surface gated by an allow-list that is **empty-safe** (empty ⇒ refuse everything, independent of the enable flag).
5. **Durable state has three accepted shapes** — pick deliberately:
   - append-only JSONL for events/intents (`voice-server.ts:120-124`; `from-voice.ts:62-65`);
   - JSONL + atomic `.tmp`+`rename` rewrite for mutable records (`approval-poller.ts:52-68`), plus a capped `.json` seen-set (`:70-86`);
   - `node:sqlite` with a unique primary key when concurrent replay must be arbitrated (`sms-inbound-event-store.ts:29-104`).
   All land under `data/` and are git-ignored (`.gitignore:7-9`, `.env` at `:3`). **`node:sqlite` availability on the PC Node runtime is an unconfirmed external gate** (`memory/HANDOFF.md:251-256`) — Stage 1 must not depend on it.
6. **Persist the failure before anything else.** The production pattern is: write the row, then exit non-zero, then alert (`from-voice.ts:383-401`; `voice-server.ts:169-189`). The C0 outbox exists to make that path idempotent rather than duplicated.
7. **Alerts:** `sendOpsAlert(title, message, { priority, tags })` (`ops/alert.ts:81`), fire-and-forget per channel, never allowed to break the caller. `resolveOpsSmsConfig` refuses `OPS_SMS_FROM === TWILIO_PHONE_NUMBER` (`:47`) — ops SMS must never leave from the customer line.
8. **Subprocess contract:** JSON on stdin, JSON on stdout, human progress on stderr, non-zero exit = alert (`voice-server.ts:155-192`, `from-voice.ts:67-73`).
9. **Timezone is always explicit.** `officeStatus()` pins `America/Chicago`; `toOffsetIso()` (`schedule-command.ts:84`) exists because `toISOString()` rolls Central evenings forward a day; systemd units set `TZ=America/Chicago` explicitly.
10. **Tests are `*.check.ts` assert scripts, not a framework.** Runner `npx tsx <path>`; top-level `node:assert/strict`; final `console.log('… OK')` (`office-hours.check.ts:28`, `voice-lookup.check.ts:38`, `alert.check.ts:89`). Network is stubbed by **injection**, not mocking libraries (`alert.check.ts:57-77` `fetchImpl`; `thumbtack-reply.check.ts:5-9` injected generator). Time is fixture `Date`s (`office-hours.check.ts:11-26`). There is no `npm test` script and no CI.
11. **Import direction is a hazard, and in Stage 1 it is simply forbidden.** `voice-server.ts:491` starts a listener at module load — `src/agent/voice-server.twiml.test.ts:4-12` needs `--test-force-exit` for exactly that reason. Stage 1 therefore creates **no import edge either way** across the production boundary (§0).

---

## 3. Proposed new paths (exact)

| # | Seam | Module | Focused check |
|---|---|---|---|
| 1 | Disabled-by-default C0 controller (own entry point) | `src/agent/voice/c0-controller.ts` (+ `src/agent/voice/c0-entry.ts`) | `src/agent/voice/c0-controller.check.ts` |
| 2 | Durable outbox | `src/agent/voice/outbox.ts` | `src/agent/voice/outbox.check.ts` |
| 3 | Stale-outbox monitor (own process) | `src/agent/voice/outbox-monitor.ts` | `src/agent/voice/outbox-monitor.check.ts` |
| 4 | Transfer-adapter contract (C0-owned) | `src/agent/voice/transfer-adapter.ts` | `src/agent/voice/transfer-adapter.check.ts` |
| 5 | Transport seam (LiveKit / GPT-Live, C0-owned) | `src/agent/voice/transport.ts` + `src/agent/voice/livekit-transport.ts` | `src/agent/voice/transport.check.ts` + `src/agent/voice/livekit-transport.check.ts` |
| 6 | C0-local block / spoken-text handling | `src/agent/voice/blocks.ts` (C0-only; **not** extracted from production) | `src/agent/voice/blocks.check.ts` |

`src/agent/voice/` is a new subdirectory; it is the established grouping convention under the agent (`src/agent/tools/reads/`, `src/agent/workflows/`) and keeps each check colocated with its source (`tools/reads/voice-lookup.check.ts`). Flat alternative if Carter prefers zero new directories: `src/agent/voice-*.ts`, matching `voice-server.ts` / `office-hours.ts`. **Pick one; do not mix.** No production file changes under either choice.

Every module above is Node-builtins-only. None imports a production module; no production module imports any of them (§0).

---

## 4. Per-module seam spec

### 4.1 `src/agent/voice/c0-controller.ts` — disabled by default, its own process

- **Two independent gates.** `VOICE_C0_ENABLED` must equal the literal `'true'` (absent ⇒ off), **and** the caller must match `VOICE_C0_ALLOWLIST` (comma-separated E.164). Empty/absent allow-list ⇒ refuse every caller regardless of the enable flag. With either gate closed the controller performs **no** action: it does not dial, spawn, write, or alert, and it does not delegate anywhere — it declines and stops. That is the "inert when disabled" property in code.
- **Entry point:** `src/agent/voice/c0-entry.ts` — C0's own process boundary (own argv guard in the style of `customer-chat-server.ts:499-501`, own port env, own listener if any). Nothing in production calls it; it is started deliberately (PM2 entry or manual) and stopped the same way.
- **Shape:** `export function createC0Controller(deps: C0Deps)` with everything injected — `{ now: () => Date, officeStatus, transport, transferAdapter, outbox, generate, logAudit, alert }` — plus one pure decision function `export function decideC0Turn(input, decision): C0Decision`. Policy is testable with no socket, no clock, and no process.
- **Decision vocabulary:** C0's own enum `transfer | reschedule | booking | message | reply`, ordered `transfer > reschedule > booking > message`. It is **modelled on** the production block set (`voice-server.ts:355-369`) so a future adapter is ergonomic, but it is C0's type, parsed by C0's parser (§4.6), with no runtime coupling.
- **Audit:** C0 writes its own intent strings through the injected `logAudit`; it does not reuse production intent literals, because it never runs in a production session. Names are C0-scoped (`voice_c0_*`) so existing aggregation is untouched and the canary's rows are trivially separable.
- **Canary-only fallback:** every failure inside C0 is handled **inside C0** — C0's own give-up copy, an outbox record, an ops alert. There is no path from a C0 failure back into ConversationRelay or `voice-server.ts` (§0).
- **Check proves:** (a) gate off ⇒ disabled decision and zero dep invocations; (b) enable-on + allow-list miss ⇒ disabled; (c) both open ⇒ decision parity with the block cases, including after-hours general-transfer → message; (d) a source-grep guard proof in the `mcp-read.check.ts:29-40` style that the default is off; (e) a **no-import assertion** that `c0-controller.ts` / `c0-entry.ts` contain no reference to `voice-server` (this is the invariant's regression test).

### 4.2 `src/agent/voice/outbox.ts` — durable outbox

- **Purpose:** every caller-visible side effect C0 intends (transfer request, booking/message/reschedule handoff, ops alert, note write) is written **once, with an idempotency key, before it is attempted**, so a crash between "Maverick said it" and "the pipeline ran" cannot lose a caller. Production can only alert about that loss today (`voice-server.ts:169-189`).
- **Record:** `{ id, idempotencyKey, callSid, kind, target?, payload, status, attempts, createdAt, lastAttemptAt, error? }`. Statuses: `pending | in_flight | done | failed | stale_alerted`. No PII beyond what `pending-bookings.jsonl` already carries.
- **Storage:** append-only JSONL at `VOICE_OUTBOX_PATH` (default `data/voice-outbox.jsonl`, git-ignored `.gitignore:7`), single-writer, atomic `.tmp`+`rename` for status transitions — the `approval-poller.ts:52-68` shape. **No `node:sqlite` in the canary** (`memory/HANDOFF.md:251-256`); the claim-table design (`sms-inbound-event-store.ts:29-104`) is a later-stage option if concurrency ever demands it.
- **API:** `append(record)`, `list()`, `markStatus(key, status, patch)`, `claimNext()` — filesystem-only, path injectable.
- **Check:** round-trip in a temp dir; duplicate `idempotencyKey` returns the existing record (no second record); a second `Outbox` instance over the same file sees exactly one record (restart replay); a corrupt trailing line is skipped, not fatal (defensive parse at `approval-poller.ts:58-61`).

### 4.3 `src/agent/voice/outbox-monitor.ts` — stale-outbox monitor

- **Policy is pure:** `export function findStale(records, now, staleAfterMs)`. Only `pending`/`in_flight` older than the threshold qualify; `done`/`failed` never nag; `stale_alerted` waits for a second, longer tier (prevents an alert storm).
- **Act:** one `sendOpsAlert(...)` per record per tier, then write the marker back onto the record (`status: stale_alerted`, `lastAlertAt`) — dedupe lives in the outbox itself, so **no new seen-file** and no reliance on production state. Title/message shape and `priority`/`tags` follow `from-voice.ts:367-381`; the alert names the outbox path the way `voice-server.ts:184` names the pending file.
- **Run loop:** `createOutboxMonitor(deps).tick()` plus a long-lived entry point started the `approval-poller.ts:260-269` way (banner, `await tick()`, `setInterval`). Interval env `VOICE_OUTBOX_MONITOR_INTERVAL_MS` mirrors `BOOKING_POLL_INTERVAL_MS` (`approval-poller.ts:33`).
- **Supervision, additive only:** a **new, separate** PM2 app block in `ecosystem.config.cjs` — a config addition, not an edit to the `voice-server` block (`:33-41`). No in-process start inside any production process. A systemd pair (`deploy/ct103/voice-outbox-monitor.{service,timer}`) is **prep-only** and only if a host is approved; `deploy/ct103/README-BOOKING-POLLER.md:3-5` is explicit that these artifacts are not installed from the doc.
- **Check:** fixture `Date`s at the boundary (`office-hours.check.ts:11-26` style) and an injected capture stub for alerts (`alert.check.ts:57-77`): below-threshold silence, exactly one alert per crossing, no repeat on the next tick, `done` never alerts.

### 4.4 `src/agent/voice/transfer-adapter.ts` — transfer contract, C0-owned

Today the dial TwiML, whisper screen, fallback chain, give-up copy and `voice-messages.jsonl` record are inline in production (`voice-server.ts:140-153`, `:238-263`, `:265-301`, `:116-118`, `:284-299`). Stage 1 **re-derives that policy inside C0** rather than sharing it, and the contract's purpose is that the policy lives in exactly one C0 place while the adapter only dials.

- **Contract (C0-owned; no production import, no production call):**
  ```ts
  type TransferRequest = { target: 'carter' | 'jaime'; kind: 'general' | 'emergency';
                            callerName?: string; reason?: string; callbackPhone?: string;
                            callId: string; screening: 'whisper' | 'direct' };
  type TransferOutcome = { status: 'accepted' | 'declined' | 'no_answer' | 'failed'; detail?: string };
  interface TransferAdapter { dial(req: TransferRequest): Promise<TransferOutcome>; }
  ```
- **Policy that stays in the C0 controller, never in an adapter:** target ordering, the fallback to the other person, the both-failed record, the give-up copy. The adapter returns a status; C0 decides what the caller hears. That is the property the canary proves.
- **Canary implementation:** a **stub** `createInertTransferAdapter()` that returns `failed` unless the adapter is explicitly configured, so an unconfigured canary cannot dial anyone. A future approved adapter may speak TwiML over C0's **own** loopback endpoint — mirroring the loopback gate pattern at `customer-chat-server.ts:465-470` / `isLoopbackAddress` (`thumbtack-reply.ts:61-64`) as a convention, while **calling no existing service**. Because the Canary fallback is C0-only, a `failed` outcome produces C0's own recording + alert and never a handoff into production.
- **Check:** injected `fetchImpl` records request URLs/bodies (`alert.check.ts:57-77` style); every outcome maps to exactly one controller action; unknown status ⇒ `failed` (never a silent success); `screening: 'direct'` is only ever produced for `kind: 'emergency'` (the production rule at `voice-server.ts:140-147`); the default adapter is asserted inert.

### 4.5 `src/agent/voice/transport.ts` + `src/agent/voice/livekit-transport.ts` — LiveKit / GPT-Live seams

- **`transport.ts` defines C0's own interface** — inbound `session`, `prompt`, `interrupt`, `stop`, `error`; outbound `sendText(text)`, `endSession({ handoffData })`, `interrupt()`. Nothing here imports production, and production imports nothing here.
- **Vocabulary is a modelling choice, not coupling.** C0's message names and the `handoffData` shape are deliberately compatible with the ConversationRelay protocol (`voice-server.ts:318-480`, `:402-411`, `:486-489`) so a future approved adapter is cheap to write. This is documented so it is never mistaken for a dependency: **no Stage 1 artifact constructs a ConversationRelay connection, reuses its client, or reuses its endpoints.**
- **`livekit-transport.ts` ships as a typed stub** that throws `c0_transport_not_implemented` unless both gates (§4.1) are open. **No LiveKit or Realtime dependency is added at Stage 1**: `package.json` contains neither today, and adding one is a separate approved change with pinned versions. A future ConversationRelay-shaped adapter, if ever chosen, would be written **inside C0 against C0's own endpoint**, not against `voice-server.ts`.
- **GPT-Live seam (config names, no values):** `VOICE_C0_PROVIDER` / `VOICE_C0_MODEL`, named after the existing `VOICE_TTS_PROVIDER` / `VOICE_TTS_VOICE` pair (`voice-server.ts:49-50`, `.env.example:46-51`). Note the reason that pair is emitted explicitly — the ElevenLabs / relay-error-`64106` silence outage documented at `voice-server.ts:44-48`, `:76-84`. C0 must emit explicit provider configuration and never rely on a platform default.
- **Speech does not go through `src/agent/model-router.ts`:** its roles are `REASONING | EXTRACTION | VISION | CHEAP` over AI-SDK text/vision providers (`:5`) — there is no realtime/audio role. Persona continuity is achieved by **injection, not import**: `c0-entry.ts` may construct its generator from `createMaverickAgent('voice')` (`index.ts:209` + `resolver.ts:312`) — a library module, not the relay adapter — and hand it to `createC0Controller`. `c0-controller.ts` itself stays Node-builtins-only, which is what keeps its check runnable from a bare worktree (§2.2) and keeps `VOICE_INCLUDED` / `VOICE_INSTRUCTIONS` single-sourced without C0 touching conversation transport.
- **Checks:** `transport.check.ts` asserts the interface's message shapes round-trip (`text` with `last: true`; `endSession` carrying URL-encoded JSON `handoffData` as at `voice-server.ts:126-132`) and that no third-party package is imported; `livekit-transport.check.ts` asserts the stub is inert with the gate closed, throws with both gates open, and imports only Node builtins.

### 4.6 `src/agent/voice/blocks.ts` — C0-local block / spoken-text handling

C0 needs the same parse-and-strip semantics as the production relay (`voice-server.ts:355-369`: four blocks plus `[ESTIMATE_READY]`, bold/link stripping). Stage 1 does **not** extract those helpers from production and does **not** share them — that would be a production edit and an import edge, both forbidden by §0. Instead `blocks.ts` is a **C0-owned** module, and the ~15 lines of regexes are deliberately duplicated.

- Rationale to record in the module header: bounded duplication (~15 lines) versus an edit inside the live phone line. Production is untouched, and the C0 copy is pinned by `blocks.check.ts`.
- If a later approved stage wants single-sourcing, that is a production change with its own review and rollback lever — explicitly **not** Stage 1.
- `blocks.check.ts` pins: each block type extracted; spoken text strips all blocks plus `**bold**` and `[text](url)`; a response with no block yields no decision; malformed block JSON yields a `reply` decision rather than a throw (the defensive posture at `voice-server.ts:374-375`, `:416-418`).

---

## 5. Production touchpoints at Stage 1: zero

Stage 1 adds **new files only**. No line of `src/agent/voice-server.ts`, `src/automations/bookings/*`, `src/server/*`, `src/ops/*`, or `src/hcp/*` changes, and no production module gains an import of a C0 module.

Additive, optional, and non-rerouting (each still a separate approval, none required for the canary to exist):

| Artifact | Anchor | Nature |
|---|---|---|
| `ecosystem.config.cjs` | a **new** app block alongside `:33-49` | config addition; the existing `voice-server` block is not modified |
| `.env.example` | a new block after `:46-51` | documents `VOICE_C0_*` / `VOICE_OUTBOX_*` **names** with safe defaults; no values |
| `memory/HANDOFF.md` | voice section `:12-61` | records the canary's state and its disable lever |

Nothing in this table is edited by this audit.

**Disable lever, stated plainly:** `VOICE_C0_ENABLED` unset/false, or the C0 process not running. Either one leaves the live line byte-identical to today, because no production code path reaches C0.

---

## 6. Environment surface (names only — no values, no secrets)

`VOICE_C0_ENABLED` (default off) · `VOICE_C0_ALLOWLIST` (empty ⇒ everything refused) · `VOICE_C0_PROVIDER` · `VOICE_C0_MODEL` · `VOICE_TRANSFER_ADAPTER` (default inert) · `VOICE_OUTBOX_PATH` · `VOICE_OUTBOX_STALE_MS` · `VOICE_OUTBOX_MONITOR_INTERVAL_MS`.

Follow `.env.example` conventions: a commented block per area, the default stated, never a committed value. The canary allow-list holds a live phone number — it belongs in `.env` (git-ignored, `.gitignore:3`) and is not written into any tracked file, including this report.

---

## 7. Verification recipe

**Proposed focused commands (per new check, from the worktree root):**

```bash
npx tsx src/agent/voice/blocks.check.ts
npx tsx src/agent/voice/c0-controller.check.ts
npx tsx src/agent/voice/outbox.check.ts
npx tsx src/agent/voice/outbox-monitor.check.ts
npx tsx src/agent/voice/transfer-adapter.check.ts
npx tsx src/agent/voice/transport.check.ts
npx tsx src/agent/voice/livekit-transport.check.ts
```

**Production regression gates — run to prove production was left alone, not as a C0 dependency:**

```bash
npx tsx --test --test-force-exit src/agent/voice-server.twiml.test.ts   # TTS attr contract
npx tsx src/agent/office-hours.check.ts
npx tsx src/agent/tools/reads/voice-lookup.check.ts
npx tsx src/automations/bookings/schedule-command.check.ts
npx tsx src/ops/alert.check.ts
npx tsc --noEmit
```

`npx tsc --noEmit` needs installed deps and carries a known unrelated baseline (`memory/HANDOFF.md:247-249`: four pre-existing diagnostics in `from-proposal.ts` / `mine-pricebook-candidates.ts`) — gate on "no **new** diagnostics", not on a clean exit.

**Observed in this worktree, 2026-09-22 (read-only; no deps installed, no network calls made, worktree-local sources only):**

| Check | Result |
|---|---|
| `src/agent/office-hours.check.ts` | `office-hours.check OK`, exit 0 |
| `src/ops/alert.check.ts` | `✓ ops alert self-check passed`, exit 0 |
| `src/automations/bookings/schedule-command.check.ts` | `✓ schedule-command self-check passed`, exit 0 |
| `src/hcp/contact-normalize.check.ts` | `contact-normalize.check OK`, exit 0 |
| `src/agent/tools/reads/voice-lookup.check.ts` | not runnable here — `ERR_MODULE_NOT_FOUND: @mastra/core` |
| `src/server/sms-intake.check.ts` | not runnable here — `ERR_MODULE_NOT_FOUND: zod` |
| `src/agent/voice-server.twiml.test.ts`, `npx tsc --noEmit` | not runnable here (no `node_modules`; the primary tree has them) |

Both failures share one root cause — **this isolated worktree ships without `node_modules`** — and neither is a defect in the checked logic. This is the empirical reason §3 requires Node-builtins-only C0 modules: they are the subset that can gate a canary from a bare worktree, with nothing installed and nothing imported from the live stack.

---

## 8. Open decisions for Carter / the coordinator

1. **Isolation is the design, not a stage.** §0 is binding: no fail-open, no fallback into ConversationRelay, no import or call in either direction, production preserved by absence. Any later proposal that needs a touch inside `voice-server.ts` is a different, separately approved change.
2. **Monitor and entry-point host.** `voice-server` and `booking-approval-poller` run on CartersPC PM2 (`memory/HANDOFF.md:14`); `deploy/ct103/` is prep-only until a cutover gate passes (`README-BOOKING-POLLER.md:3-5`). Canary default: PC PM2, systemd later.
3. **Outbox store.** JSONL-only for C0; `node:sqlite` remains unconfirmed on the PC runtime (`memory/HANDOFF.md:251-256`).
4. **Canary caller-visible behaviour.** Recommendation: C0's own, self-contained behaviour only — the canary proves the seam, and any caller-visible difference is C0's own, never a mutation of the production line.
5. **Dependency additions** (LiveKit SDK, Realtime client) are explicitly out of Stage 1 and need their own approved change with pinned versions.
6. **`VOICE_TRANSFER_ADAPTER` default.** Recommendation: the inert stub, so an unconfigured canary dials nobody.

---

## 9. Boundaries honored

Read-only audit; the only artifact is this file (`git status`: one new untracked file, empty `git diff --stat`). No edits outside this report; no dependency install; no `.env` read (only the committed `.env.example`); no credentials, provider APIs, network services, Proxmox, Twilio, LiveKit, OpenAI, or Housecall Pro access; no commit, push, or deploy; no live state touched. All evidence in this report is from sources inside this worktree.

---

## 10. Stage 1 acceptance — delivered C0 foundation (2026-09-22)

Accepted scope for this stage: **only** the Node-builtins-only, disabled-by-default C0 foundation — the feature/config contract, the durable idempotent outbox, and the pure stale-outbox monitor. The controller, transfer adapter, transport seams and block handling (§3 seams 1, 4, 5, 6) are **deferred to a later approved stage**, and §4.3's alerting tick loop is narrowed to a pure report (§10.3). The audit's path proposal in §3 is unchanged for the deferred seams; this stage adds the three modules below under the same `src/agent/voice/` grouping, each with a colocated check.

| # | Delivered module | Colocated focused check | Command |
|---|---|---|---|
| 1 | `src/agent/voice/c0-config.ts` — feature/config contract, both gates, redacted operator view | `src/agent/voice/c0-config.check.ts` | `npx tsx src/agent/voice/c0-config.check.ts` |
| 2 | `src/agent/voice/outbox.ts` — file-backed durable idempotent outbox | `src/agent/voice/outbox.check.ts` | `npx tsx src/agent/voice/outbox.check.ts` |
| 3 | `src/agent/voice/outbox-monitor.ts` — pure stale-outbox monitor | `src/agent/voice/outbox-monitor.check.ts` | `npx tsx src/agent/voice/outbox-monitor.check.ts` |

### 10.1 Accepted defaults (binding for the next stage)

| Env name | Default when absent | Note |
|---|---|---|
| `VOICE_C0_ENABLED` | **off** — only the literal `'true'` enables | gate 1; exported as `VOICE_C0_ENABLED_DEFAULT = false` |
| `VOICE_C0_ALLOWLIST` | **empty ⇒ every caller refused** | gate 2; a non-E.164 entry is dropped, and its warning names the entry *position*, never the digits |
| `VOICE_C0_PROVIDER` | `null` (unset ⇒ nothing emitted) | explicit emission stays mandatory, never a platform default (§4.5) |
| `VOICE_C0_MODEL` | `null` | as above |
| `VOICE_OUTBOX_PATH` | `data/voice-outbox.jsonl` (git-ignored) | resolved against an explicitly supplied cwd |
| `VOICE_OUTBOX_STALE_MS` | `300000` (5 min) | non-positive / non-integer ⇒ default **plus a warning**, never a silent clamp |
| `VOICE_OUTBOX_MONITOR_INTERVAL_MS` | `60000` | parsed and shipped, but **no timer runs** at this stage |
| `VOICE_TRANSFER_ADAPTER` | not implemented here | the inert stub arrives with §4.4, next stage |

`C0_ENV_NAMES` in `c0-config.ts` is the complete read surface, and the config check asserts that: no other key in the repo's committed `.env.example` is referenced by the contract.

### 10.2 Outbox — accepted shape

- Record: `{ id, idempotencyKey, callSid, kind, target?, payload, status, attempts, createdAt, lastAttemptAt, error? }`; statuses `pending | in_flight | done | failed | stale_alerted`; kinds are an allow-list (`transfer | booking | message | reschedule | ops_alert | note`).
- `id` is **derived** from the idempotency key (`ob_` + the first 20 hex of its SHA-256), so replaying a key is the same record forever.
- A new record appends one JSONL line; a status transition rewrites atomically via `.tmp` + `rename` (the `approval-poller.ts:52-68` shape). Reads are defensive: a corrupt line is skipped **and counted**, never fatal. De-duplication is last-wins per key, so a reopened file (restart replay) sees exactly one record per key — asserted with a second `Outbox` instance over the same path.
- **Idempotency keys are opaque by construction**: no `+`, no `@`, no whitespace, no parentheses, and at least one non-digit character. A phone number or an e-mail address therefore cannot be a key — which is what makes it safe for the monitor's report to carry the key verbatim.
- **Redaction is the exposure boundary**: `snapshot()` / `redactRecord()` mask phone-like strings and 10–15 digit numbers, e-mail addresses, and embedded numbers inside longer text, and flag the result `redacted: true`. `list()` is internal-facing only. The durable record keeps the real value, because that is what a replay needs — asserted in both directions.
- **Single writer, by contract.** Concurrency arbitration stays a later-stage question; the audit still keeps an embedded SQL database out of the canary.

### 10.3 Monitor — accepted shape (narrowed from §4.3)

§4.3 described an alerting tick loop that wrote a `stale_alerted` marker back onto the record. **This stage ships the pure policy only**, so the monitor cannot act on the world:

- `findStale(records, now, staleAfterMs, options?)` and `analyzeOutboxHealth(...)` are pure: **zero runtime imports** (its single import is `import type`, erased before load), an **injected clock** (the source contains no `new Date(` and no `Date.now()`), and an **injected window** — the config contract owns the default.
- No retry, no write, no delivery, no external call: no marker is written, no seen-file exists, and the module has no file-system, network, process, timer or printing surface at all. The input array is never mutated (proved against a deep-frozen fixture).
- Staleness policy: only `pending` / `in_flight` are eligible (`>=` the window); `done` / `failed` never nag; `stale_alerted` waits for a second, longer tier (`2×` by default) so one crossing reports once, and its age falls back to `lastAttemptAt` then `createdAt`; a timestamp that cannot be parsed is **counted** (`unparseableCount`) rather than reported stale; a record stamped in the future is never stale.
- Reports are redacted by construction: a stale entry carries identity and timing only — `payload` and `error` are never copied, asserted by key set.
- `formatStaleReport(...)` returns strings (naming the outbox only as a caller-supplied label) and states in its own output that it does not retry, write or deliver. **Nothing in this stage starts a process, a timer or a listener** — no `c0-entry.ts`, no PM2 app block, no systemd unit, no `.env.example` edit.

### 10.4 Verification observed, 2026-09-22 (this worktree, still no `node_modules`)

| Command | Result |
|---|---|
| `npx tsx src/agent/voice/c0-config.check.ts` | `c0-config.check OK`, exit 0 |
| `npx tsx src/agent/voice/outbox.check.ts` | `outbox.check OK (temp dir …, 10 records exercised)`, exit 0 |
| `npx tsx src/agent/voice/outbox-monitor.check.ts` | `outbox-monitor.check OK`, exit 0 |
| §7 production regression gates — runnable subset | `office-hours.check OK`, `✓ ops alert self-check passed`, `✓ schedule-command self-check passed`, `contact-normalize.check OK` — all exit 0 |
| focused `rg` over `src/agent/voice/*.ts` **excluding** `*.check.ts`, for `voice-server`, `conversationrelay`, `twilio`, `livekit`, `openai`, `housecall`, `proxmox`, `ct102`, `sqlite`, `axios`, `@mastra`, `hcp`, `fetch`, `child_process`, `setInterval`, `setTimeout`, `listen(`, `process.exit` | **no matches** (rg exit 1). The only hits anywhere under `src/agent/voice/` are inside the three `*.check.ts` files, where they are the assertion literals that pin the invariant |
| every import specifier under `src/agent/voice/` | `node:*` or `./` (C0-local) only — no third-party specifier exists, and the monitor has no runtime import at all |
| `git status --porcelain` | `?? docs/2026-09-22-c0-voice-canary-seam-audit.md` + `?? src/agent/voice/` only, `git diff --stat` empty — no tracked production file touched |

`voice-server.twiml.test.ts` and `npx tsc --noEmit` remain unrunnable in this worktree for the reason recorded in §7 (no `node_modules`); neither is part of this stage's acceptance. The three new checks run from a bare worktree precisely because the modules they pin are Node-builtins-only.

### 10.5 Production touchpoints after this stage: still zero

The §5 additive table gains no row that was acted on: `ecosystem.config.cjs`, `.env.example` and `memory/HANDOFF.md` were **not** edited, no PM2 app or systemd unit was added, and no production module imports a C0 module. §8's open decisions (monitor/entry-point host, dependency additions) are untouched — there is nothing to host yet and nothing added. The disable lever is unchanged and now assertable in code: `VOICE_C0_ENABLED` unset or false ⇒ gate 1 closed ⇒ the contract's caller must decline and stop.

---

## 11. Stage 1 acceptance — controller + transfer-adapter contracts (2026-09-22)

Accepted scope for this stage: the **controller contract** and the **canary-only transfer-adapter
contract** — §3 seams 1 and 4, delivered as contracts with colocated focused checks. Delivered as
**new files only**, with one pinned-list edit inside an existing check (§11.5). Still deferred:
`c0-entry.ts` (no process boundary, no port, no listener), the transport seams and block handling
(§3 seams 5 and 6), §4.3's alerting tick loop, and every §5 additive deployment artifact.

| # | Delivered module | Colocated focused check | Command |
|---|---|---|---|
| 1 | `src/agent/voice/c0-controller.ts` — typed, inert-by-default controller contract | `src/agent/voice/c0-controller.check.ts` | `npx tsx src/agent/voice/c0-controller.check.ts` |
| 2 | `src/agent/voice/transfer-adapter.ts` — canary-only transfer-adapter contract | `src/agent/voice/transfer-adapter.check.ts` | `npx tsx src/agent/voice/transfer-adapter.check.ts` |

### 11.1 Controller — accepted contract

- **Composition depends only on the two local interfaces.** The controller imports `node:crypto` plus
  `./c0-config.js` (`evaluateC0Gate`, `C0Config`, `C0GateResult`) and `./outbox.js`
  (`OUTBOX_KINDS`, `MAX_PAYLOAD_CHARS`, `redactValue`, record/append types). It reads **no**
  environment variable and no path of its own: `createC0Controller({ config, outbox })` takes an
  already-parsed `C0Config` and a `C0OutboxSink` (`{ append }` — the store's own method), so a
  controller cannot exist without an explicit, already-gated config. Construction with a missing
  config or outbox fails loudly with `c0_controller_invalid_config` / `c0_controller_invalid_outbox`.
- **Every path returns a typed result; nothing throws at the caller.** `C0InertResult`
  (`status: 'inert'`) or `C0EnqueuedResult` (`status: 'enqueued' | 'duplicate'`). All three
  "nothing happened" flags ride on both variants: `performed: false`, `delivered: false`, and
  `enqueued: false | true`. Field sets are closed and exported (`C0_INERT_RESULT_FIELDS`,
  `C0_ENQUEUED_RESULT_FIELDS`) and asserted key-exact, so a test cannot pass after someone adds a
  delivery or action field.
- **Fail-closed precondition order** — the first failure decides the result and nothing after it
  runs: `disabled_flag_off` → `allowlist_empty` → `caller_missing` → `caller_not_allowlisted` →
  `correlation_missing` → `correlation_malformed` → `kind_not_accepted` → `record_not_redacted` →
  `payload_invalid`. A closed gate is settled before the correlation or the record is examined (the
  check proves it with a request that is wrong in all three families at once), and a gate refusal
  carries the gate decision; every other refusal carries `gate: null`. A store that refuses, throws,
  or returns nonsense is caught and reported as `outbox_rejected` — never rethrown, never read as a
  success, and its error text is deliberately **not** surfaced (an arbitrary message could carry
  caller text).
- **The correlation precondition** is the third gate: the correlation id must be present and match
  `^[A-Za-z0-9_-]{1,64}$` (the same shape the store already accepts as a call identity, so a valid
  correlation id can never be refused downstream), and the optional turn reference must match
  `^[A-Za-z0-9._:-]{1,64}$`. Missing ⇒ `correlation_missing`; malformed ⇒ `correlation_malformed`;
  neither the store nor any other dependency is touched.
- **The only write, and it is local.** `enqueue()` accepts a record the caller supplied locally and
  already redacted (`redacted: true`) and hands it to the injected outbox; the module never touches
  the filesystem itself. "Already redacted" is a **checked** precondition, not a promise: the payload
  is re-run through this repo's own `redactValue` and refused (`record_not_redacted`) if redaction
  would change a byte of it — so a phone-shaped or e-mail-shaped value cannot reach disk through
  this contract even though the record's author asserted it was clean.
- **Deterministic idempotency input.** The key is `c0.<kind>.<sha256(correlationId ␀ kind ␀
  turnRef)[0..24]>` — derived from the correlation identity only, never from payload text. The
  default turn reference is the fixed literal `'1'`, never a clock reading, so a replay (same
  process, or a fresh store over the same file after a restart) recomputes the identical key and the
  store returns the record it already holds: `status: 'duplicate'`, `created: false`, one durable
  line. `deriveTurnIdempotencyKey` is exported as the pure primitive and throws a typed code
  (`c0_invalid_correlation_id`, `c0_invalid_kind`, `c0_invalid_turn_ref`) when handed unvalidated
  input — `planC0Enqueue` validates first, and the check pins both halves.
- **The decision is pure.** `planC0Enqueue(config, request)` takes no store, reads no clock, performs
  no I/O and mutates nothing (proved against a frozen config, frozen payload and frozen request); it
  returns either an inert plan (`outcome`, `reason`, `gate`) or a ready plan carrying exactly the
  store inputs plus the outcome. The controller is that decision plus one guarded `append` call.

### 11.2 Transfer adapter — accepted contract

- **Inert unavailable by default, and no configuration can change that.** The only implementation is
  `createInertTransferAdapter(reason?)`, which validates the request and resolves
  `{ status: 'unavailable', attempted: false, available: false, reason }` — a closed field set
  (`TRANSFER_UNAVAILABLE_FIELDS`), asserted key-exact and phone-shape-free. No environment variable,
  no flag and no parameter produces an adapter that can place a call: an adapter capable of dialing
  does not exist at this stage, so "misconfigured into dialing" is not a reachable state, and the
  source is asserted to contain no `available: true`, no `attempted: true` and no phone-shaped
  literal.
- **A target is always a role.** `TransferTarget` is `'carter' | 'jaime'`, validated against a closed
  allow-list; `resolveTransferTarget` answers `null` for anything else — including a phone-shaped
  string, a number, and a near-miss with different casing or padding. No role contains a digit, no
  outcome and no plan field can hold a destination, and no export resolves one. The request carries
  `{ correlationId, target, kind, screening }` only: caller context (name, reason, callback) is
  deliberately **not** routed through this seam — the controller records that in the outbox under
  redaction, so a callback number has no path into a transfer contract at all.
- **A pure validated contract.** `validateTransferRequest` fails with a typed code on a non-object
  request, an unknown role, an unknown kind, an unknown screening, a malformed correlation id, or
  `screening: 'direct'` on a non-emergency (the production rule, kept as a one-directional
  constraint). An invalid request is *rejected* — it never becomes an outcome, because an
  unvalidatable request must not be reportable as a success. The failure vocabulary is closed too:
  `resolveTransferOutcome` maps anything unrecognized to `'failed'`, and `transferOutcomeSucceeded`
  is true for `'accepted'` and nothing else — `'unavailable'` is emphatically not a success.
- **Availability is a report, not a switch.** `transferAvailability(config, caller)` maps the local
  gate decision onto `c0_disabled` / `allowlist_empty` / `caller_not_admitted` / `not_configured`,
  and answers `available: false` on every path — the fully-open gate is exactly the case that reports
  `not_configured`, which is the point: open gates still leave nothing that can dial.
- **No policy in the adapter.** Target ordering, the fallback to the other person, the both-failed
  record and the give-up copy stay with the controller (§4.4); the adapter carries one request and
  reports one status.

### 11.3 §0 isolation, restated for these two files

Both modules are Node-builtins-only (`c0-controller.ts` imports `node:crypto`; `transfer-adapter.ts`
imports no builtin at all), import nothing but C0-local siblings, read no environment variable, read
no clock, print nothing, hold no socket, start no timer, spawn no process, and have no caller-facing
surface: they return values. There is no import edge in either direction across the production
boundary, and no fallback path: a C0 refusal is C0's own typed result and the caller must decline and
stop. The transfer contract cannot dial.

### 11.4 Verification observed, 2026-09-22 (this worktree, still no `node_modules`)

| Command | Result |
|---|---|
| `npx tsx src/agent/voice/c0-controller.check.ts` | `c0-controller.check OK`, exit 0 |
| `npx tsx src/agent/voice/transfer-adapter.check.ts` | `transfer-adapter.check OK`, exit 0 |
| `npx tsx src/agent/voice/c0-config.check.ts` | `c0-config.check OK`, exit 0 (invariant scan now covers the two new sources — §11.5) |
| `npx tsx src/agent/voice/outbox.check.ts` | `outbox.check OK (temp dir …, 10 records exercised)`, exit 0 |
| `npx tsx src/agent/voice/outbox-monitor.check.ts` | `outbox-monitor.check OK`, exit 0 |
| `tsc --noEmit --strict` over all ten `src/agent/voice/*.ts`, run read-only with the primary tree's compiler and `@types/node` | **exit 0, zero diagnostics** (no install, no dependency change; this is how the type layer was verified without adding a dependency to this worktree). It caught one real imprecision — the optional `target` in a ready plan was typed `string \| null \| undefined` — fixed at source before the final run. |
| §7 production regression gates — runnable subset | `office-hours.check OK`, `✓ ops alert self-check passed`, `✓ schedule-command self-check passed`, `contact-normalize.check OK` — all exit 0 |
| **Negative controls** (mutation probes, each reverted and byte-verified by `sha256sum -c`) | fail-open gate in the controller ⇒ controller check **fails**; a destination-resolving export + phone literal in the adapter ⇒ adapter check **fails**; a prohibited vendor token in the controller ⇒ controller check **and** the `c0-config.check.ts` invariant scan **fail**, and `rg` finds the token. The checks are not vacuous. |
| focused `rg` over non-check `src/agent/voice/*.ts` for `voice-server`, `conversationrelay`, `twilio`, `livekit`, `openai`, `housecall`, `proxmox`, `ct102`, `sqlite`, `axios`, `@mastra`, `node-fetch`, `zod`, `fetch(`, `node:http(s)`, `node:net`, `node:dns`, `WebSocket`, `child_process`, `spawnSync`, `spawn(`, `setInterval`, `setTimeout`, `listen(`, `process.exit`, `hcp`, `require(` | **no matches** (`rg` exit 1) across the five non-check sources — and the same scan, plus a phone-shaped-literal probe (`\+\d{7,}`, `\d{10,15}`), also returns no matches |
| every import specifier under `src/agent/voice/` | `node:*` or `./` (C0-local) only |
| `git status --porcelain` | `?? docs/2026-09-22-c0-voice-canary-seam-audit.md` + `?? src/agent/voice/` only; `git diff` empty — no tracked production file modified |
| repo default outbox | `data/voice-outbox.jsonl` does not exist after the run; both new checks work in a temp dir they remove |

`voice-server.twiml.test.ts` and a worktree-local `npx tsc --noEmit` remain unrunnable for §7's reason
(no `node_modules`); the type layer was instead verified read-only against the primary tree's compiler
(above), and neither is part of this stage's acceptance.

### 11.5 The one edit to an existing file

`src/agent/voice/c0-config.check.ts` §9 pinned the directory scan with
`assert.deepEqual(sources, ['c0-config.ts', 'outbox-monitor.ts', 'outbox.ts'])`, so adding any new
non-check source made the check abort **before** its per-file forbidden-token loop ran. The pinned
list now names all five sources (`c0-config.ts`, `c0-controller.ts`, `outbox-monitor.ts`, `outbox.ts`,
`transfer-adapter.ts`), which is the change that puts this stage's two files inside the §0 invariant
scan rather than outside it — verified by a mutation probe (§11.4). No assertion was weakened; the
list stays explicit so an unexpected future source still fails the check.

### 11.6 Production touchpoints after this stage: still zero

`ecosystem.config.cjs`, `.env.example`, `memory/HANDOFF.md`, `src/agent/voice-server.ts` and every
other production module are **untouched**, and no production module imports a C0 module — the only
edit anywhere is the pinned list in §11.5, inside `src/agent/voice/`. Nothing in this stage starts a
process, a timer or a listener, and nothing can deliver or dial. The disable lever is unchanged:
`VOICE_C0_ENABLED` unset or false ⇒ gate 1 closed ⇒ the controller returns an inert result, the
adapter reports `unavailable`, and the live line is byte-identical to today.

---

## 12. Stage 1 acceptance — entry/admission + block-content contracts (2026-09-22)

Accepted scope for this stage: the **entry/admission contract** and the **block-content contract** —
the pure halves of §3 seams 1 and 6, delivered as contracts with colocated focused checks. New files
only, plus the same pinned-list edit inside an existing check (§12.3). Explicitly NOT delivered:
`c0-entry.ts` ships no argv guard, no port, no socket and no listener — becoming a process is still a
later approved change — and block handling is content only: no parse/strip of model output, no
transport, no timer (that stays with §3 seams 5 and 6's deferred half).

| # | Delivered module | Colocated focused check | Command |
|---|---|---|---|
| 1 | `src/agent/voice/c0-entry.ts` — untrusted ingress admission, typed inert result | `src/agent/voice/c0-entry.check.ts` | `npx tsx src/agent/voice/c0-entry.check.ts` |
| 2 | `src/agent/voice/blocks.ts` — closed transition wording, key-addressed, audited | `src/agent/voice/blocks.check.ts` | `npx tsx src/agent/voice/blocks.check.ts` |

### 12.1 Entry / admission — accepted contract

- `admitC0Ingress(config, ingress)` is pure and takes its config already parsed (the guarded form is
  `createC0EntryContract(config)`, which refuses a missing config with `c0_entry_invalid_config`).
  It imports only local C0 interfaces: `./c0-config.js` (the two gates, the E.164 predicate),
  `./c0-controller.js` (the correlation and turn-reference predicates and the default turn
  reference — re-used, not duplicated, so an admitted handle cannot be shaped in a way the
  controller would refuse) and `./outbox.js` (the caller-masking primitive).
- **Fail-closed order, pinned by the check**: `ingress_not_an_object` → `ingress_unknown_field` →
  `ingress_incomplete` → `ingress_source_not_accepted` → `ingress_caller_malformed` →
  `ingress_correlation_malformed` → `ingress_turn_ref_malformed` → `ingress_utterance_invalid` →
  the gate (`disabled_flag_off` / `allowlist_empty` / `caller_not_allowlisted`).
- **Ingress cannot assert its own admissibility.** The field set is closed to `source`,
  `correlationId`, `callerE164`, `turnRef`, `utterance`: a self-declared enable flag, admission,
  redaction claim, gate result, decision, idempotency key or destination is not a field this shape
  has, so it refuses as `ingress_unknown_field` before anything else is considered. Only a plain
  object can be an ingress (a class instance, a date or a collection object is not a turn).
- **Nothing untrusted is used before it is validated** — the gate is the first *use*, so it runs
  last; the check pins this by showing a malformed ingress refused on its own ground even while the
  gate is disabled. (The controller settles its gate first because it is handed a locally built
  value; this module is the boundary. Documented, deliberate, and asserted.)
- **Refusals echo nothing.** A refusal carries a fixed reason code and, for gate refusals, the gate
  decision — never the offending key or value, so an untrusted string cannot ride out inside it.
- **The admitted handle is masked.** It carries the masked caller reference, the correlation id, the
  source, the turn reference and the transcript — never the raw number the gate consumed. The
  transcript is carried verbatim, bounded (`MAX_UTTERANCE_CHARS = 2_000`) and never interpreted:
  the check proves the transcript's *content* cannot move a decision field.
- Closed result field sets (`C0_ADMITTED_FIELDS` / `C0_ADMISSION_INERT_FIELDS`); `performed: false`
  and `delivered: false` on every result; the source, field, required-field and utterance-bound
  constants are frozen at runtime as well as at the type level.

### 12.2 Block content — accepted contract

- `C0_BLOCK_KEYS` is the closed inventory of eight reviewed transitions (`opening`, `after_hours`,
  `transfer_connecting`, `transfer_unavailable`, `booking_recorded`, `message_recorded`,
  `reschedule_recorded`, `closing`); `C0_BLOCK_WORDING` is the frozen table of static lines, and
  both are frozen at runtime so the inventory cannot grow.
- `renderC0Block(key)` takes **one parameter** (asserted by arity) and returns either the reviewed
  literal for that key or a typed `block_not_reviewed` refusal — never a fallback line, never an
  empty or generated one. With no second parameter there is nowhere to pass a transcript, a caller
  name, a slot, a destination or a model completion, and the module contains no interpolation,
  template slot, `eval`, `new Function` or dynamic import.
- **No model, no tool, no side effect**: the module imports only the local redaction primitive, and
  asserts at check time that it references no builtin module, no clock, no environment, no printing
  and no asynchrony. Everything is synchronous and returns a value; nothing is delivered.
- **The audit is the review gate.** `auditC0Wording(table, { denyTokens })` enforces a reviewed key,
  a non-empty static string, bounded length, no surrounding space, printable ASCII with no control
  characters, no run of spaces, sentence case, terminal punctuation, no interpolation marker and no
  phone-shaped or e-mail-shaped text (judged with this repo's own redaction primitive). The shipped
  table audits clean; each rule rejects its own dirty fixture in the check, so the rules are not
  vacuous. Prohibited product tokens are supplied as an ARGUMENT by the check — naming them inside
  the module would put them in a Stage 1 source the isolation scan requires to be free of them.
- Every rendered line is additionally asserted to exist in the reviewed source as a single-quoted
  literal, to be digit-free and unique, and to appear in no other C0 module (the entry contract
  carries no caller-facing wording at all). The inventory covers the controller's whole decision
  vocabulary: every accepted kind has a reviewed transition.

### 12.3 The one edit to an existing file

`src/agent/voice/c0-config.check.ts` §9's pinned directory listing named five sources and, as
recorded in §11.5, it aborts **before** its per-file forbidden-token loop if the directory grows. It
now names all seven (`blocks.ts`, `c0-config.ts`, `c0-controller.ts`, `c0-entry.ts`,
`outbox-monitor.ts`, `outbox.ts`, `transfer-adapter.ts`), which is what places this stage's two files
inside the §0 invariant scan. No assertion was weakened.

### 12.4 Verification observed, 2026-09-22 (this worktree, still no `node_modules`)

| Command | Result |
|---|---|
| `npx tsx src/agent/voice/c0-entry.check.ts` | `c0-entry.check OK`, exit 0 |
| `npx tsx src/agent/voice/blocks.check.ts` | `blocks.check OK`, exit 0 |
| the five earlier C0 checks (config, controller, outbox, outbox-monitor, transfer-adapter) | all exit 0 — no regression |
| `tsc --noEmit --strict` over all fourteen `src/agent/voice/*.ts`, run read-only with the primary tree's compiler and `@types/node` | **exit 0, zero diagnostics** (no install, no dependency change) |
| §7 production regression gates — runnable subset | `office-hours.check OK`, `✓ ops alert self-check passed`, `✓ schedule-command self-check passed`, `contact-normalize.check OK` — all exit 0 |
| **Negative controls** (five mutation probes, each reverted and byte-verified by `sha256sum -c`) | disabling the unknown-field guard, returning the raw caller instead of the mask, treating blank as present, putting contact detail into a reviewed line, and deleting a reviewed key each make the relevant check **fail**. The checks are not vacuous. |
| focused `rg` over the seven non-check `src/agent/voice/*.ts` for the prohibited-token list (`voice-server`, `conversationrelay`, `twilio`, `livekit`, `openai`, `housecall`, `hcp`, `proxmox`, `ct102`, `sqlite`, `axios`, `@mastra`, `node-fetch`, `zod`, `fetch(`, `node:http(s)`, `node:net`, `node:dns`, `WebSocket`, `child_process`, `spawnSync`, `spawn(`, `setInterval`, `setTimeout`, `listen(`, `process.exit`, `require(`), plus phone-shaped literals | **no matches** (`rg` exit 1) |
| the same probe group scoped to this stage's two files (`\+\d{7,}`, `\d{10,15}`, `${`, `process.`, `eval(`, `new Function`, `node:`, `async`, `Promise`) | **no matches** — neither new module references a builtin module, a slot, an environment read, a clock or asynchrony |
| imported specifiers per non-check source | `node:*` or `./` (C0-local) only; `blocks.ts` has no builtin import at all |
| `git status --porcelain` | `?? docs/2026-09-22-c0-voice-canary-seam-audit.md` + `?? src/agent/voice/` only; `git diff` empty — no tracked production file modified |

### 12.5 Production touchpoints after this stage: still zero

`ecosystem.config.cjs`, `.env.example`, `memory/HANDOFF.md`, `src/agent/voice-server.ts` and every
other production module are untouched, and no production module imports a C0 module — the only edit
anywhere is the pinned list in §12.3, inside `src/agent/voice/`. Nothing in this stage listens,
starts, schedules, dials, delivers or reads a credential. The disable lever is unchanged:
`VOICE_C0_ENABLED` unset or false ⇒ admission returns an inert result for every inbound turn and the
live line behaves exactly as it does today.

---

## 13. Stage 1 acceptance — transport contract (2026-09-22)

Accepted scope: the pure, disabled-by-default **transport lifecycle contract** — the inert half of §3
seam 5 — as new files only, plus the same pinned-list edit inside an existing check (§13.3). NOT
delivered, by design: no adapter, no socket, no port, no room, no media path, no provider call, no
endpoint, no credential, no timer, no process and no deployment. A plan is data that a future
approved adapter would read; nothing in this stage can act on it.

| # | Delivered module | Colocated focused check | Command |
|---|---|---|---|
| 1 | `src/agent/voice/transport.ts` — admitted-turn transport planning, inert by construction | `src/agent/voice/transport.check.ts` | `npx tsx src/agent/voice/transport.check.ts` |

### 13.1 Accepted contract

- `planC0Transport(config, handle)` is pure and composes only local C0 interfaces: `./c0-entry.js`
  (the admitted handle, its closed field set, its source and transcript vocabulary),
  `./c0-config.js` (the config contract and the E.164 predicate) and `./c0-controller.js` (the
  correlation and turn-reference predicates). It deliberately does **not** import the content
  contract — a transport never chooses what a caller hears, so it holds no wording at all. The
  guarded form `createC0TransportContract(config)` refuses a missing config with
  `c0_transport_invalid_config`.
- **Refusals, input before state**: `transport_ingress_not_admitted` (not even claiming admission —
  including an admission *refusal* or a plan passed back in), `transport_ingress_handle_invalid`
  (claims admission but fails re-verification: exact field set, the open gate, `performed` /
  `delivered` false, a **masked** caller reference — a raw number is refused — controller-legal
  correlation and turn reference, a locally known source, a bounded transcript), then
  `transport_disabled` (flag off) and `transport_allowlist_empty` (flag on, nothing admitted). A
  value that is not an admitted handle is not a transport input, so the environment question never
  arises; the check pins that order.
- **A plan is data and nothing else**: `performed`, `delivered`, `connected`, `dispatched` and
  `callerVisible` are all false, the phase is `ready`, and it carries the opaque correlation id, the
  source, the turn reference, the masked caller reference and the transcript **length** — never the
  transcript. There is therefore no field in this contract in which caller text, a destination, an
  endpoint, a room or a media path could travel, and the check asserts the serialized plan names no
  endpoint and no connection.
- **The lifecycle is modelled, not exercised**: `admitted -> ready -> connecting -> active -> ended`,
  frozen; `canEnterC0Phase` is true only for the two inert phases, so nothing reaching this contract
  can enter one that would need a transport (the plan's own next step, `connecting`, is refused);
  `nextC0Phase` is pure order data; `transportCapability()` states in one place that connecting,
  carrying media and reaching a caller are all false, with reason `not_implemented_at_this_stage`.
- Closed field sets for both result variants (`C0_TRANSPORT_PLAN_FIELDS` /
  `C0_TRANSPORT_INERT_FIELDS`), each asserted key-exact, and neither variant can report an action.

### 13.2 Verification observed, 2026-09-22 (this worktree, still no `node_modules`)

| Command | Result |
|---|---|
| `npx tsx src/agent/voice/transport.check.ts` | `transport.check OK`, exit 0 |
| all eight C0 checks (blocks, config, controller, entry, outbox, outbox-monitor, transfer-adapter, transport) | all exit 0 — no regression |
| `tsc --noEmit --strict` over all sixteen `src/agent/voice/*.ts`, read-only with the primary tree's compiler and `@types/node` | **exit 0, zero diagnostics** (no install, no dependency change) |
| §7 production regression gates — runnable subset | `office-hours.check OK`, `✓ ops alert self-check passed`, `✓ schedule-command self-check passed`, `contact-normalize.check OK` — all exit 0 |
| **Negative controls** (three mutation probes, each reverted and byte-verified by `sha256sum -c`) | making the disabled state fail open, neutering the handle field-set verification, and making the capability claim a connection each make the transport check **fail**. The check is not vacuous. |
| focused `rg` over the eight non-check `src/agent/voice/*.ts` for the prohibited-token list (…, `voice-server`, `conversationrelay`, `twilio`, `livekit`, `openai`, `housecall`, `hcp`, `proxmox`, `ct102`, `sqlite`, …, `process.exit`, `require(`), endpoint literals (`ws(s)://`, `http(s)://`) and phone-shaped literals | **no matches** (`rg` exit 1) |
| imported specifiers per non-check source | `node:*` or `./` (C0-local) only; `transport.ts` imports exactly `./c0-config.js`, `./c0-controller.js`, `./c0-entry.js` and no builtin module |
| `git status --porcelain` | `?? docs/2026-09-22-c0-voice-canary-seam-audit.md` + `?? src/agent/voice/` only; `git diff` empty — no tracked production file modified |

### 13.3 The one edit to an existing file

`src/agent/voice/c0-config.check.ts` §9's pinned directory listing now names all eight sources (it
gains `transport.ts`), which is what places this stage's file inside the §0 invariant scan before
that scan's per-file token loop runs. No assertion was weakened.

### 13.4 Production touchpoints after this stage: still zero

`ecosystem.config.cjs`, `.env.example`, `memory/HANDOFF.md`, `src/agent/voice-server.ts` and every
other production module are untouched, no production module imports a C0 module, no dependency was
added and nothing was committed or deployed. Nothing in this stage listens, connects, joins,
dispatches media, reads a credential or reaches a caller. The disable lever is unchanged:
`VOICE_C0_ENABLED` unset or false ⇒ admission is inert for every inbound turn, the transport plans
nothing, and the live line behaves exactly as it does today.

---

## 14. Defect fix — embedded 10–15 digit runs in C0 outbox redaction (2026-09-22)

**Defect (independently reviewed).** `redactString` masked a value only when the WHOLE string was
phone-shaped (`looksLikePhone`) or when its digits arrived as a separated 3-3-4 group
(`INLINE_PHONE_RE`). A standalone 10–15 digit run embedded in free-form text — a note, a follow-up
sentence or an error string carrying a bare number with no separators — matched neither, so it
reached the durable operator surface (`snapshot()`) intact. `isAlreadyRedacted` in
`c0-controller.ts` is built on the same primitive, so the controller would also have accepted a
record falsely marked `redacted: true` that carried such a run, and would have written it to disk.

**Fix.** `src/agent/voice/outbox.ts` gains

```ts
const EMBEDDED_LONG_DIGITS_RE = /(?<!\d)\d{10,15}(?!\d)/g;
```

applied as a second pass (after the grouped pass) inside `redactString`. Consequences, all
deliberate and pinned below:

- A standalone run of 10–15 digits is masked **wherever it sits** in free-form text, digits glued to
  a word included (`order5551230101confirmed` → `order555****0101confirmed`).
- **Timestamp behaviour is unchanged**, for the same reason the grouped pattern is timestamp-safe: an
  ISO-8601 stamp separates its digit groups with `-`, `:` and `T`, so none of its runs is ever 10
  digits long. A date-only value is likewise untouched. (A bare 13-digit epoch-ms *string* was
  already masked before this change by `looksLikePhone`, and a phone-shaped *number* by
  `isPhoneShapedNumber` — neither path moved.)
- A run of 9 or fewer digits is untouched (below the range), and a run of 16 or more is left whole
  rather than partially masked: it is outside the E.164 range and cannot be a phone number.
- Both passes are idempotent — a masked value carries neither a grouped 3-3-4 shape nor a 10–15 digit
  run — so re-redacting an already masked string changes nothing.

**Fixtures added (focused; both cases the review asked for).**

- `src/agent/voice/outbox.check.ts` §9 — the seeded record's payload gains a free-form `followUp`
  phrase carrying a bare 10-digit run with no separators. The check now asserts that the run is
  **absent from the serialized durable snapshot**, that the snapshot carries **its masked form**, and
  that the phrase keeps its words and loses only the digits. The pre-existing assertions that an
  ISO-8601 stamp survives intact in both the record and the error string are unchanged and still pass.
- `src/agent/voice/c0-controller.check.ts` §9 — the dirty-payload set gains the same embedded-run
  phrase; the check asserts `isAlreadyRedacted` reports it dirty, that the controller refuses it as
  `record_not_redacted`, and that the raw run never reaches the durable file.

**Red-before-green (the fixtures pin the defect, not merely the fix).** With both fixture sets in
place and the module still unfixed: `npx tsx src/agent/voice/outbox.check.ts` failed with
`AssertionError: a standalone 10-digit run embedded in a phrase is masked in the snapshot`, and
`npx tsx src/agent/voice/c0-controller.check.ts` failed with
`AssertionError: {"followUp":"called back about 5551230101 but no answer"} is dirty`. After the fix,
both pass.

### 14.1 Verification observed, 2026-09-22

| Command | Result |
|---|---|
| `npx tsx src/agent/voice/outbox.check.ts` (pre-fix / post-fix) | **failed** on the new embedded-run fixture / `outbox.check OK (…, 10 records exercised)`, exit 0 |
| `npx tsx src/agent/voice/c0-controller.check.ts` (pre-fix / post-fix) | **failed** on the new dirty-payload fixture / `c0-controller.check OK`, exit 0 |
| `npx tsx src/agent/voice/blocks.check.ts` (second consumer of `redactValue`) | `blocks.check OK`, exit 0 |
| all eight C0 check files (blocks, config, controller, entry, outbox, outbox-monitor, transfer-adapter, transport) | all exit 0 — no regression |
| `tsc --noEmit --strict` over all `src/agent/voice/*.ts`, read-only with the primary tree's compiler and `@types/node` | **exit 0, zero diagnostics** |
| source isolation scan over the non-check C0 sources (prohibited tokens, `fetch(`, `node:http(s)/net/dns`, `WebSocket`, subprocess/timer/process shapes, `require(`, endpoint literals `ws(s)://`/`http(s)://`, phone-shaped literals) | **no matches** (`rg` exit 1) |
| `git status --porcelain` / `git diff` | `?? docs/…audit.md` + `?? src/agent/voice/` only / empty — no tracked production file modified |

Boundary probe (scratch script outside the repo, run read-only and deleted afterwards) — every case
idempotent under a second pass:

| Input | Redacted output |
|---|---|
| `called back about 5551230101 but no answer` | `called back about 555****0101 but no answer` |
| `reach me on 15551230099 after six` | `reach me on 155****0099 after six` |
| `reference 155512300991234 on file` | `reference 155****1234 on file` |
| `order5551230101confirmed` | `order555****0101confirmed` |
| `ring +1 555-123-4567 before dispatch` | `ring +155****4567 before dispatch` (unchanged behaviour) |
| `2026-09-22T15:03:00.000Z` | **unchanged** — timestamp preserved |
| `2026-09-22T10:03:00-05:00` | **unchanged** — timestamp preserved |
| `2026-09-22` | **unchanged** |
| `order 555123010 shipped` (9 digits) | **unchanged** — below the range |
| `reference 1555123009912345 filed` (16 digits) | **unchanged** — above the range, and not partially masked |

### 14.2 Scope of this fix

Four files were changed, exactly the four named in the review: `src/agent/voice/outbox.ts` (the
fix), `src/agent/voice/outbox.check.ts` and `src/agent/voice/c0-controller.check.ts` (the fixtures)
and this audit. File modification times confirm no other file in `src/agent/voice/` was touched, and
`git status` shows no tracked file modified. Nothing was installed, staged, committed or pushed; no
credential, `.env`, provider, infrastructure or phone-route access was made; and no external call
was issued — the one probe script lived outside the repo and was deleted after use.
