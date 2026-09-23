import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertC0EnvAtomically } from './lib.js';
import { selectCanaryNumber } from './select-canary-number.js';
import { buyCanaryNumber } from './twilio-buy-number.js';
import { fakeSid } from './fake-fixtures.js';

const DID = '+15551230001';
const SID = fakeSid('PN');
const number = (overrides: Record<string, unknown> = {}) => ({ sid: SID, phoneNumber: DID, trunkSid: null, voiceApplicationSid: null, ...overrides });
const client = (numbers: any[]) => ({ incomingPhoneNumbers: { list: async () => numbers } });

async function rejects(action: () => Promise<unknown>, text: string) { await assert.rejects(action, new RegExp(text)); }

async function run(): Promise<void> {
  let writes: Record<string, string>[] = [];
  const writer = async (values: Record<string, string>) => { writes.push(values); };
  const dry = await selectCanaryNumber(client([number()]), DID, false, writer);
  assert.equal(dry.dryRun, true); assert.equal(writes.length, 0, 'dry selection has no env write');
  await rejects(() => selectCanaryNumber(client([]), DID, false, writer), 'not found');
  await rejects(() => selectCanaryNumber(client([number({ trunkSid: 'TK1' })]), DID, false, writer), 'trunk');
  await rejects(() => selectCanaryNumber(client([number({ voiceApplicationSid: 'AP1' })]), DID, false, writer), 'application');
  await rejects(() => selectCanaryNumber(client([number()]), DID, false, writer, SID), 'production');
  const applied = await selectCanaryNumber(client([number()]), DID, true, writer);
  assert.equal(applied.dryRun, false); assert.deepEqual(writes[0], { VOICE_C0_CANARY_DID: DID, VOICE_C0_CANARY_NUMBER_SID: SID });
  await selectCanaryNumber(client([number()]), DID, true, writer);
  assert.deepEqual(writes[1], writes[0], 'selection is idempotent with the same subaccount number');

  const fakeBuy = { availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: DID }] } }), incomingPhoneNumbers: { create: async () => ({ sid: SID, phoneNumber: DID }) } };
  const bought = await buyCanaryNumber(fakeBuy, DID, true, writer);
  assert.equal(bought.dryRun, false); assert.deepEqual(writes[2], writes[0], 'purchase reuses the same number env writer contract');
  const mismatchBuy = { availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: DID }] } }), incomingPhoneNumbers: { create: async () => ({ sid: SID, phoneNumber: '+15551239999' }) } };
  await rejects(() => buyCanaryNumber(mismatchBuy, DID, true, writer), 'did not match');
  assert.equal(writes.length, 3, 'mismatched purchase response never writes the environment');

  const root = await mkdtemp(join(tmpdir(), 'c0-select-number-')); const path = join(root, 'c0.env');
  try {
    await writeFile(path, 'KEEP=value\nVOICE_C0_CANARY_DID=old\nVOICE_C0_CANARY_NUMBER_SID=old\nOTHER=unchanged\n', 'utf8');
    await upsertC0EnvAtomically({ VOICE_C0_CANARY_DID: DID, VOICE_C0_CANARY_NUMBER_SID: SID }, path);
    assert.equal(await readFile(path, 'utf8'), `KEEP=value\nOTHER=unchanged\nVOICE_C0_CANARY_DID=${DID}\nVOICE_C0_CANARY_NUMBER_SID=${SID}\n`, 'only the two number lines change');
  } finally { await rm(root, { recursive: true, force: true }); }
}

run().then(() => console.log('select-canary-number.check OK')).catch((error) => { console.error(error); process.exitCode = 1; });
