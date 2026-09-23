import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ingress = require('./ingress.protected');
const dialAction = require('./dial-action.protected');
const fallback = require('./fallback.protected');
const fallbackNext = require('./fallback-next.protected');
const whisper = require('./whisper.protected');
const voicemailDone = require('./voicemail-done.protected');
const c0 = require('./lib/c0.private');

const call = (letter: string) => `CA${letter.repeat(32)}`;
const recording = `RE${'f'.repeat(32)}`;
const fakeNumber = (suffix: string) => ['+', '1555', suffix].join('');

function error(status: number) { const value: Error & { status?: number } = new Error(`status_${status}`); value.status = status; return value; }

type FakeSyncOptions = {
  createError?: number;
  fetchError?: number;
  fetchErrors?: Record<string, number>;
  callFetchError?: number;
  updateError?: number;
  beforeUpdate?: (options: any) => Promise<void> | void;
};

function fakeSync(initial: Array<{ uniqueName: string; data: unknown; revision?: string }> = [], statuses: Record<string, string | number> = {}, behavior: FakeSyncOptions = {}) {
  const documents = new Map(initial.map((document, index) => [document.uniqueName, { sid: `ET${index}`, revision: document.revision || '1', ...document }]));
  const documentApi: any = (key: string) => ({
    fetch: async () => { if (behavior.fetchErrors?.[key]) throw error(behavior.fetchErrors[key]); if (behavior.fetchError) throw error(behavior.fetchError); const document = documents.get(key) || [...documents.values()].find((item) => item.sid === key); if (!document) throw error(404); return { ...document }; },
    remove: async () => { const document = documents.get(key) || [...documents.values()].find((item) => item.sid === key); if (!document) throw error(404); documents.delete(document.uniqueName); return true; },
    update: async (updateOptions: any) => {
      await behavior.beforeUpdate?.(updateOptions);
      if (behavior.updateError) throw error(behavior.updateError);
      const document = documents.get(key) || [...documents.values()].find((item) => item.sid === key);
      if (!document) throw error(404);
      if (updateOptions.ifMatch !== document.revision) throw error(412);
      const next = { data: updateOptions.data, revision: String(Number(document.revision) + 1) } as Record<string, unknown>;
      if (updateOptions.ttl !== undefined) next.ttl = updateOptions.ttl;
      Object.assign(document, next);
      return { ...document };
    },
  });
  documentApi.create = async (options: any) => {
    if (behavior.createError) throw error(behavior.createError);
    if (documents.has(options.uniqueName)) throw error(409);
    const document = { sid: `ET${documents.size}`, uniqueName: options.uniqueName, data: options.data, revision: '1', ttl: options.ttl };
    documents.set(options.uniqueName, document);
    return { ...document };
  };
  return {
    documents,
    client: {
      sync: { v1: { services: () => ({ documents: documentApi }) } },
      calls: (sid: string) => ({ fetch: async () => { if (behavior.callFetchError) throw error(behavior.callFetchError); const status = statuses[sid]; if (status === 404) throw error(404); return { status: status || 'in-progress' }; } }),
    },
  };
}

function context(sync = fakeSync(), overrides: Record<string, unknown> = {}) {
  return {
    C0_ALLOWED_CALLERS: fakeNumber('0100'), C0_LIVEKIT_SIP_HOST: 'sip.example.invalid', C0_SIP_USERNAME: 'sip-user', C0_SIP_PASSWORD: 'sip-password',
    C0_CANARY_DID: fakeNumber('0101'), C0_OFFICE_NUMBER: fakeNumber('0102'), C0_BACKUP_NUMBER: fakeNumber('0103'), C0_NTFY_TOPIC: 'c0-test-topic', C0_SYNC_SERVICE_SID: 'IS-sync-test',
    getTwilioClient: () => sync.client, ...overrides,
  };
}

function invoke(handler: Function, ctx: unknown, event: unknown) {
  return new Promise<string>((resolve, reject) => {
    try { handler(ctx, event, (failure: Error | null, twiml: { toString(): string } | string) => failure ? reject(failure) : resolve(typeof twiml === 'string' ? twiml : twiml.toString())); } catch (failure) { reject(failure); }
  });
}

function assertFallbackWithoutDial(twiml: string, label: string) {
  assert.match(twiml, /<Redirect>\/fallback<\/Redirect>/, label);
  assert.doesNotMatch(twiml, /<Dial /, label);
}

