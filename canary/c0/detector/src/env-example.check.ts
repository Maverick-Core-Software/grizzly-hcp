import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = fs.readFileSync(path.resolve(here, '../../.env.c0.example'), 'utf8').split(/\r?\n/);
const required = [
  'VOICE_C0_TWILIO_ACCOUNT_SID', 'VOICE_C0_TWILIO_AUTH_TOKEN', 'VOICE_C0_TWILIO_API_KEY_SID',
  'VOICE_C0_TWILIO_API_KEY_SECRET', 'VOICE_C0_CANARY_DID', 'VOICE_C0_CANARY_NUMBER_SID', 'VOICE_C0_INGRESS_URL', 'VOICE_C0_FALLBACK_URL',
  'VOICE_C0_LIVEKIT_URL', 'VOICE_C0_LIVEKIT_API_KEY', 'VOICE_C0_LIVEKIT_API_SECRET',
  'VOICE_C0_LIVEKIT_SIP_HOST', 'VOICE_C0_LIVEKIT_TRUNK_ID', 'VOICE_C0_LIVEKIT_RULE_ID',
  'VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION', 'VOICE_C0_SIP_USERNAME', 'VOICE_C0_SIP_PASSWORD', 'VOICE_C0_SIP_TRANSPORT',
  'VOICE_C0_OPENAI_API_KEY', 'VOICE_C0_ALLOWED_CALLERS', 'VOICE_C0_OFFICE_NUMBER',
  'VOICE_C0_BACKUP_NUMBER', 'VOICE_C0_NTFY_TOPIC', 'VOICE_C0_MAPPING_PATH', 'VOICE_C0_SYNC_SERVICE_SID', 'VOICE_C0_ENABLED', 'VOICE_C0_REHEARSAL_SILENT_START', 'VOICE_C0_ALLOWLIST', 'VOICE_C0_DATA_DIR',
  'VOICE_C0_PROVIDER', 'VOICE_C0_MODEL', 'VOICE_OUTBOX_PATH', 'VOICE_OUTBOX_STALE_MS',
  'VOICE_OUTBOX_MONITOR_INTERVAL_MS',
];
const assignments = lines.filter((line) => line !== '' && !line.startsWith('#'));
const names = assignments.map((line) => line.slice(0, -1));
assert.deepEqual(names, required, 'the template must have exactly the canonical names in canonical order');
for (const line of assignments) {
  if (line === '' || line.startsWith('#')) continue;
  assert.match(line, /^[A-Z][A-Z0-9_]*=$/, `template must contain an empty dotenv assignment: ${line}`);
}
console.log('env-example.check OK');
