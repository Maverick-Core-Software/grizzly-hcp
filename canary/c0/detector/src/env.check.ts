import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadDetectorEnv } from './env.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'c0-detector-env-'));
const file = path.join(root, 'c0-config');
try {
  writeFileSync(file, 'VOICE_C0_ENABLED=false\nVOICE_OUTBOX_STALE_MS=123\nOTHER=value\n', 'utf8');
  assert.deepEqual(loadDetectorEnv(file, { VOICE_C0_ENABLED: 'false', VOICE_OUTBOX_STALE_MS: '123' }), { VOICE_C0_ENABLED: 'false', VOICE_OUTBOX_STALE_MS: '123' });
  assert.throws(() => loadDetectorEnv(file, { VOICE_C0_ENABLED: 'true' }), /VOICE_C0_ENABLED/);
  assert.throws(() => loadDetectorEnv(path.join(root, 'missing'), {}), /Unable to load canary/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('env.check OK');
