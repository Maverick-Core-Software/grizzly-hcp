import assert from 'node:assert/strict';
import { loadCanaryRuntimeConfig } from './config.js';

const body = 'VOICE_C0_TWILIO_ACCOUNT_SID=ACcanary\nVOICE_C0_TWILIO_API_KEY_SID=SKcanary\nVOICE_C0_TWILIO_API_KEY_SECRET=secret\nVOICE_C0_LIVEKIT_URL=wss://canary.example\nVOICE_C0_LIVEKIT_API_KEY=key\nVOICE_C0_LIVEKIT_API_SECRET=secret\nVOICE_C0_OPENAI_API_KEY=secret\nVOICE_C0_FALLBACK_URL=https://fallback.example/c0\nVOICE_C0_SYNC_SERVICE_SID=IScanary\nVOICE_C0_LIVEKIT_TRUNK_ID=trunk\nVOICE_C0_LIVEKIT_RULE_ID=rule\nVOICE_C0_ENABLED=true\nVOICE_C0_ALLOWLIST=+15551230001\n';
const config = loadCanaryRuntimeConfig({}, () => body);
assert.equal(config.rehearsalSilentStart, false);
assert.throws(() => loadCanaryRuntimeConfig({ VOICE_C0_OPENAI_API_KEY: 'different' }, () => body), /c0_env_inherited_conflict_VOICE_C0_OPENAI_API_KEY/);
assert.throws(() => loadCanaryRuntimeConfig({ VOICE_OUTBOX_PATH: 'poisoned' }, () => body), /c0_env_inherited_conflict_VOICE_OUTBOX_PATH/);
assert.throws(() => loadCanaryRuntimeConfig({}, () => { throw new Error('missing'); }), /c0_env_file_missing/);
assert.equal(loadCanaryRuntimeConfig({}, () => `${body}VOICE_C0_REHEARSAL_SILENT_START=true\n`).rehearsalSilentStart, true);
console.log('config.check OK');
