import assert from 'node:assert/strict';
import { diffProductionSnapshots, resolveCompareEvidencePath, snapshotProductionGuard } from './snapshot-production-guard.js';

const parent = 'ACparent0000000000000000000000000001';
const productionNumber = {
  sid: 'PNproduction000000000000000000000001',
  voiceUrl: 'https://production.example/voice', voiceMethod: 'POST', voiceFallbackUrl: 'https://production.example/fallback', voiceFallbackMethod: 'GET', voiceApplicationSid: null,
  voiceCallerIdLookup: true, voiceReceiveMode: 'voice',
  smsUrl: 'https://production.example/sms', smsMethod: 'POST', smsFallbackUrl: 'https://production.example/sms-fallback', smsFallbackMethod: 'GET', smsApplicationSid: null,
  trunkSid: null, statusCallback: 'https://production.example/status', statusCallbackMethod: 'POST',
  emergencyStatus: 'Active', emergencyAddressSid: 'ADemergency', emergencyAddressStatus: 'registered',
  bundleSid: 'BUproduction', addressSid: 'ADproduction', identitySid: 'RIproduction',
};

async function snapshotFor(number: typeof productionNumber) {
  const fake = {
    api: {
      v2010: {
        accounts: (sid: string) => ({
          incomingPhoneNumbers: {
            list: async () => {
              assert.equal(sid, parent, 'the operator guard queries the supplied parent account');
              return [number, { sid: 'PNother000000000000000000000000000002' }];
            },
          },
        }),
      },
    },
  };
  return snapshotProductionGuard(fake, parent);
}

async function run(): Promise<void> {
  const snapshot = await snapshotFor(productionNumber);
  assert.equal(snapshot.numbers.length, 2, 'all parent numbers are snapshotted');
  assert.ok(snapshot.numbers.every((number) => number.number_sid?.includes('…')), 'number SIDs are masked');
  assert.ok(snapshot.numbers.every((number) => /^[a-f0-9]{64}$/.test(number.fields_sha256)), 'routing fields are hashed');
  assert.deepEqual(diffProductionSnapshots(snapshot, snapshot), []);

  const changedFields: Array<[keyof typeof productionNumber, string | boolean | null]> = [
    ['voiceUrl', 'https://changed.example/voice'], ['voiceMethod', 'GET'], ['voiceFallbackUrl', 'https://changed.example/fallback'], ['voiceFallbackMethod', 'POST'], ['voiceApplicationSid', 'APproduction'],
    ['voiceCallerIdLookup', false], ['voiceReceiveMode', 'fax'], ['smsUrl', 'https://changed.example/sms'], ['smsMethod', 'GET'], ['smsFallbackUrl', 'https://changed.example/sms-fallback'], ['smsFallbackMethod', 'POST'], ['smsApplicationSid', 'APsmsproduction'],
    ['trunkSid', 'TKproduction'], ['statusCallback', 'https://changed.example/status'], ['statusCallbackMethod', 'GET'], ['emergencyStatus', 'Inactive'], ['emergencyAddressSid', 'ADemergencyChanged'], ['emergencyAddressStatus', 'not-registered'], ['bundleSid', 'BUchanged'], ['addressSid', 'ADchanged'], ['identitySid', 'RIchanged'],
  ];
  for (const [field, changedValue] of changedFields) {
    const changed = { ...productionNumber, [field]: changedValue } as typeof productionNumber;
    assert.equal(diffProductionSnapshots(snapshot, await snapshotFor(changed)).length, 1, `${field} changes must be detected`);
  }

  const root = 'C:\\repo\\canary\\c0\\provision\\evidence';
  const evidence = `${root}\\capture.json`;
  let realpathCalls = 0;
  const forbiddenFileSystem = {
    realpath: async (_path: string) => { realpathCalls += 1; return evidence; },
    stat: async (_path: string) => ({ isFile: () => true }),
  };
  await assert.rejects(() => resolveCompareEvidencePath('canary/c0/.env.c0', forbiddenFileSystem, root), /environment-like/);
  assert.equal(realpathCalls, 0, 'environment-like compare paths are rejected before filesystem access');
  await assert.rejects(() => resolveCompareEvidencePath(`${root}\\capture.txt`, forbiddenFileSystem, root), /JSON evidence/);
  assert.equal(realpathCalls, 0, 'non-JSON compare paths are rejected before filesystem access');

  const containedFileSystem = {
    realpath: async (path: string) => path === root ? root : evidence,
    stat: async (_path: string) => ({ isFile: () => true }),
  };
  assert.equal(await resolveCompareEvidencePath(`${root}\\nested\\..\\capture.json`, containedFileSystem, root), evidence, 'an existing canonical evidence JSON path is allowed');
  const escapedFileSystem = {
    realpath: async (path: string) => path === root ? root : 'C:\\outside\\capture.json',
    stat: async (_path: string) => ({ isFile: () => true }),
  };
  await assert.rejects(() => resolveCompareEvidencePath(`${root}\\linked.json`, escapedFileSystem, root), /outside provision evidence/);
  console.log('snapshot-production-guard.check OK');
}

void run();
