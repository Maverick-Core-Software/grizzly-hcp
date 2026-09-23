import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DailyUsageStore, FileMarkerWriter, REPO_ROOT, resolveCanaryPath, resolveDataRoot } from './runtime.js';
import { fakeSid } from './fake-fixtures.js';

assert.equal(fs.existsSync(path.join(REPO_ROOT, 'src', 'agent', 'voice')), true);
assert.equal(resolveDataRoot(null), path.join(REPO_ROOT, 'data', 'c0'));
assert.equal(resolveCanaryPath('data/c0/test.jsonl', 'ignored'), path.join(REPO_ROOT, 'data', 'c0', 'test.jsonl'));
assert.throws(() => resolveDataRoot('relative/path'), /c0_data_dir_must_be_absolute/);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c0-runtime-'));
const callSid = fakeSid('CA');
try {
  new FileMarkerWriter(temp).mark('answered', callSid);
  assert.equal(fs.existsSync(path.join(temp, 'answered', callSid)), true);
  const usage = new DailyUsageStore(temp, () => new Date('2026-09-22T17:00:00Z'));
  assert.deepEqual(usage.usage(), { todayCalls: 0, todayGptLiveMinutes: 0 });
  fs.writeFileSync(path.join(temp, 'usage-2026-09-22.jsonl'), '{broken}\n');
  assert.equal(usage.usage(), null, 'unreadable daily usage is unobservable, never silently admitted');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('runtime.check OK');
