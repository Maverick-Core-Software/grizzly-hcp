# C0 provisioning commands

Run commands from the worktree root. They load only `canary/c0/.env.c0`, default to dry-run, write redacted evidence to `evidence/`, and require `--apply` before a cloud or local C0-environment mutation. Do not open, print, or hand-edit the environment file.

## Canary number selection

Select an existing number only from the configured C0 Twilio subaccount:

```powershell
npx tsx canary/c0/provision/select-canary-number.ts --did <E164> [--production-sid <SID>]
npx tsx canary/c0/provision/select-canary-number.ts --apply --did <E164> [--production-sid <SID>]
```

The command refuses missing, trunk-attached, application-attached, and optionally production-guarded numbers. Applied selection atomically replaces only `VOICE_C0_CANARY_DID` and `VOICE_C0_CANARY_NUMBER_SID` in the canary environment.

`twilio-buy-number.ts --apply --confirm-purchase <E164>` now writes those same two names after a successful subaccount purchase.

## Enabled state

```powershell
npx tsx canary/c0/provision/set-enabled.ts --value true
npx tsx canary/c0/provision/set-enabled.ts --apply --value true
```

Only `true` and `false` are accepted. Applied execution atomically replaces only `VOICE_C0_ENABLED`, emits redacted `{before, after, at}` evidence, and prints `pwsh -NoProfile -File canary/c0/c0ctl.ps1 restart agent`; it never invokes PM2.

## Local verification

```powershell
Push-Location canary/c0/provision
npx tsx select-canary-number.check.ts
npx tsx set-enabled.check.ts
npx tsc --noEmit
Pop-Location
```
