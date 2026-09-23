import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createC0Controller } from '../../../src/agent/voice/c0-controller.js';
import { loadC0Config } from '../../../src/agent/voice/c0-config.js';
import { Outbox } from '../../../src/agent/voice/outbox.js';
import { evaluateGate } from '../agent/src/gate.js';
import { FileMarkerWriter, resolveDataRoot } from '../agent/src/runtime.js';
import { transferWithSync } from '../agent/src/transfer.js';
import { resolveC0DataRoot as resolveDetectorDataRoot } from '../detector/src/data-root.js';
import { resolveC0DataRoot as resolveMonitorDataRoot } from '../monitor/data-root.js';
import { functionContext } from '../provision/deploy-functions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C0_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(C0_ROOT, '../..');
const FUNCTIONS_ROOT = path.join(C0_ROOT, 'twilio-functions', 'functions');
const functionRequire = createRequire(path.join(FUNCTIONS_ROOT, 'integration-loader.cjs'));
const ingress = functionRequire('./ingress.protected.js');
const dialAction = functionRequire('./dial-action.protected.js');
const fallback = functionRequire('./fallback.protected.js');
const fallbackNext = functionRequire('./fallback-next.protected.js');
const voicemailDone = functionRequire('./voicemail-done.protected.js');

type Failure = { readonly contract: string; readonly message: string };
const failures: Failure[] = [];

async function contract(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ contract: name, message });
    console.log(`[FAIL] ${name}: ${message}`);
  }
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') return sourceFiles(full);
    if (!entry.isFile() || entry.name.endsWith('.check.ts')) return [];
    return /\.(?:ts|js|cjs|mjs)$/.test(entry.name) ? [full] : [];
  });
}

function lineOf(file: string, needle: string | RegExp): string {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const line = lines.findIndex((value) => typeof needle === 'string' ? value.includes(needle) : needle.test(value));
  return `${path.relative(REPO_ROOT, file).replaceAll('\\', '/')}:${line + 1}`;
}

function assertAt(condition: unknown, file: string, needle: string | RegExp, message: string): asserts condition {
  assert.ok(condition, `${lineOf(file, needle)} ${message}`);
}

function staticNames(roots: readonly string[], pattern: RegExp): Set<string> {
  const names = new Set<string>();
  for (const file of roots.flatMap(sourceFiles)) {
    const body = readFileSync(file, 'utf8');
    for (const match of body.matchAll(pattern)) names.add(match[0]);
  }
  return names;
}

function makeCallSid(letter: string): string { return `CA${letter.repeat(32)}`; }
function makeRecordingSid(letter: string): string { return `RE${letter.repeat(32)}`; }
function fakeE164(suffix: string): string { return `+1555123${suffix}`; }

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`status_${status}`), { status });
}

type SyncDocument = { sid: string; uniqueName: string; data: unknown; revision: string; ttl?: number };

function fakeSync(initial: readonly Pick<SyncDocument, 'uniqueName' | 'data'>[] = []) {
  const documents = new Map<string, SyncDocument>(initial.map((document, index) => [document.uniqueName, {
    sid: `ET${index}`, uniqueName: document.uniqueName, data: document.data, revision: '1',
  }]));
  const documentApi: any = (key: string) => ({
    fetch: async () => {
      const found = documents.get(key) ?? [...documents.values()].find((document) => document.sid === key);
      if (!found) throw httpError(404);
      return { ...found };
    },
    remove: async () => {
      const found = documents.get(key) ?? [...documents.values()].find((document) => document.sid === key);
      if (!found) throw httpError(404);
      documents.delete(found.uniqueName);
    },
    update: async (options: { ifMatch?: string; data: unknown; ttl?: number }) => {
      const found = documents.get(key) ?? [...documents.values()].find((document) => document.sid === key);
      if (!found) throw httpError(404);
      if (options.ifMatch !== found.revision) throw httpError(412);
      found.data = options.data;
      found.revision = String(Number(found.revision) + 1);
      if (options.ttl !== undefined) found.ttl = options.ttl;
      return { ...found };
    },
  });
  documentApi.create = async (options: { uniqueName: string; data: unknown; ttl?: number }) => {
    if (documents.has(options.uniqueName)) throw httpError(409);
    const document = { sid: `ET${documents.size}`, uniqueName: options.uniqueName, data: options.data, revision: '1', ttl: options.ttl };
    documents.set(options.uniqueName, document);
    return { ...document };
  };
  return {
    documents,
    documentApi,
    client: {
      sync: { v1: { services: () => ({ documents: documentApi }) } },
      calls: (_callSid: string) => ({ fetch: async () => ({ status: 'in-progress' }) }),
    },
  };
}

