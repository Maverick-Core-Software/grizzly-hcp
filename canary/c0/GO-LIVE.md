# C0 canary go-live runbook

Run every command from the worktree root. This is an operator runbook, not authorization: any `--apply`, purchase, deployment, number routing, PM2 lifecycle action, or enable step needs Carter's explicit approval at that point. Never print, copy, or inspect values in `canary/c0/.env.c0`; commands write only redacted evidence under `canary/c0/provision/evidence/`.

## Guardrails

- The canary DID is a Twilio **subaccount** resource. It must have no `TrunkSid` and no `VoiceApplicationSid`; only its `VoiceUrl` changes.
- Before ingress is enabled, route the canary DID to the reviewed Function `/fallback`, which always reaches office, backup, or voicemail. Production numbers, Functions, PM2 applications, HCP, and ConversationRelay are out of scope.
- Stop immediately on a failed preflight, any unsafe-number finding, a production-guard hash change, a command failure, or evidence that a caller can be left without a human/voicemail route. Do not continue by retrying a mutation.

## Ordered activation

Each provisioning command writes its redacted result to `canary/c0/provision/evidence/<UTC-stamp>-<script-name>.json`; the table's evidence names therefore identify the exact filename suffix to retain.

| # | Action and command | Required preflight | Expected evidence/output | Stop condition |
|---|---|---|---|---|
| 0 | Confirm all canonical C0 names are supplied and the local file is ignored: `npx tsx canary/c0/provision/preflight.ts --stage enable` | `enable` | Redacted `preflight` evidence shows `pass:true`, no missing/invalid names, and `envGitIgnored:true`. | Any missing/invalid name or file not ignored. |
| 1 | Inventory only the subaccount: `npx tsx canary/c0/provision/twilio-inventory.ts` | `inventory` | `twilio-inventory` evidence identifies the subaccount and lists masked numbers/services; `unsafe_numbers` must be empty for the intended DID. | Wrong account, a trunk/app-attached intended number, or unredacted output. |
| 2 | Prove the subaccount cannot use parent authority: `npx tsx canary/c0/provision/twilio-negative-authority.ts --parent-sid <CARTER_PARENT_ACCOUNT_SID>` | `inventory` | `twilio-negative-authority` evidence prints only `pass:true`; it records denied parent account/number reads and a successful own-account control. | `pass:false`, any successful parent read, or state change. |
| 3 | Capture the parent-account production guard before any canary mutation: set `C0_OPERATOR_PARENT_ACCOUNT_SID` and `C0_OPERATOR_PARENT_AUTH_TOKEN` only in this command's environment, then run `npx tsx canary/c0/provision/snapshot-production-guard.ts`. | `inventory` | `snapshot-production-guard` evidence lists every parent number by masked SID and a SHA-256 of its voice/SMS routing fields. Record this evidence path for step 15. | Missing explicitly supplied parent credentials, guard capture failure, or any attempt to use canary `.env.c0`. |
| 4 | Either select an existing subaccount number with `npx tsx canary/c0/provision/select-canary-number.ts --apply --did <CARTER_APPROVED_E164> [--production-sid <CARTER_PRODUCTION_NUMBER_SID>]`, or—only after Carter explicitly confirms purchasing this exact DID—run `npx tsx canary/c0/provision/twilio-buy-number.ts --apply --confirm-purchase <CARTER_APPROVED_E164>`. Both write `VOICE_C0_CANARY_DID` and `VOICE_C0_CANARY_NUMBER_SID`. | `inventory` | `select-canary-number` or `twilio-buy-number` evidence is redacted and reports the masked DID/SID and named writes. | Purchase flag/confirmation absent, number is not in the subaccount, it is trunk/app attached, or it matches the optional production SID guard. |
| 5 | Create or reuse isolated Sync: `npx tsx canary/c0/provision/twilio-sync.ts --apply` | `inventory` | `twilio-sync` evidence reports created/reused `grizzly-c0-canary`; `.env.c0` receives `VOICE_C0_SYNC_SERVICE_SID` without printing it. | Sync provisioning/evidence failure. |
| 6 | Create runtime key material: `npx tsx canary/c0/provision/twilio-restricted-keys.ts --apply` | `inventory` | `twilio-restricted-keys` evidence records a masked key ID and its documented standard-key Sync fallback deviation; `.env.c0` receives key SID/secret. | Key creation fails or its deviation has not been accepted by Carter. |
| 7 | Generate SIP credentials: `npx tsx canary/c0/provision/generate-sip-credentials.ts --apply` | `functions` | `generate-sip-credentials` evidence lists generated names only; values are atomically written into `.env.c0`. | Credential generation fails or output exposes a value. |
| 8 | Deploy the isolated Twilio Function service: `npx tsx canary/c0/provision/deploy-functions.ts --apply` | `functions` | `deploy-functions` evidence shows redacted service/environment IDs; it writes `VOICE_C0_INGRESS_URL` and `VOICE_C0_FALLBACK_URL`. | Deployment fails, URLs are absent, or Function evidence is not redacted. |
| 9 | Establish humans-first routing: `npx tsx canary/c0/provision/twilio-number-route.ts --apply --to fallback` | `functions` | `twilio-number-route` evidence has before/after snapshots and proves **only** `voice_url` changed; a staff call reaches the fallback screen. | Any field other than `voice_url` changes, or fallback cannot reach office/backup/voicemail. |
| 10 | Reconcile isolated LiveKit trunk and explicit dispatch rule: `npx tsx canary/c0/provision/livekit-sip.ts --apply` | `livekit` | `livekit-sip` evidence shows the named trunk/rule, explicit trunk ID, caller allowlist, 15-second ringing timeout, 480-second cap, and agent name; it writes `VOICE_C0_LIVEKIT_TRUNK_ID` and `VOICE_C0_LIVEKIT_RULE_ID`. | Empty/wildcard trunk IDs, wrong DID/allowlist, or missing IDs. |
| 11 | In each package only, install the locked exact dependencies and run its checks: `Push-Location canary/c0/agent; npm install; npm run check; npm run typecheck; Pop-Location`; repeat for `detector` and `monitor`; then `Push-Location canary/c0/twilio-functions; npm install; npm run check; Pop-Location`; and `Push-Location canary/c0/provision; npm install; npx tsc --noEmit; Pop-Location`. | `agent` | Each package produces its passing check/typecheck output. | Any install changes a pin, any check fails, or the agent rewire remains incomplete. |
| 12 | Start only the three canary processes: `pwsh -NoProfile -File canary/c0/c0ctl.ps1 start all`; verify with `pwsh -NoProfile -File canary/c0/c0ctl.ps1 status all`. `c0-agent` runs the package `tsx` CLI with `canary/c0/agent/src/main.ts start` and a worktree-root cwd. | `agent` | Launcher status reports only `agent`, `detector`, and `monitor` as running with C0-owned PID files. If startup reports a redacted `c0_env_inherited_conflict_<KEY>`, unset that inherited `VOICE_C0_*` (or `VOICE_OUTBOX_PATH`) value in the launcher/shell environment; do not copy or compare secret values manually. | Any non-C0 process target, a C0 app not running, or the inherited-conflict error remains after the inherited variable is removed. |
| 13 | After Carter authorizes the enabled transition, run `npx tsx canary/c0/provision/set-enabled.ts --apply --value true`; it prints but does not restart the agent, so run `pwsh -NoProfile -File canary/c0/c0ctl.ps1 restart agent` separately. | `agent` | Redacted `set-enabled` evidence has before/after/at and named write only; fresh `preflight --stage agent` evidence passes and launcher status shows only `agent` restarted. | Enabled writer fails, any key other than `VOICE_C0_ENABLED` changes, or a non-C0 process is targeted. |
| 14 | Enable ingress: `npx tsx canary/c0/provision/twilio-number-route.ts --apply --to ingress` | `enable` | `twilio-number-route` evidence again proves only `voice_url` changed, now to the stored ingress URL. | Route assertion fails or any output indicates a non-canary target. |
| 15 | Re-run `npx tsx canary/c0/provision/snapshot-production-guard.ts --compare <STEP_3_EVIDENCE_PATH>` with the same explicitly supplied `C0_OPERATOR_PARENT_ACCOUNT_SID` and `C0_OPERATOR_PARENT_AUTH_TOKEN`. | `enable` | A second `snapshot-production-guard` evidence reports `comparison.pass:true` with no changed parent-number hashes. If equal, status is **READY FOR REHEARSAL**, not general availability. | Any change (the command exits non-zero); immediately use the kill switch and investigate without further activation. |

