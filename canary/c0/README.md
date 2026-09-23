# Grizzly C0 voice canary operations

This directory contains a fully isolated, disabled-by-default voice canary.
It has no production app name, no production process dependency, and no public
listener: the agent, detector, and monitor are separate outbound-only PM2 apps.
Stopping all three leaves the production line untouched.

## Local preparation

1. Copy `.env.c0.example` to the git-ignored `.env.c0` and have Carter provide
   only C0-scoped values. Do not place values in the example file or PM2 config.
2. In each package directory (`agent`, `detector`, and `monitor`), run its
   approved exact-version `npm install` before starting PM2.
3. Confirm `VOICE_C0_ENABLED=false` until the separately approved rehearsal.

## Start and stop

Start only the three canary apps:

```powershell
pm2 start canary/c0/ecosystem.c0.config.cjs --only c0-agent,c0-detector,c0-monitor
pm2 status c0-agent c0-detector c0-monitor
```

Stop them without touching any production PM2 app:

```powershell
pm2 stop c0-agent c0-detector c0-monitor
```

The detector polls the C0 subaccount every two seconds. It uses the local
`data/c0/answered` and `data/c0/first-audio` markers only; it does not require
the LiveKit service or agent process to be running. Before redirecting a call,
it writes the C0 Twilio Sync transfer-intent document for the office role; a
Sync failure is logged redacted and does not block the human fallback. The monitor reads the C0
outbox and sends only redacted stale-record alerts; it never retries, delivers,
or edits an outbox record.

## Shared data root

All C0 processes resolve durable state from `VOICE_C0_DATA_DIR` when it is set;
the value must be an absolute path and a relative value is refused at startup.
When it is absent, the data root is `<worktree>/data/c0`, where the worktree is
asserted by its `package.json` and `src/agent/voice` directory. Agent markers
are therefore `<dataRoot>/answered`, `<dataRoot>/first-audio`, and
`<dataRoot>/redirected` by parent CallSid; the outbox path is independently
resolved against that same worktree root, never a PM2 working directory.

## Kill switch

The C0 kill switch is a **canary-number-only** Twilio configuration action:
set that canary DID's `VoiceUrl` to the reviewed `/fallback` Function URL.
Leave `TrunkSid` and `VoiceApplicationSid` empty so the number VoiceUrl remains
effective. This changes no production number, production Function, production
PM2 app, or production routing.

After the VoiceUrl change, stop the C0 apps above if an immediate local halt is
also wanted. The Function fallback transfers to the C0 office/backup path and
does not invoke the existing production conversation relay.

## Rollback

1. Keep the canary DID on its `/fallback` VoiceUrl and stop only `c0-agent`,
   `c0-detector`, and `c0-monitor`.
2. Preserve C0 logs and the local C0 outbox/marker state for review; do not
   replay records as part of rollback.
3. Restore the prior reviewed canary-only VoiceUrl only after a new explicit
   approval and rehearsal. Production remains untouched throughout.
