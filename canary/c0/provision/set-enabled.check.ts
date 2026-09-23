import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertC0EnvAtomically } from './lib.js';
import { setEnabled } from './set-enabled.js';

async function run(): Promise<void> {
  const writes: Record<string, string>[] = [];
  const writer = async (values: Record<string, string>) => { writes.push(values); };
  const clock = () => new Date('2026-09-22T00:00:00.000Z');
  const dry = await setEnabled({ VOICE_C0_ENABLED: 'false' }, 'true', false, writer, clock);
  assert.deepEqual(dry, { dryRun: true, before: 'false', after: 'true', at: '2026-09-22T00:00:00.000Z', written: [], restartCommand: 'pm2 restart c0-agent' });
  assert.equal(writes.length, 0, 'dry run makes no write');
  await assert.rejects(() => setEnabled({}, 'yes', true, writer), /true\|false/);
  const applied = await setEnabled({ VOICE_C0_ENABLED: 'false' }, 'true', true, writer, clock);
  assert.equal(applied.dryRun, false); assert.deepEqual(writes, [{ VOICE_C0_ENABLED: 'true' }]);
  await setEnabled({ VOICE_C0_ENABLED: 'true' }, 'true', true, writer, clock);
  assert.deepEqual(writes[1], writes[0], 'same enabled value is idempotent');

  const root = await mkdtemp(join(tmpdir(), 'c0-enabled-')); const path = join(root, 'c0.env');
  try {
    await writeFile(path, 'KEEP=value\nVOICE_C0_ENABLED=false\nOTHER=unchanged\n', 'utf8');
    await upsertC0EnvAtomically({ VOICE_C0_ENABLED: 'true' }, path);
    assert.equal(await readFile(path, 'utf8'), 'KEEP=value\nOTHER=unchanged\nVOICE_C0_ENABLED=true\n', 'only enabled line changes');
  } finally { await rm(root, { recursive: true, force: true }); }
}

run().then(() => console.log('set-enabled.check OK')).catch((error) => { console.error(error); process.exitCode = 1; });
