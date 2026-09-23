import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadMonitorEnv } from './env.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'c0-monitor-env-'));
const file = path.join(root, 'c0-config');
try {
  writeFileSync(file, 'VOICE_C0_ENABLED=false\nVOICE_OUTBOX_MONITOR_INTERVAL_MS=100\nOTHER=value\n', 'utf8');
  assert.deepEqual(loadMonitorEnv(file, { VOICE_C0_ENABLED: 'false', VOICE_OUTBOX_MONITOR_INTERVAL_MS: '100' }), { VOICE_C0_ENABLED: 'false', VOICE_OUTBOX_MONITOR_INTERVAL_MS: '100' });
  assert.throws(() => loadMonitorEnv(file, { VOICE_OUTBOX_MONITOR_INTERVAL_MS: '200' }), /VOICE_OUTBOX_MONITOR_INTERVAL_MS/);
  assert.throws(() => loadMonitorEnv(path.join(root, 'missing'), {}), /Unable to load canary/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('env.check OK');