## Kill switch and rollback

**Kill switch (expected effect: new calls use humans within 60 seconds):** `npx tsx canary/c0/provision/twilio-number-route.ts --apply --to fallback`, then `pwsh -NoProfile -File canary/c0/c0ctl.ps1 stop all` to halt the local C0 processes. Confirm the route evidence says only `voice_url` changed, then place a new staff call and verify the fallback screen. This does not change a production number.

**Full rollback:** (1) execute the kill switch; (2) `pwsh -NoProfile -File canary/c0/c0ctl.ps1 stop all`; (3) preserve the C0 evidence, logs, outbox, and marker files for review; (4) leave the deployed Functions service, Sync documents, LiveKit trunk/rule, and subaccount number inert on `/fallback`. Do not delete cloud objects or restore ingress without a new explicit approval and rehearsal.

## Created state and credential inventory

| Item | Creator/location | Purpose and handling |
|---|---|---|
| `canary/c0/.env.c0` | Carter plus provisioning writers | Git-ignored C0-only configuration; never display/read it manually. |
| Subaccount number and `VOICE_C0_CANARY_NUMBER_SID` | `select-canary-number.ts` or `twilio-buy-number.ts` | Canary DID only; remains trunk- and application-free. |
| `VOICE_C0_SYNC_SERVICE_SID` | `twilio-sync.ts` / Twilio Sync service | Lease and transfer-intent documents. |
| `VOICE_C0_TWILIO_API_KEY_SID/SECRET` | `twilio-restricted-keys.ts` / Twilio subaccount | Runtime Calls and Sync access; current documented implementation records a standard-key fallback deviation. |
| `VOICE_C0_SIP_USERNAME/PASSWORD` | `generate-sip-credentials.ts` | Function-to-LiveKit inbound SIP authentication. |
| Twilio Functions service/environment plus ingress/fallback URLs | `deploy-functions.ts` / Twilio Serverless | Protected C0 call control; URL names are written to `.env.c0`. |
| `VOICE_C0_LIVEKIT_TRUNK_ID/RULE_ID` | `livekit-sip.ts` / dedicated LiveKit project | Explicit inbound trunk and dispatch rule. |
| `canary/c0/provision/evidence/*.json` | Every provisioning script | Redacted audit evidence; preserve for review. |
| `data/c0/answered`, `first-audio`, `redirected`, `voice-outbox.jsonl` | C0 processes | Local durable marker/outbox state; preserve, never replay during rollback. |
| `canary/c0/*/node_modules` and PM2 records `c0-*` | Step 11/12 | Pinned runtime dependencies and isolated process records. |

## TBD list

- No agent-owned TBD remains. The C0 agent starts from `canary/c0/agent/src/main.ts`, parses only `canary/c0/.env.c0`, and refuses a conflicting inherited C0/outbox environment value without printing it.
