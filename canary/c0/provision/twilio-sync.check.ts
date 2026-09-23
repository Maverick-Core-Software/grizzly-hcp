import assert from 'node:assert/strict';
import { ensureSyncService, SYNC_SERVICE_NAME } from './twilio-sync.js';
import { printSafe } from './lib.js';
import { fakeSid } from './fake-fixtures.js';

async function run(): Promise<void> {
  let creates = 0; let writes = 0; const secret = 'sync-secret-never-printed';
  const syncSid = fakeSid('IS');
  const client = { sync: { v1: { services: { list: async () => [], create: async (input: { friendlyName: string; uniqueName: string }) => { creates += 1; assert.deepEqual(input, { friendlyName: SYNC_SERVICE_NAME, uniqueName: SYNC_SERVICE_NAME }); return { sid: syncSid }; } } } } };
  const dry = await ensureSyncService(client, false, async () => { writes += 1; });
  assert.equal(dry.dryRun, true); assert.equal(creates, 0); assert.equal(writes, 0, 'dry-run makes no Sync service or env mutation');
  const applied = await ensureSyncService(client, true, async (values) => { writes += 1; assert.deepEqual(values, { VOICE_C0_SYNC_SERVICE_SID: syncSid }); });
  assert.equal(applied.dryRun, false); assert.equal(creates, 1); assert.equal(writes, 1);
  const reused = await ensureSyncService({ sync: { v1: { services: { list: async () => [{ sid: fakeSid('IS'), uniqueName: SYNC_SERVICE_NAME }], create: async () => { throw new Error('must not create'); } } } } }, true, async () => { writes += 1; });
  assert.equal(reused.action, 'reused');
  const log = console.log; let stdout = ''; console.log = (...items: unknown[]) => { stdout += items.join(' '); };
  try { printSafe({ secret, applied }); } finally { console.log = log; }
  assert.ok(!stdout.includes(secret), 'Sync check does not print secrets');
}

run().then(() => console.log('twilio-sync.check OK')).catch((error) => { console.error(error); process.exitCode = 1; });
