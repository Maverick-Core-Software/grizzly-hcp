VERDICT: REJECT

## Findings

### BLOCKER — inherited credentials can replace the canary-file credentials

**File:** `canary/c0/provision/lib.ts:17-20`

`loadC0Env` calls `dotenv.config` with `override: false` and then returns the complete inherited `process.env`. If a terminal or PM2 environment already contains `VOICE_C0_TWILIO_ACCOUNT_SID` and `VOICE_C0_TWILIO_AUTH_TOKEN` for a parent account, those inherited values win over `canary/c0/.env.c0`; an explicitly applied purchase, Function deployment, Sync creation, key creation, or number-route command can then use the parent credentials. This violates the C0-only/no-production boundary. Parse only `canary/c0/.env.c0` into a new allowlisted `VOICE_C0_*` map (or at minimum make the file authoritative and reject any inherited C0 credentials), and add a check with conflicting inherited and file values proving the file values alone are used.

### BLOCKER — first-time LiveKit trunk provisioning passes the wrong ringing-timeout type

**Files:** `canary/c0/provision/livekit-sip.ts:24,49`; installed `livekit-server-sdk@2.19.1` `dist/SipClient.d.ts:46-48` and `dist/SipClient.js:115-131`

For a new trunk, line 49 passes `trunkSpec` to `createSipInboundTrunk`. `trunkSpec.ringingTimeout` is a protobuf-shaped object (`{ seconds: 15n, nanos: 0 }`), but SDK 2.19.1's create option requires a numeric seconds value and constructs `BigInt(opts.ringingTimeout)` itself. On a new C0 project this throws before creating the inbound trunk, so the required DID/authentication/allow-list/dispatch setup cannot be provisioned. Pass `ringingTimeout: 15` to the create call (while retaining the protobuf duration for the subsequent full `updateSipInboundTrunk` replacement), and add a fake that asserts the create call receives a number and a new-trunk reconciliation completes.

### MAJOR — purchase confirmation is not validated against the purchased number

**File:** `canary/c0/provision/twilio-buy-number.ts:8-13`

The command requires `--confirm-purchase <E164>` and checks the availability response, but it writes `purchased.phoneNumber` without checking that Twilio's create response equals the confirmed E.164 value. A provider/client mismatch would atomically install an unintended DID and its SID into the C0 environment despite the confirmation guard. Immediately reject when `purchased.phoneNumber !== e164` before writing, and add a fake create response with a different number that asserts no environment write occurs.

### MAJOR — the negative-authority result treats arbitrary request failures as proven denial

**File:** `canary/c0/provision/twilio-negative-authority.ts:7-14`