function functionContextFake(sync: ReturnType<typeof fakeSync>) {
  return {
    C0_ALLOWED_CALLERS: fakeE164('001'),
    C0_LIVEKIT_SIP_HOST: 'sip.example.invalid',
    C0_SIP_USERNAME: 'test-sip-user',
    C0_SIP_PASSWORD: 'test-sip-password',
    C0_CANARY_DID: fakeE164('002'),
    C0_OFFICE_NUMBER: fakeE164('003'),
    C0_BACKUP_NUMBER: fakeE164('004'),
    C0_NTFY_TOPIC: 'c0-integration-test',
    C0_SYNC_SERVICE_SID: 'IS-integration-test',
    getTwilioClient: () => sync.client,
  };
}

function invoke(handler: Function, context: unknown, event: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    handler(context, event, (failure: Error | null, twiml: { toString(): string } | string) => {
      if (failure) reject(failure);
      else resolve(typeof twiml === 'string' ? twiml : twiml.toString());
    });
  });
}

async function main(): Promise<void> {
  await contract('ENV SURFACE', () => {
    const example = path.join(C0_ROOT, '.env.c0.example');
    const lines = readFileSync(example, 'utf8').split(/\r?\n/);
    const environmentErrors: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (!/^(?:\s*|\s*#.*|[A-Z][A-Z0-9_]*=)$/.test(line)) {
        environmentErrors.push(`${path.relative(REPO_ROOT, example).replaceAll('\\', '/')}:${index + 1} template entries must be comments, blanks, or empty NAME= assignments`);
      }
    }
    // Read the identifier even from an invalid bare entry so the format and
    // coverage diagnostics remain independent and both are reported.
    const exampleNames = new Set(lines.map((line) => line.match(/^([A-Z][A-Z0-9_]*)(?:=)?$/)?.[1]).filter((value): value is string => Boolean(value)));
    const voiceNames = staticNames(
      [path.join(C0_ROOT, 'agent', 'src'), path.join(C0_ROOT, 'detector', 'src'), path.join(C0_ROOT, 'monitor'), path.join(C0_ROOT, 'provision')],
      /\b(?:VOICE_C0_[A-Z0-9_]+|VOICE_OUTBOX_[A-Z0-9_]+)\b/g,
    );
    const functionNames = staticNames([FUNCTIONS_ROOT], /\bC0_[A-Z0-9_]+\b/g);
    const missingVoice = [...voiceNames].filter((name) => !exampleNames.has(name));
    if (missingVoice.length > 0) environmentErrors.push(`${path.relative(REPO_ROOT, example).replaceAll('\\', '/')}:1 missing VOICE names: ${missingVoice.sort().join(', ')}`);
    const functionEnv = Object.fromEntries([...voiceNames].map((name) => [name, 'test-value']));
    functionEnv.VOICE_C0_SIP_TRANSPORT = 'tcp';
    const mapped = new Set(Object.keys(functionContext(functionEnv)));
    const unmapped = [...functionNames].filter((name) => !mapped.has(name));
    if (unmapped.length > 0) environmentErrors.push(`${lineOf(path.join(C0_ROOT, 'provision', 'deploy-functions.ts'), 'functionContext')} function environment mapping omits ${unmapped.sort().join(', ')}`);
    const harnessSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    if (/\.env\.c0(?!\.example)/.test(harnessSource)) environmentErrors.push(`${path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).replaceAll('\\', '/')} must not reference the real environment file`);
    assert.equal(environmentErrors.length, 0, environmentErrors.join('\n'));
  });

  await contract('SYNC NAMES', () => {
    const transfer = path.join(C0_ROOT, 'agent', 'src', 'transfer.ts');
    const worker = path.join(C0_ROOT, 'agent', 'src', 'worker.ts');
    const detector = path.join(C0_ROOT, 'detector', 'src', 'detector.ts');
    const functions = path.join(FUNCTIONS_ROOT, 'lib', 'c0.private.js');
    assertAt(readFileSync(functions, 'utf8').includes("'c0-lease'"), functions, "'c0-lease'", 'Function lease name must be c0-lease');
    for (const file of [transfer, detector, functions]) {
      assertAt(readFileSync(file, 'utf8').includes('c0-transfer-${'), file, 'c0-transfer-${', 'transfer document must be parent CallSid scoped');
    }
    assertAt(readFileSync(transfer, 'utf8').includes("data: { role, by: 'agent' }"), transfer, "data: { role, by: 'agent' }", 'agent must write role and by');
    assertAt(readFileSync(detector, 'utf8').includes("data: { role: 'office', by: 'detector' }"), detector, "data: { role: 'office', by: 'detector' }", 'detector must write role and by');
    assertAt(readFileSync(functions, 'utf8').includes('const role = dataObject(current).role;'), functions, 'dataObject(current).role', 'Function must read the written role field');
    const invalidRoleSync = fakeSync([{ uniqueName: `c0-transfer-${makeCallSid('c')}`, data: { role: 'invalid', by: 'agent' } }]);
    const invalidRoleResult = invoke(dialAction.handler, functionContextFake(invalidRoleSync), {
      ParentCallSid: makeCallSid('c'), DialCallStatus: 'completed', DialCallDuration: '1',
    }).then((twiml) => assert.match(twiml, /<Redirect>\/fallback<\/Redirect>/, 'invalid transfer roles must fail closed to fallback'));

    assertAt(readFileSync(transfer, 'utf8').includes('c0-admitted-${'), transfer, 'c0-admitted-${', 'agent must write an admission document scoped to the parent CallSid');
    assertAt(readFileSync(transfer, 'utf8').includes("data: { admittedAt, by: 'agent' }"), transfer, "data: { admittedAt, by: 'agent' }", 'agent admission document must carry a timestamp and writer identity');
    const workerSource = readFileSync(worker, 'utf8');
    assertAt(workerSource.indexOf('writeAdmission(') > workerSource.indexOf("if (!admission.admit)"), worker, 'writeAdmission(', 'agent must write admission only after all admission gates pass');
    assertAt(readFileSync(functions, 'utf8').includes('c0-admitted-${'), functions, 'c0-admitted-${', 'Function reader must use the same admission document name');
    const withoutAdmission = invoke(dialAction.handler, functionContextFake(fakeSync()), {
      ParentCallSid: makeCallSid('d'), DialCallStatus: 'completed', DialCallDuration: '1',
    }).then((twiml) => assert.match(twiml, /<Redirect>\/fallback<\/Redirect>/, 'a completed AI leg without admission proof must fail closed to fallback'));
    const withAdmission = invoke(dialAction.handler, functionContextFake(fakeSync([{
      uniqueName: `c0-admitted-${makeCallSid('e')}`, data: { admittedAt: 'test-time', by: 'agent' },
    }])), {
      ParentCallSid: makeCallSid('e'), DialCallStatus: 'completed', DialCallDuration: '1',
    }).then((twiml) => assert.match(twiml, /<Hangup\/>/, 'a completed AI leg with admission proof may hang up'));
    return Promise.all([invalidRoleResult, withoutAdmission, withAdmission]).then(() => undefined);
  });

  await contract('FALLBACK URL + ROLE', () => {
    const transfer = path.join(C0_ROOT, 'agent', 'src', 'transfer.ts');
    const detector = path.join(C0_ROOT, 'detector', 'src', 'detector.ts');
    const fallbackPrivate = path.join(FUNCTIONS_ROOT, 'lib', 'c0.private.js');
    assertAt(readFileSync(transfer, 'utf8').includes("url.searchParams.set('role', role)"), transfer, "url.searchParams.set('role', role)", 'agent fallback must set only the role query parameter');
    assertAt(readFileSync(detector, 'utf8').includes("parsed.searchParams.set('role', 'office')"), detector, "parsed.searchParams.set('role', 'office')", 'detector fallback must select office');
    assertAt(readFileSync(fallbackPrivate, 'utf8').includes("event && event.role === 'backup' ? 'backup' : 'office'"), fallbackPrivate, "event && event.role === 'backup'", 'Function parser must restrict roles to office or backup');
  });

  await contract('MARKERS', () => {
    const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'c0-integration-marker-')), 'repo');
    try {
      const defaultRoot = path.join(root, 'data', 'c0');
      const runtime = path.join(C0_ROOT, 'agent', 'src', 'runtime.ts');
      assert.equal(resolveDataRoot(), path.join(REPO_ROOT, 'data', 'c0'));
      assertAt(readFileSync(runtime, 'utf8').includes("return path.join(REPO_ROOT, 'data', 'c0');"), runtime, "return path.join(REPO_ROOT, 'data', 'c0');", 'agent default must use the shared data/c0 convention');
      assert.equal(resolveDetectorDataRoot({}, root), defaultRoot);
      assert.equal(resolveMonitorDataRoot({}, root), defaultRoot);
      const configured = path.join(root, 'shared-c0-data');
      assert.equal(resolveDataRoot(configured), configured);
      assert.equal(resolveDetectorDataRoot({ VOICE_C0_DATA_DIR: configured }, root), configured);
      assert.equal(resolveMonitorDataRoot({ VOICE_C0_DATA_DIR: configured }, root), configured);
      const sid = makeCallSid('a');
      new FileMarkerWriter(configured).mark('answered', sid);
      assert.ok(existsSync(path.join(configured, 'answered', sid)), 'agent writer and detector marker convention must address the same absolute path');
    } finally { rmSync(path.dirname(root), { recursive: true, force: true }); }
  });

  await contract('SIP HEADER', () => {
    const ingressFile = path.join(FUNCTIONS_ROOT, 'lib', 'c0.private.js');
    const provision = path.join(C0_ROOT, 'provision', 'livekit-sip.ts');
    const gate = path.join(C0_ROOT, 'agent', 'src', 'gate.ts');
    assertAt(readFileSync(ingressFile, 'utf8').includes('?X-C0-Call=${encodeURIComponent(callSid)}'), ingressFile, '?X-C0-Call=', 'ingress must emit the C0 call header');
    assertAt(readFileSync(provision, 'utf8').includes("'X-C0-Call': 'c0.callSid'"), provision, "'X-C0-Call': 'c0.callSid'", 'provisioning must map the exact gate attribute');
    assertAt(readFileSync(gate, 'utf8').includes("participant.attributes['c0.callSid']"), gate, "participant.attributes['c0.callSid']", 'agent gate must wait on the provisioned attribute');
  });

  await contract('AGENT NAME', () => {
    const worker = path.join(C0_ROOT, 'agent', 'src', 'worker.ts');
    const provision = path.join(C0_ROOT, 'provision', 'livekit-sip.ts');
    const agentName = readFileSync(worker, 'utf8').match(/export const AGENT_NAME = '([^']+)'/)?.[1];
    assert.ok(agentName, `${lineOf(worker, 'export const AGENT_NAME')} agent name must be explicit`);
    assertAt(readFileSync(worker, 'utf8').includes('agentName: AGENT_NAME'), worker, 'agentName: AGENT_NAME', 'ServerOptions must use the exported agent name');
    assertAt(readFileSync(provision, 'utf8').includes(`agentName: '${agentName}'`), provision, "agentName:", 'provisioned dispatch rule must target the same agent');
  });

  await contract('SIMULATED CALL', async () => {
    const sync = fakeSync();
    const parentCallSid = makeCallSid('a');
    const callback = fakeE164('001');
    const ingressTwiml = await invoke(ingress.handler, functionContextFake(sync), { From: callback, CallSid: parentCallSid });
    assert.match(ingressTwiml, /<Dial action="\/dial-action" timeout="20" answerOnBridge="true" timeLimit="480">/);
    assert.match(ingressTwiml, new RegExp(`X-C0-Call=${parentCallSid}`));
    const gated = evaluateGate({ kind: 'sip', attributes: { 'sip.trunkID': 'trunk', 'sip.ruleID': 'rule', 'c0.callSid': parentCallSid } }, { enabled: true, trunkId: 'trunk', ruleId: 'rule', sipKind: 'sip' });
    assert.deepEqual(gated, { ok: true, callSid: parentCallSid });

    const temp = mkdtempSync(path.join(os.tmpdir(), 'c0-integration-call-'));
    try {
      const outbox = new Outbox(path.join(temp, 'outbox.jsonl'));
      const controller = createC0Controller({ config: loadC0Config({ VOICE_C0_ENABLED: 'true', VOICE_C0_ALLOWLIST: callback }), outbox });
      const recorded = controller.enqueueServiceIntent({
        callSid: parentCallSid, callerE164: callback, intentSequence: 1, payloadVersion: 1,
        intent: { name: 'Taylor', callbackE164: callback, serviceAddress: 'Canary Street', scope: 'Outlet inspection', preferredWindows: 'Morning', callerConfirmed: true },
      });
      assert.equal(recorded.status, 'enqueued');
      const durable = outbox.list();
      assert.equal(durable.length, 1);
      assert.equal(durable[0].kind, 'service_intent');
      assert.equal(durable[0].payload.callbackE164, callback, 'durable controller record preserves the callback number');
      assert.doesNotMatch(JSON.stringify(outbox.snapshot()), new RegExp(callback.replace('+', '\\+')), 'operator snapshot must mask the callback number');

      const lifecycle: string[] = [];
      const redirectCalls: string[] = [];
      const transfer = await transferWithSync(sync.documentApi, { calls: () => ({ update: async ({ url }: { url: string }) => { redirectCalls.push(url); } }) }, { endAiLeg: async () => { lifecycle.push('ended'); } }, parentCallSid, 'office', 'https://functions.example.invalid/fallback');
      assert.deepEqual(transfer, { ok: true, role: 'office' });
      assert.deepEqual(sync.documents.get(`c0-transfer-${parentCallSid}`)?.data, { role: 'office', by: 'agent' });
      assert.deepEqual(lifecycle, ['ended']);
      assert.deepEqual(redirectCalls, []);

      const dialTwiml = await invoke(dialAction.handler, functionContextFake(sync), { ParentCallSid: parentCallSid, DialCallStatus: 'completed', DialCallDuration: '1' });
      assert.match(dialTwiml, /<Redirect>\/fallback\?role=office<\/Redirect>/);
      const officeTwiml = await invoke(fallback.handler, functionContextFake(sync), { role: 'office' });
      assert.match(officeTwiml, /fallback-next\?role=office/);
      const backupTwiml = await invoke(fallbackNext.handler, functionContextFake(sync), { role: 'office', DialBridged: 'false' });
      assert.match(backupTwiml, /<Redirect>\/fallback\?role=backup<\/Redirect>/);
      const voicemailTwiml = await invoke(fallbackNext.handler, functionContextFake(sync), { role: 'backup', DialBridged: 'false' });
      assert.match(voicemailTwiml, /<Record /);
      const sent: string[] = [];
      const recording = makeRecordingSid('b');
      await voicemailDone.postRedactedAlert('c0-integration-test', recording, parentCallSid, async (_url: string, options: { body: string }) => { sent.push(options.body); return {}; });
      assert.equal(sent.length, 1);
      assert.match(sent[0], new RegExp(recording));
      assert.doesNotMatch(sent[0], new RegExp(parentCallSid));
      assert.doesNotMatch(sent[0], /RecordingUrl|1555123/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  await contract('PM2', () => {
    const ecosystem = path.join(C0_ROOT, 'ecosystem.c0.config.cjs');
    const config = createRequire(ecosystem)(ecosystem) as { apps?: Array<{ name?: string; script?: string; args?: string[] }> };
    assert.ok(Array.isArray(config.apps) && config.apps.length > 0, `${lineOf(ecosystem, 'apps:')} PM2 config must define C0 apps`);
    for (const app of config.apps ?? []) {
      assert.ok(typeof app.script === 'string' && existsSync(app.script), `${ecosystem}:${app.name ?? 'unknown'} script does not resolve to an existing file`);
      const entry = app.args?.[0];
      assert.ok(typeof entry === 'string' && existsSync(path.resolve(REPO_ROOT, entry)), `${ecosystem}:${app.name ?? 'unknown'} entry does not resolve to an existing file`);
    }
  });

  if (failures.length > 0) {
    throw new Error(`cross-component contract failures:\n${failures.map((failure) => `- ${failure.contract}: ${failure.message}`).join('\n')}`);
  }
  console.log('cross-component.check OK');
}

void main();
