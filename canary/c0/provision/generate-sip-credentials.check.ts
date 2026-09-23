import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSipCredentials } from './generate-sip-credentials.js';
import { upsertC0EnvAtomically } from './lib.js';

async function run(): Promise<void> {
  let writes = 0; let saved: Record<string, string> = {};
  const deterministic = (size: number) => Buffer.alloc(size, 7);
  const dry = await generateSipCredentials({}, false, async () => { writes += 1; }, deterministic);
  assert.equal(dry.dryRun, true); assert.equal(writes, 0, 'dry-run writes no credential'); assert.deepEqual(dry.generated, ['VOICE_C0_SIP_PASSWORD', 'VOICE_C0_SIP_USERNAME']);
  const applied = await generateSipCredentials({}, true, async (values) => { writes += 1; saved = values; }, deterministic);
  assert.equal(applied.dryRun, false); assert.equal(writes, 1); assert.match(saved.VOICE_C0_SIP_USERNAME, /^c0-[a-f\d]{24}$/); assert.ok(saved.VOICE_C0_SIP_PASSWORD.length >= 40);
  const alreadyPresent = await generateSipCredentials({ VOICE_C0_SIP_USERNAME: 'c0-existing', VOICE_C0_SIP_PASSWORD: 'already-present' }, true, async () => { writes += 1; }, deterministic);
  assert.deepEqual(alreadyPresent.generated, []); assert.equal(writes, 1, 'existing credentials are not rewritten');
  const root = await mkdtemp(join(tmpdir(), 'c0-atomic-')); const path = join(root, 'c0.env');
  await writeFile(path, 'KEEP=value\nVOICE_C0_SIP_USERNAME=old\nVOICE_C0_SIP_PASSWORD=old\n', 'utf8');
  await upsertC0EnvAtomically({ VOICE_C0_SIP_USERNAME: 'new-user', VOICE_C0_SIP_PASSWORD: 'new-password' }, path);
  assert.equal(await readFile(path, 'utf8'), 'KEEP=value\nVOICE_C0_SIP_USERNAME=new-user\nVOICE_C0_SIP_PASSWORD=new-password\n', 'atomic upsert replaces only named values');
  await rm(root, { recursive: true, force: true });
}

run().then(() => console.log('generate-sip-credentials.check OK')).catch((error) => { console.error(error); process.exitCode = 1; });