`denied` returns true for every rejected parent request, without extracting and validating an HTTP status. A transport error, malformed fake, SDK regression, or any other client-side rejection can therefore make both parent probes appear denied while the positive control succeeds; the output would report a passing authority boundary without the required proof of a non-2xx parent response. Capture each parent response/status (or the Twilio error's numeric HTTP status), require a status outside 200–299 for both, retain the successful subaccount list as the positive control, and add a check covering a generic rejection versus an actual 401/403 response.

### MAJOR — enable preflight can pass without the number SID required by the kill switch

**Files:** `canary/c0/provision/lib.ts:54-59`; `canary/c0/provision/preflight.ts:15,61-71`; `canary/c0/provision/twilio-number-route.ts:26-30`

Applied selection/purchase writes `VOICE_C0_CANARY_NUMBER_SID`, and the kill-switch/route command requires it, but it is absent from `CANONICAL_C0_ENV` and thus from the `enable` preflight gate. A run can report enable-ready with only a DID configured; when the agent is unavailable and the operator needs the number redirected to fallback, the route command instead fails on missing configuration. Add the SID to the canonical list, validate its `PN` shape, require it for the enable stage, document it in the canary environment template, and add a preflight regression asserting that `enable` fails when it is absent.

## Confirmed controls

- The reviewed mutating entry points default to dry-run and gate their writes/API mutations behind `--apply`; purchase also requires `--confirm-purchase`, subject to the returned-number validation defect above.
- `twilio-number-route.ts` fetches the selected subaccount number, rejects a DID mismatch plus trunk/application attachment, requires the existing voice method to be `POST`, submits only `voiceUrl`/`voiceMethod`, and rejects an after-snapshot where any SMS or other route field changes. It has no LiveKit or agent dependency, so the fallback route remains an independent kill switch once the credential boundary is corrected.
- The function deployer targets only `grizzly-c0-canary`, maps all names consumed by `canary/c0/twilio-functions/functions/*.js`, and atomically writes the resulting ingress/fallback URLs. The installed `@twilio-labs/serverless-api@5.7.0` implementation uses its explicit `env` object for deployment; its `envPath` option is not consumed by `deployLocalProject`, so this call does not add the entire C0 file to Function variables.
- The Standard-key deviation is explicitly documented and the creation call is scoped through `accounts(VOICE_C0_TWILIO_ACCOUNT_SID)`, so the intended account is the configured subaccount; the inherited-credential defect above must be fixed before that scope can be trusted.
- The LiveKit desired specs contain the DID-only trunk number, SIP auth values, caller allow-list, `X-C0-Call` attribute mapping, 15-second ringing timeout, 480-second maximum duration, configurable non-deprecated media encryption, explicit non-empty dispatch trunk IDs, and name-based update-or-create reconciliation. `canary/c0/twilio-functions/deploy.md` supports the default `SIP_MEDIA_ENCRYPT_ALLOW` choice.
- `upsertC0EnvAtomically` writes a fully written temporary file then renames it, replacing only named C0 lines; `canary/c0/.gitignore` ignores `.env.c0`.
- `select-canary-number.ts` and `set-enabled.ts` were present during review and were included in the command run below.

## Verification performed

- `Push-Location canary/c0/provision; npx tsc --noEmit; Pop-Location` — **PASS** (zero diagnostics).
- `Push-Location canary/c0/provision; Get-ChildItem -File -Filter '*.check.ts' | Sort-Object Name | ForEach-Object { npx tsx $_.Name }; Pop-Location` — **PASS**: `deploy-functions.check OK`, `generate-sip-credentials.check OK`, `preflight.check OK`, `provision.check OK`, `select-canary-number.check OK`, `set-enabled.check OK`, and `twilio-sync.check OK`.
- Read-only inspection covered every provision TypeScript entry point/check, `canary/c0/twilio-functions/functions/*.js`, the binding decisions, readiness plan, seam-audit §0, `twilio-functions/deploy.md`, and the installed Twilio/LiveKit SDK sources. No `.env*` file was opened and no provider-account request was made.

## Fix response

All five reported findings are resolved in the reviewed package. `loadC0Env` now parses only `canary/c0/.env.c0` into an isolated `VOICE_C0_*`/`VOICE_OUTBOX_*` object and refuses any conflicting inherited key by name without exposing a value; the new check proves both file-only configuration and conflict refusal. New-trunk LiveKit reconciliation now gives SDK 2.19.1 numeric `ringingTimeout: 15` create options, omits unsupported create-time `maxCallDuration`, and retains the protobuf duration in the full replacement; the fake asserts those shapes and completes reconciliation.

The purchase path now rejects a returned number that differs from `--confirm-purchase` before any environment write, and its fake proves the write is absent. Negative-authority evaluation now accepts only observed non-2xx statuses (including a Twilio-style `status` error), treats generic transport errors as inconclusive, and retains the subaccount positive control; its dedicated check covers 401, 403, 404, generic failure, and RestException-shaped failure. `VOICE_C0_CANARY_NUMBER_SID` is now canonical, validates mixed-case `PN` SIDs, is required for `functions` and `enable` preflight, appears immediately after the DID in the names-only template, and has a missing-SID preflight regression.

Reverification after the fixes: `cd canary/c0/provision && npx tsc --noEmit` — **PASS**; then `npx tsx` for every `*.check.ts` — **PASS** (`deploy-functions`, `generate-sip-credentials`, `preflight`, `provision`, `select-canary-number`, `set-enabled`, `twilio-negative-authority`, and `twilio-sync`). No provider request was made.