async function main() {
  const caller = fakeNumber('0100'); const first = call('a'); const second = call('b');
  const denied = await invoke(ingress.handler, context(), { From: fakeNumber('0199'), CallSid: first });
  assert.match(denied, /<Redirect>\/fallback<\/Redirect>/);

  const defaults = await invoke(ingress.handler, context(), { From: caller, CallSid: first });
  assert.match(defaults, /timeout="20" answerOnBridge="true" timeLimit="480"/);
  assert.match(defaults, /<Sip username="sip-user" password="sip-password">sip:/);
  for (const [name, value] of [['C0_DIAL_TIMEOUT_S', '4'], ['C0_DIAL_TIMEOUT_S', '601'], ['C0_TIME_LIMIT_S', '59'], ['C0_TIME_LIMIT_S', '14401']]) {
    const rejected = await invoke(ingress.handler, context(fakeSync(), { [name]: value }), { From: caller, CallSid: first });
    assert.match(rejected, /<Redirect>\/fallback<\/Redirect>/, `${name}=${value}`);
  }
  for (const [name, value] of [['C0_DIAL_TIMEOUT_S', '5'], ['C0_DIAL_TIMEOUT_S', '600'], ['C0_TIME_LIMIT_S', '60'], ['C0_TIME_LIMIT_S', '14400']]) {
    const accepted = await invoke(ingress.handler, context(fakeSync(), { [name]: value }), { From: caller, CallSid: first });
    assert.match(accepted, /<Dial /, `${name}=${value}`);
  }

  const concurrent = fakeSync();
  const results = await Promise.all([invoke(ingress.handler, context(concurrent), { From: caller, CallSid: first }), invoke(ingress.handler, context(concurrent), { From: caller, CallSid: second })]);
  assert.equal(results.filter((result) => result.includes('<Dial ')).length, 1, 'only one simultaneous ingress acquires the lease');

  const stale = fakeSync([{ uniqueName: 'c0-lease', data: { callSid: second, acquiredAt: 'old' }, revision: '4' }], { [second]: 'completed' });
  const takeover = await invoke(ingress.handler, context(stale), { From: caller, CallSid: first });
  assert.match(takeover, /<Dial /); assert.equal(stale.documents.get('c0-lease')?.data.callSid, first); assert.equal(stale.documents.get('c0-lease')?.revision, '5');

  const released = fakeSync([{ uniqueName: 'c0-lease', data: { callSid: null, releasedAt: 'old' }, revision: '4' }]);
  const releasedTakeover = await invoke(ingress.handler, context(released), { From: caller, CallSid: first });
  assert.match(releasedTakeover, /<Dial /); assert.equal(released.documents.get('c0-lease')?.data.callSid, first);

  let releaseUpdateStarted!: () => void;
  let continueReleaseUpdate!: () => void;
  const releaseUpdateStartedPromise = new Promise<void>((resolve) => { releaseUpdateStarted = resolve; });
  const continueReleaseUpdatePromise = new Promise<void>((resolve) => { continueReleaseUpdate = resolve; });
  const releaseRace = fakeSync([{ uniqueName: 'c0-lease', data: { callSid: first, acquiredAt: 'old' }, revision: '4' }], { [first]: 'completed' }, {
    beforeUpdate: async (update) => {
      if (update.data.callSid === null) { releaseUpdateStarted(); await continueReleaseUpdatePromise; }
    },
  });
  const oldHolderRelease = c0.releaseLease(context(releaseRace), first);
  await releaseUpdateStartedPromise;
  assert.equal(await c0.acquireLease(context(releaseRace), second, 480), true, 'terminal holder may be replaced');
  continueReleaseUpdate();
  await oldHolderRelease;
  assert.equal(releaseRace.documents.get('c0-lease')?.data.callSid, second, 'old holder cannot clear replacement lease');

  for (const [label, sync] of [
    ['create failure', fakeSync([], {}, { createError: 500 })],
    ['fetch failure', fakeSync([{ uniqueName: 'c0-lease', data: { callSid: second, acquiredAt: 'old' } }], {}, { fetchError: 500 })],
    ['stale-holder call lookup failure', fakeSync([{ uniqueName: 'c0-lease', data: { callSid: second, acquiredAt: 'old' } }], {}, { callFetchError: 500 })],
    ['conditional update failure', fakeSync([{ uniqueName: 'c0-lease', data: { callSid: second, acquiredAt: 'old' } }], { [second]: 'completed' }, { updateError: 500 })],
  ] as const) {
    const result = await invoke(ingress.handler, context(sync), { From: caller, CallSid: first });
    assertFallbackWithoutDial(result, label);
  }
  const revisionConflict = await invoke(ingress.handler, context(fakeSync([{ uniqueName: 'c0-lease', data: { callSid: second, acquiredAt: 'old' } }], { [second]: 'completed' }, { updateError: 412 })), { From: caller, CallSid: first });
  assertFallbackWithoutDial(revisionConflict, 'revision conflict is contended');

  const unadmittedAnswered = await invoke(dialAction.handler, context(), { ParentCallSid: first, DialCallStatus: 'completed', DialCallDuration: '30' });
  assert.match(unadmittedAnswered, /<Redirect>\/fallback<\/Redirect>/, 'completed SIP without positive admission falls back');
  assert.doesNotMatch(unadmittedAnswered, /<Hangup\/>/, 'completed SIP without positive admission does not hang up');

  const admitted = fakeSync([{ uniqueName: `c0-admitted-${first}`, data: { by: 'agent' } }]);
  const admittedAnswered = await invoke(dialAction.handler, context(admitted), { ParentCallSid: first, DialCallStatus: 'completed', DialCallDuration: '30' });
  assert.match(admittedAnswered, /<Hangup\/>/, 'positive admission plus completed Dial hangs up');
  assert.equal(admitted.documents.has(`c0-admitted-${first}`), false, 'positive admission is consumed best effort');

  const transfer = fakeSync([
    { uniqueName: `c0-transfer-${first}`, data: { role: 'backup', by: 'agent' } },
    { uniqueName: `c0-admitted-${first}`, data: { by: 'agent' } },
  ]);
  const redirected = await invoke(dialAction.handler, context(transfer), { ParentCallSid: first, DialCallStatus: 'completed', DialCallDuration: '30' });
  assert.match(redirected, /<Redirect>\/fallback\?role=backup<\/Redirect>/, 'transfer flag beats positive admission'); assert.doesNotMatch(redirected, /<Hangup/);
  assert.equal(transfer.documents.has(`c0-admitted-${first}`), true, 'transfer precedence does not consume admission');
  const syncFailure = await invoke(dialAction.handler, context(fakeSync([], {}, { fetchErrors: { [`c0-admitted-${first}`]: 500 } })), { CallSid: first, DialCallStatus: 'completed', DialCallDuration: '1' });
  assert.match(syncFailure, /<Redirect>\/fallback<\/Redirect>/);

  const office = await invoke(fallback.handler, context(), {});
  assert.match(office, /fallback-next\?role=office/); assert.match(office, /<Number url="\/whisper" method="POST">/);
  const oldAnswered = (event: { DialCallStatus?: string; DialCallDuration?: string }) => event.DialCallStatus === 'completed' && Number(event.DialCallDuration) > 0;
  for (const [label, whisperEvent] of [['no digit', {}], ['Digits 2', { Digits: '2' }], ['decline', { Digits: '0' }]] as const) {
    const screened = await invoke(whisper.handler, context(), whisperEvent);
    assert.match(screened, /<Gather /, `${label} asks for acceptance`); assert.match(screened, /<Hangup\/>/, `${label} does not bridge`);
    const failedScreen = { DialCallStatus: 'completed', DialCallDuration: '1' };
    assert.equal(oldAnswered(failedScreen), true, `${label} would have hung up under the rejected predicate`);
    const officeNext = await invoke(fallbackNext.handler, context(), { role: 'office', ...failedScreen });
    assert.match(officeNext, /<Redirect>\/fallback\?role=backup<\/Redirect>/, `${label} advances office to backup`); assert.doesNotMatch(officeNext, /<Hangup\/>/);
    const backupNext = await invoke(fallbackNext.handler, context(), { role: 'backup', ...failedScreen });
    assert.match(backupNext, /No one is available right now/, `${label} advances backup to voicemail`); assert.doesNotMatch(backupNext, /<Hangup\/>/);
  }
  const bridged = await invoke(fallbackNext.handler, context(), { role: 'office', DialBridged: 'true' }); assert.match(bridged, /<Hangup\/>/);
  const accept = await invoke(whisper.handler, context(), { Digits: '1' }); assert.equal(accept, '<?xml version="1.0" encoding="UTF-8"?><Response/>');

  const captures: string[] = [];
  await voicemailDone.postRedactedAlert('c0-test-topic', recording, first, async (_url: string, options: { body: string }) => { captures.push(options.body); return { ok: true }; });
  assert.match(captures[0], new RegExp(recording)); assert.match(captures[0], /CAaaaa…/);
  const poisoned = voicemailDone.alertBody(fakeNumber('0199'), fakeNumber('0100'));
  assert.doesNotMatch(poisoned, /0199|0100|1555/); assert.match(poisoned, /unknown/);
  const mixedRecording = `RE${'a'.repeat(31)}F`; const mixedCall = `CA${'b'.repeat(31)}A`;
  const mixed = voicemailDone.alertBody(mixedRecording, mixedCall);
  assert.match(mixed, new RegExp(mixedRecording)); assert.match(mixed, /CAbbbb…/);

  for (const file of readdirSync(__dirname, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.js')) continue;
    assert.match(file.name, /\.protected\.js$/, `unprotected function file: ${join(__dirname, file.name)}`);
  }
}

void main().then(() => console.log('c0-functions.check OK'));
