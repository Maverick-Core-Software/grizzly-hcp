# Grizzly C0 LiveKit canary agent

This isolated Node 20+ worker registers `grizzly-c0-canary`. It loads only
`canary/c0/.env.c0` with `override: false` and refuses startup if that specific
file is absent; it never considers a cwd or repository-root dotenv file.

## Environment names read by this worker

`VOICE_C0_ENABLED`, `VOICE_C0_LIVEKIT_TRUNK_ID`, `VOICE_C0_LIVEKIT_RULE_ID`,
`VOICE_C0_OPENAI_API_KEY`, `VOICE_C0_FALLBACK_URL`,
`VOICE_C0_SYNC_SERVICE_SID`, `VOICE_C0_DATA_DIR`, `VOICE_C0_MAPPING_PATH`, and
`VOICE_C0_REHEARSAL_SILENT_START`,
`VOICE_C0_TWILIO_ACCOUNT_SID`, `VOICE_C0_TWILIO_API_KEY_SID`,
`VOICE_C0_TWILIO_API_KEY_SECRET`, `VOICE_C0_LIVEKIT_URL`,
`VOICE_C0_LIVEKIT_API_KEY`, and `VOICE_C0_LIVEKIT_API_SECRET` are read
directly. The LiveKit and GPT-Live constructors receive those values
explicitly, so they do not resolve generic credential names.

The real bridge also passes the C0-controller configuration names through to
`src/agent/voice`: `VOICE_C0_ALLOWLIST`, `VOICE_C0_PROVIDER`,
`VOICE_C0_MODEL`, `VOICE_OUTBOX_PATH`, `VOICE_OUTBOX_STALE_MS`, and
`VOICE_OUTBOX_MONITOR_INTERVAL_MS`.

## Local checks

```powershell
npm install
npm run check
npx tsc --noEmit
```
