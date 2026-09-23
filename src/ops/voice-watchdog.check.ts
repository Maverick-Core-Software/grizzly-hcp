/**
 * Offline checks for the voice-line watchdog. No network calls are permitted.
 *   npx tsx src/ops/voice-watchdog.check.ts
 */
import assert from 'node:assert/strict';
import {
  classifyFailedCall, countIngressDrops, createPublicDnsResolve, redactPhoneNumbers,
  deliverWatchdogAlert, parseVoiceWatchdogArgs, runVoiceWatchdog, type AddressProbe, type VoiceWatchdogDeps, type WatchdogFs,
} from './voice-watchdog.js';

type MemoryFiles = Map<string, string>;

function memoryFs(files: MemoryFiles): WatchdogFs {
  return {
    mkdir: async () => undefined,
    readFile: async (file: string) => {
      const value = files.get(file);
      if (value === undefined) { const error = Object.assign(new Error('not found'), { code: 'ENOENT' }); throw error; }
      return value;
    },
    writeFile: async (file: string, value: string) => { files.set(file, value); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
  };
}

const now = new Date('2026-09-23T17:00:00.000Z');
const statePath = 'data/voice-watchdog-state.json';

function call(sid: string, from = '+14695550123', status = 'busy', ageMinutes = 1) {
  return { sid, from, status, duration: '0', start_time: new Date(now.getTime() - ageMinutes * 60_000).toISOString() };
}

function baseDeps(files: MemoryFiles, options: {
  calls?: unknown[]; alerts?: unknown[]; addresses?: Array<{ address: string; family: 4 | 6 }>;
  probe?: AddressProbe; journal?: string; testCallers?: string[]; fetchedCalls?: Record<string, unknown>;
} = {}): { deps: VoiceWatchdogDeps; alertBodies: string[]; fetchUrls: string[]; probeFamilies: number[]; commands: string[]; writes: string[] } {
  const alertBodies: string[] = [];
  const fetchUrls: string[] = [];
  const probeFamilies: number[] = [];
  const commands: string[] = [];
  const writes: string[] = [];
  const deps: VoiceWatchdogDeps = {
    config: {
      accountSid: 'ACtest', authToken: 'token', phoneNumber: '+14695550000',
      publicUrl: 'https://voice.example.test:10000/twiml', statePath, testCallers: options.testCallers ?? [],
    },
    fetchImpl: (async (input) => {
      const url = String(input); fetchUrls.push(url);
      const match = url.match(/\/Calls\/([^/]+)\.json/);
      return {
        ok: true, status: 200,
        json: async () => url.includes('monitor.twilio.com') ? { alerts: options.alerts ?? [] }
          : match ? options.fetchedCalls?.[decodeURIComponent(match[1])] ?? {}
            : { calls: options.calls ?? [] },
      } as Response;
    }) as typeof fetch,
    resolvePublic: async () => ({
      addresses: options.addresses ?? [{ address: '203.0.113.10', family: 4 }],
      dns: { '1.1.1.1': { A: 'ok', AAAA: 'ok' }, '8.8.8.8': { A: 'ok', AAAA: 'ok' } },
    }),
    probeAddress: async (_url, address) => { probeFamilies.push(address.family); return options.probe ?? { twiml: { ok: true }, websocket: { ok: true } }; },
    now: () => now, fs: (() => {
      const fs = memoryFs(files);
      return { ...fs, writeFile: async (file: string, value: string) => { writes.push(file); await fs.writeFile(file, value, 'utf8'); }, rename: async (from: string, to: string) => { writes.push(to); await fs.rename(from, to); } };
    })(),
    exec: async (command, args) => { commands.push(`${command} ${args.join(' ')}`); return { stdout: options.journal ?? '' }; },
    deliverAlert: async (title, body) => {
      alertBodies.push(`${title}\n${body}`);
      return { delivered: true, slack: 'not-configured', sms: 'sent', ntfy: 'not-configured' };
    }, log: () => {},
  };
  return { deps, alertBodies, fetchUrls, probeFamilies, commands, writes };
}

// Failure classification includes each requested terminal status and completed/zero duration.
for (const status of ['busy', 'failed', 'no-answer', 'canceled']) assert.equal(classifyFailedCall({ status, duration: '42' }), true);
assert.equal(classifyFailedCall({ status: 'completed', duration: '0' }), true);
assert.equal(classifyFailedCall({ status: 'completed', duration: '7' }), false);
assert.equal(classifyFailedCall({ status: 'in-progress', duration: '0' }), false);

// A call failure is alerted once and CallSid state suppresses it on the next run.
{
  const files: MemoryFiles = new Map();
  const first = baseDeps(files, { calls: [call('CA1')] });
  await runVoiceWatchdog(first.deps);
  assert.equal(first.alertBodies.filter((body) => body.startsWith('Voice line: missed call')).length, 1);
  assert.match(first.alertBodies[0], /Caller: \+14695550123/);
  assert.match(first.alertBodies[0], /Action: call the customer back/);
  const second = baseDeps(files, { calls: [call('CA1')] });
  await runVoiceWatchdog(second.deps);
  assert.equal(second.alertBodies.length, 0, 'CallSid dedupe survives a later run');
  assert.ok(first.fetchUrls.some((url) => new URL(url).searchParams.has('StartTime>=')), 'calls query has the StartTime >= watermark filter');
  assert.ok(first.fetchUrls.some((url) => new URL(url).searchParams.has('StartDate')), 'monitor query has StartDate');
}

// A corrupt state resets safely, and the first-run 30 minute watermark excludes old failures.
{
  const files: MemoryFiles = new Map([[statePath, '{not json']]);
  const test = baseDeps(files, { calls: [call('CA-old', '+14695550099', 'busy', 31)] });
  await runVoiceWatchdog(test.deps);
  assert.equal(test.alertBodies.length, 0, 'corrupt state must not re-alert a failure older than 30 minutes');
  assert.doesNotThrow(() => JSON.parse(files.get(statePath)!));
}

// A relevant Monitor Alert without resource_sid is unattributed, deduped, and never becomes a callback alert.
{
  const files: MemoryFiles = new Map();
  const alert = { sid: 'NO1', error_code: 64102, request_url: 'https://voice.example.test:10000/ws', date_created: now.toISOString() };
  const first = baseDeps(files, { alerts: [alert] });
  const firstResult = await runVoiceWatchdog(first.deps);
  assert.equal(first.alertBodies.length, 0);
  assert.deepEqual(firstResult.unattributedAlerts, [{ errorCode: 64102, alertSidMasked: '****' }]);
  const second = baseDeps(files, { alerts: [alert] });
  const secondResult = await runVoiceWatchdog(second.deps);
  assert.equal(second.alertBodies.length, 0, 'alert SID dedupe survives a later run');
  assert.equal(secondResult.unattributedAlerts.length, 0);
}

// Live-shape fixture: an inbound leg, outbound API child leg, and resource_sid Monitor alert are one incident.
{
  const files: MemoryFiles = new Map();
  const start = new Date(now.getTime() - 60_000).toISOString();
  const inbound = { sid: 'CA-parent', from: '+14695550111', to: '+14695550000', direction: 'inbound', status: 'busy', duration: '0', start_time: start };
  const child = { sid: 'CA-child', parent_call_sid: 'CA-parent', from: '+14695550999', to: '+14695550000', direction: 'outbound-api', status: 'busy', duration: '0', start_time: start };
  const monitor = { sid: 'NO-parent-child', resource_sid: 'CA-child', error_code: 64102, request_url: 'https://voice.example.test:10000/ws', date_created: start };
  const test = baseDeps(files, { calls: [child, inbound], alerts: [monitor], testCallers: ['+14695550999'] });
  await runVoiceWatchdog(test.deps);
  assert.equal(test.alertBodies.length, 1, 'two call legs and their Monitor alert must produce one incident alert');
  assert.match(test.alertBodies[0], /Caller: \+14695550111/);
  assert.match(test.alertBodies[0], /Twilio error code: 64102/);
  assert.match(test.alertBodies[0], /Classification: line check/, 'any configured test-caller leg wins the incident label');
  const later = baseDeps(files, { calls: [child], alerts: [monitor] });
  await runVoiceWatchdog(later.deps);
  assert.equal(later.alertBodies.length, 0, 'a later sibling leg or alert must hit the incident dedupe key');
}

// Unrelated Twilio legs with the same From/To inside five seconds are also one incident.
{
  const files: MemoryFiles = new Map();
  const firstAt = new Date(now.getTime() - 60_000);
  const test = baseDeps(files, {
    calls: [
      { sid: 'CA-near-inbound', from: '+14695550222', to: '+14695550000', direction: 'inbound', status: 'busy', duration: '0', start_time: firstAt.toISOString() },
      { sid: 'CA-near-api', from: '+14695550222', to: '+14695550000', direction: 'outbound-api', status: 'busy', duration: '0', start_time: new Date(firstAt.getTime() + 4_000).toISOString() },
    ],
  });
  await runVoiceWatchdog(test.deps);
  assert.equal(test.alertBodies.length, 1, 'same From/To legs within five seconds must merge');
}

// A Monitor resource outside the list window is fetched by CallSid before it is labelled standalone.
{
  const files: MemoryFiles = new Map();
  const start = new Date(now.getTime() - 60_000).toISOString();
  const monitor = { sid: 'NO-off-window', resource_sid: 'CA-off-window', error_code: 64102, request_url: 'https://voice.example.test:10000/ws', date_created: start };
  const test = baseDeps(files, {
    alerts: [monitor],
    fetchedCalls: { 'CA-off-window': { sid: 'CA-off-window', from: '+14695550333', to: '+14695550000', direction: 'inbound', status: 'busy', duration: '0', start_time: start } },
  });
  await runVoiceWatchdog(test.deps);
  assert.equal(test.alertBodies.length, 1);
  assert.match(test.alertBodies[0], /Caller: \+14695550333/);
  assert.ok(test.fetchUrls.some((url) => url.includes('/Calls/CA-off-window.json')), 'missing resource call must be fetched by CallSid');
}

// Each public DNS server is queried independently, so NXDOMAIN from one cannot hide the other's answer.
{
  const servers: string[] = [];
  const calls: string[] = [];
  const resolve = createPublicDnsResolve(() => {
    let server = '';
    return {
      setServers: (value: string[]) => { server = value[0]; servers.push(server); },
      resolve4: async (host: string) => {
        calls.push(`${server}:A:${host}`);
        if (server === '1.1.1.1') throw Object.assign(new Error('NXDOMAIN'), { code: 'NXDOMAIN' });
        return ['203.0.113.10'];
      },
      resolve6: async (host: string) => { calls.push(`${server}:AAAA:${host}`); return ['2001:db8::10']; },
      cancel: () => {},
    };
  });
  const result = await resolve('voice.example.test');
  assert.deepEqual(result.addresses, [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::10', family: 6 }]);
  assert.deepEqual(servers.sort(), ['1.1.1.1', '1.1.1.1', '8.8.8.8', '8.8.8.8']);
  assert.equal(calls.filter((call) => call.includes(':A:')).length, 2);
  assert.equal(result.dns['1.1.1.1'].A, 'NXDOMAIN');
  assert.equal(result.dns['8.8.8.8'].A, 'ok');
}

// The second public resolver's A record makes the watchdog probe healthy despite the first NXDOMAIN.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files);
  test.deps.resolvePublic = createPublicDnsResolve(() => {
    let server = '';
    return {
      setServers: (value: string[]) => { server = value[0]; },
      resolve4: async () => {
        if (server === '1.1.1.1') throw Object.assign(new Error('NXDOMAIN'), { code: 'NXDOMAIN' });
        return ['203.0.113.10'];
      },
      resolve6: async () => [], cancel: () => {},
    };
  });
  const result = await runVoiceWatchdog(test.deps);
  assert.equal(result.sources.probe, 'ok');
  assert.equal(result.dns['1.1.1.1'].A, 'NXDOMAIN');
  assert.equal(result.dns['8.8.8.8'].A, 'ok');
}

// Every resolved address, including IPv6, gets a separate injected HTTPS + WS probe.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files, { addresses: [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::10', family: 6 }] });
  const result = await runVoiceWatchdog(test.deps);
  assert.deepEqual(test.probeFamilies, [4, 6]);
  assert.equal(result.probes.length, 2);
}

// Two bad path probes alert once; a later healthy run produces exactly one recovery alert.
{
  const files: MemoryFiles = new Map();
  const bad: AddressProbe = { twiml: { ok: false, detail: 'HTTP 502' }, websocket: { ok: true } };
  const first = baseDeps(files, { probe: bad }); await runVoiceWatchdog(first.deps);
  assert.equal(first.alertBodies.length, 0);
  const second = baseDeps(files, { probe: bad, journal: 'Drop: TCP{[fd7a::1]:80 > [fd7a::2]:45086} 80 no rules matched' }); await runVoiceWatchdog(second.deps);
  assert.match(second.alertBodies[0], /Voice line: public path failing/);
  assert.match(second.alertBodies[0], /Tailscale ingress drops since last run: 1/);
  const recovered = baseDeps(files); await runVoiceWatchdog(recovered.deps);
  assert.match(recovered.alertBodies[0], /Voice line: recovered/);
  const steady = baseDeps(files); await runVoiceWatchdog(steady.deps);
  assert.equal(steady.alertBodies.length, 0, 'recovery alert is sent only once');
}

assert.equal(countIngressDrops('Drop: TCP{[fd7a::1]:80 > [fd7a::2]:45086} 80 no rules matched\nnoise\nDrop: TCP{[fd7a::3]:443 > [fd7a::4]:2} 99 no rules matched'), 2);
assert.equal(countIngressDrops('Drop: TCP{[fd7a::1]:80 > [fd7a::2]:45086} no rules matched'), 0);
assert.equal(redactPhoneNumbers('caller +1 (469) 555-0123 and 469-555-0456'), 'caller ***0123 and ***0456');

// Test callers are intentionally distinguishable in Carter's alert, while their full callback value remains available there.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files, { calls: [call('CA-check', '+14695550999')], testCallers: ['+14695550999'] });
  await runVoiceWatchdog(test.deps);
  assert.match(test.alertBodies[0], /Caller: \+14695550999/);
  assert.match(test.alertBodies[0], /Classification: line check/);
}

// Dry run performs the reads but never sends alerts or writes state/heartbeat, and returns a redacted summary.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files, { calls: [call('CA-dryrun', '+14695550999')], journal: 'Drop: TCP{[fd7a::1]:80 > [fd7a::2]:45086} 80 no rules matched' });
  const result = await runVoiceWatchdog(test.deps, { dryRun: true });
  assert.equal(test.alertBodies.length, 0, 'dry run must not call the alert sender');
  assert.deepEqual(test.writes, [], 'dry run must not write state or heartbeat');
  assert.equal(result.dryRunSummary?.dryRun, true);
  assert.equal(result.dryRunSummary?.failuresFound[0]?.callerLast4, '0999');
  assert.equal(result.dryRunSummary?.failuresFound[0]?.callSidMasked, 'CA***yrun');
  assert.equal(result.dryRunSummary?.drops, 1);
  assert.deepEqual(result.dryRunSummary?.wouldAlert, ['Voice line: missed call']);
  assert.equal(result.dryRunSummary?.sources.probe, 'ok');
  assert.equal(result.dryRunSummary?.dns['1.1.1.1'].A, 'ok');
}

// --since is an explicit dry-run watermark override, never a normal-run setting.
{
  const since = parseVoiceWatchdogArgs(['--dry-run', '--since', '2026-09-23T12:34:56.000Z']);
  assert.equal(since.dryRun, true);
  assert.equal(since.since?.toISOString(), '2026-09-23T12:34:56.000Z');
  assert.equal(parseVoiceWatchdogArgs(['--since', '2026-09-23T12:34:56.000Z']).since?.toISOString(), '2026-09-23T12:34:56.000Z', 'env-driven dry run may also use --since');
  assert.throws(() => parseVoiceWatchdogArgs(['--dry-run', '--since', 'not-an-iso']), /valid ISO timestamp/);
}

{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files);
  const forced = new Date('2026-09-23T12:34:56.000Z');
  const result = await runVoiceWatchdog(test.deps, { dryRun: true, since: forced });
  const callsUrl = test.fetchUrls.find((url) => url.includes('/Calls.json'))!;
  assert.equal(new URL(callsUrl).searchParams.get('StartTime>='), forced.toISOString(), '--since is used as the Twilio watermark');
  assert.equal(result.dryRunSummary?.watermarkFrom, forced.toISOString());
}

// Normal reads overlap the saved watermark by ten minutes, so delayed Twilio rows stay eligible.
{
  const saved = new Date(now.getTime() - 5 * 60_000);
  const files: MemoryFiles = new Map([[statePath, JSON.stringify({ lastRunAt: saved.toISOString() })]]);
  const test = baseDeps(files);
  await runVoiceWatchdog(test.deps);
  const callsUrl = test.fetchUrls.find((url) => url.includes('/Calls.json'))!;
  assert.equal(new URL(callsUrl).searchParams.get('StartTime>='), new Date(saved.getTime() - 10 * 60_000).toISOString());
}

// A continuation interrupted before completion is explicitly incomplete and cannot advance the watermark.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files);
  let callsPages = 0;
  test.deps.fetchImpl = (async (input) => {
    const url = String(input);
    if (url.includes('/Calls.json')) {
      callsPages += 1;
      if (callsPages === 1) return { ok: true, status: 200, json: async () => ({ calls: [call('CA-page')], next_page_uri: '/2010-04-01/Accounts/ACtest/Calls.json?PageToken=next' }) } as Response;
      throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
    }
    return { ok: true, status: 200, json: async () => ({ alerts: [] }) } as Response;
  }) as typeof fetch;
  const result = await runVoiceWatchdog(test.deps);
  assert.equal(result.sources.calls, 'incomplete');
  assert.equal(result.exitCode, 1);
  assert.equal(result.state.lastRunAt, undefined);
  assert.equal(test.alertBodies.length, 0, 'partial Twilio data must not create a callback alert');
}

// IPv6 remains untestable when an IPv4 public probe verifies the voice path.
{
  const files: MemoryFiles = new Map();
  const first = baseDeps(files, { addresses: [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::10', family: 6 }] });
  first.deps.probeAddress = async (_url, address) => address.family === 6
    ? { twiml: { ok: false, detail: 'ENETUNREACH' }, websocket: { ok: false, detail: 'ENETUNREACH' } }
    : { twiml: { ok: true }, websocket: { ok: true } };
  const firstResult = await runVoiceWatchdog(first.deps);
  assert.equal(firstResult.probes.find((probe) => probe.address.family === 6)?.status, 'untestable');
  const second = baseDeps(files, { addresses: [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::10', family: 6 }] });
  second.deps.probeAddress = first.deps.probeAddress;
  await runVoiceWatchdog(second.deps);
  assert.equal(second.alertBodies.some((body) => body.startsWith('Voice line: public path failing')), false);
}

// With no A record and only unreachable IPv6, the source is unverified and alerts after two runs.
{
  const files: MemoryFiles = new Map();
  const options = { addresses: [{ address: '2001:db8::10', family: 6 as const }] };
  const first = baseDeps(files, options);
  first.deps.probeAddress = async () => ({ twiml: { ok: false, detail: 'ENETUNREACH' }, websocket: { ok: false, detail: 'ENETUNREACH' } });
  const firstResult = await runVoiceWatchdog(first.deps);
  assert.equal(firstResult.sources.probe, 'unverified');
  const second = baseDeps(files, options);
  second.deps.probeAddress = first.deps.probeAddress;
  await runVoiceWatchdog(second.deps);
  assert.match(second.alertBodies[0], /no testable public address — IPv4 A records missing or unreachable/);
}

// A total public DNS failure is an alertable path failure, not an empty successful probe.
{
  const resolver = createPublicDnsResolve(() => ({
    setServers: () => {},
    resolve4: async () => { throw Object.assign(new Error('NXDOMAIN'), { code: 'NXDOMAIN' }); },
    resolve6: async () => { throw Object.assign(new Error('NODATA'), { code: 'NODATA' }); },
    cancel: () => {},
  }));
  const files: MemoryFiles = new Map();
  const first = baseDeps(files); first.deps.resolvePublic = resolver;
  const firstResult = await runVoiceWatchdog(first.deps);
  assert.equal(firstResult.sources.probe, 'unverified');
  const second = baseDeps(files); second.deps.resolvePublic = resolver;
  await runVoiceWatchdog(second.deps);
  assert.match(second.alertBodies[0], /public DNS returned no records/);
  assert.equal(second.alertBodies.filter((body) => body.startsWith('Voice line: public path failing')).length, 1);
}

// Journal collection failure is visible as unavailable, never a fabricated zero-drop count.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files);
  test.deps.exec = async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); };
  const result = await runVoiceWatchdog(test.deps);
  assert.equal(result.drops, null);
  assert.equal(result.sources.journal, 'unavailable');
  const heartbeatFile = [...files.entries()].find(([file]) => file.endsWith('voice-watchdog-heartbeat.json'));
  const heartbeat = JSON.parse(heartbeatFile?.[1] ?? '');
  assert.equal(heartbeat.drops, null);
  assert.equal(heartbeat.sources.journal, 'unavailable');
}

// A Monitor resource lookup failure is incomplete, nonzero, and never claims an unknown customer callback.
{
  const files: MemoryFiles = new Map();
  const monitor = { sid: 'NO-resource-failure', resource_sid: 'CA-missing', error_code: 64102, request_url: 'https://voice.example.test:10000/ws', date_created: now.toISOString() };
  const test = baseDeps(files, { alerts: [monitor] });
  test.deps.fetchImpl = (async (input) => {
    const url = String(input);
    if (url.includes('/Calls/CA-missing.json')) return { ok: false, status: 503, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => url.includes('monitor.twilio.com') ? { alerts: [monitor] } : { calls: [] } } as Response;
  }) as typeof fetch;
  const result = await runVoiceWatchdog(test.deps);
  assert.equal(result.sources.alerts, 'incomplete');
  assert.equal(result.exitCode, 1);
  assert.equal(test.alertBodies.length, 0);
}

// A failed second incident retains only that incident; a later due retry never re-sends the delivered first incident.
{
  const files: MemoryFiles = new Map();
  const firstRun = baseDeps(files, { calls: [call('CA-delivered', '+14695550111'), call('CA-retry', '+14695550222')] });
  let attempts = 0;
  firstRun.deps.deliverAlert = async (title, body) => {
    firstRun.alertBodies.push(`${title}\n${body}`);
    attempts += 1;
    return attempts === 1
      ? { delivered: true, slack: 'not-configured', sms: 'sent', ntfy: 'failed' }
      : { delivered: false, slack: 'not-configured', sms: 'failed', ntfy: 'failed' };
  };
  const failed = await runVoiceWatchdog(firstRun.deps);
  assert.equal(failed.exitCode, 1, 'both-channel delivery failure must fail the run');
  assert.equal(failed.state.retryRecords.length, 1);
  assert.match(firstRun.alertBodies[0], /50111/);
  assert.match(firstRun.alertBodies[1], /50222/);
  const retryRun = baseDeps(files, { calls: [call('CA-delivered', '+14695550111'), call('CA-retry', '+14695550222')] });
  retryRun.deps.now = () => new Date(now.getTime() + 2 * 60_000);
  retryRun.deps.deliverAlert = async (title, body) => {
    retryRun.alertBodies.push(`${title}\n${body}`);
    return { delivered: true, slack: 'not-configured', sms: 'failed', ntfy: 'sent' };
  };
  await runVoiceWatchdog(retryRun.deps);
  assert.equal(retryRun.alertBodies.length, 1);
  assert.match(retryRun.alertBodies[0], /50222/);
  assert.doesNotMatch(retryRun.alertBodies[0], /50111/);
}

// Slack accepts only an HTTP 2xx response with {ok:true}, and then suppresses SMS fallback.
{
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const result = await deliverWatchdogAlert('Voice line: missed call', 'Caller: +14695550123', undefined, {
    env: { VOICE_WATCHDOG_SLACK_TOKEN: 'xoxb-test-token', VOICE_WATCHDOG_SLACK_CHANNEL: 'C-test' },
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }) as typeof fetch,
  });
  assert.equal(result.delivered, true);
  assert.equal(result.slack, 'accepted');
  assert.equal(requests.length, 1, 'accepted Slack must suppress SMS fallback');
  assert.equal(requests[0].url, 'https://slack.com/api/chat.postMessage');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { channel: 'C-test', text: '*Voice line: missed call*\nCaller: +14695550123', unfurl_links: false, unfurl_media: false });
}

// Slack API-level failure falls back to the existing SMS sender and can still deliver the incident.
{
  const urls: string[] = [];
  const result = await deliverWatchdogAlert('T', 'B', undefined, {
    env: { VOICE_WATCHDOG_SLACK_TOKEN: 'xoxb-test-token', OPS_TWILIO_ACCOUNT_SID: 'ACtest', OPS_TWILIO_AUTH_TOKEN: 'token', OPS_SMS_FROM: '+15551112222', OPS_SMS_TO: '+15553334444' },
    fetchImpl: (async (url) => {
      urls.push(String(url));
      return String(url).includes('slack.com')
        ? { ok: true, status: 200, json: async () => ({ ok: false, error: 'not_in_channel' }) } as Response
        : { ok: true, status: 201 } as Response;
    }) as typeof fetch,
  });
  assert.equal(result.slack, 'failed:not_in_channel');
  assert.equal(result.sms, 'sent');
  assert.equal(result.delivered, true);
  assert.equal(urls.length, 2);
}

// A failed Slack and SMS attempt keeps the incident on its existing retry path and redacts tokens everywhere persisted.
{
  const token = 'xoxb-secret-token';
  const delivery = await deliverWatchdogAlert('T', 'B', undefined, {
    env: { VOICE_WATCHDOG_SLACK_TOKEN: token, OPS_TWILIO_ACCOUNT_SID: 'ACtest', OPS_TWILIO_AUTH_TOKEN: 'token', OPS_SMS_FROM: '+15551112222', OPS_SMS_TO: '+15553334444' },
    fetchImpl: (async (url) => String(url).includes('slack.com')
      ? { ok: true, status: 200, json: async () => ({ ok: false, error: token }) } as Response
      : { ok: false, status: 503 } as Response) as typeof fetch,
  });
  assert.equal(delivery.delivered, false);
  assert.doesNotMatch(JSON.stringify(delivery), /xoxb-secret-token/);
  const files: MemoryFiles = new Map();
  const logs: string[] = [];
  const test = baseDeps(files, { calls: [call('CA-slack-retry')] });
  test.deps.deliverAlert = async () => delivery;
  test.deps.log = (message) => { logs.push(message); };
  const result = await runVoiceWatchdog(test.deps);
  assert.equal(result.state.retryRecords.length, 1);
  assert.doesNotMatch(`${logs.join('\n')}\n${[...files.values()].join('\n')}`, /xoxb-secret-token/);
}

// Without watchdog Slack configuration, delivery follows the existing SMS path.
{
  const urls: string[] = [];
  const result = await deliverWatchdogAlert('T', 'B', undefined, {
    env: { OPS_TWILIO_ACCOUNT_SID: 'ACtest', OPS_TWILIO_AUTH_TOKEN: 'token', OPS_SMS_FROM: '+15551112222', OPS_SMS_TO: '+15553334444' },
    fetchImpl: (async (url) => { urls.push(String(url)); return { ok: true, status: 201 } as Response; }) as typeof fetch,
  });
  assert.equal(result.slack, 'not-configured');
  assert.equal(result.sms, 'sent');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /Messages\.json/);
}

// Dry run does not invoke the delivery adapter, including its Slack path.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files, { calls: [call('CA-slack-dry')] });
  let slackCalls = 0;
  test.deps.deliverAlert = async () => { slackCalls += 1; return { delivered: true, slack: 'accepted', sms: 'not-configured', ntfy: 'not-configured' }; };
  await runVoiceWatchdog(test.deps, { dryRun: true });
  assert.equal(slackCalls, 0);
}

// A 101-incident outage leaves 100 bounded retries and explicitly gives up the overflow record.
{
  const files: MemoryFiles = new Map();
  const calls = Array.from({ length: 101 }, (_, index) => call(`CA-cap-${index}`, `+1469555${String(index).padStart(4, '0')}`));
  const logs: string[] = [];
  const first = baseDeps(files, { calls });
  first.deps.log = (message) => { logs.push(message); };
  first.deps.deliverAlert = async () => ({ delivered: false, slack: 'failed:network', sms: 'failed', ntfy: 'failed' });
  const failed = await runVoiceWatchdog(first.deps);
  assert.equal(failed.state.retryRecords.length, 100);
  assert.equal(failed.state.undeliverableIncidentKeys.length, 1);
  assert.equal(failed.state.retryRecords.length + failed.state.undeliverableIncidentKeys.length, 101);
  assert.match(logs.join('\n'), /alert retry capacity overflow count=1/);
  const retry = baseDeps(files, { calls });
  retry.deps.now = () => new Date(now.getTime() + 2 * 60_000);
  retry.deps.deliverAlert = async (title, body) => { retry.alertBodies.push(`${title}\n${body}`); return { delivered: false, slack: 'failed:network', sms: 'failed', ntfy: 'failed' }; };
  await runVoiceWatchdog(retry.deps);
  assert.equal(retry.alertBodies.length, 100, 'only retained records retry; the overflow incident is given up');
  assert.doesNotMatch(retry.alertBodies.join('\n'), /55550000/);
}

// A response body that never settles is cancelled by the deadline, not left as a leaked handle.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files);
  let bodyCancelled = false;
  let rejectBody: ((reason?: unknown) => void) | undefined;
  test.deps.runDeadlineMs = 20;
  test.deps.fetchImpl = (async (input) => {
    const url = String(input);
    if (url.includes('/Calls.json')) return {
      ok: true, status: 200,
      json: async () => await new Promise<Record<string, unknown>>((_resolve, reject) => { rejectBody = reject; }),
      body: { cancel: async () => { bodyCancelled = true; rejectBody?.(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); } },
    } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({ alerts: [] }) } as Response;
  }) as typeof fetch;
  const result = await runVoiceWatchdog(test.deps);
  assert.equal(result.deadlineHit, true);
  assert.equal(result.exitCode, 1);
  assert.equal(bodyCancelled, true, 'deadline must cancel a still-reading response body');
}

// A DNS request that never resolves is cancelled at the Resolver, and the run returns by the deadline.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files);
  let cancels = 0;
  test.deps.runDeadlineMs = 20;
  test.deps.resolvePublic = createPublicDnsResolve(() => ({
    setServers: () => {},
    resolve4: async () => await new Promise<string[]>(() => {}),
    resolve6: async () => await new Promise<string[]>(() => {}),
    cancel: () => { cancels += 1; },
  }));
  const result = await runVoiceWatchdog(test.deps);
  assert.equal(result.deadlineHit, true);
  assert.equal(result.exitCode, 1);
  assert.equal(cancels, 4, 'deadline must cancel every per-resolver, per-family query');
}

// The global deadline is an operational failure even when no individual source has returned.
{
  const files: MemoryFiles = new Map();
  const test = baseDeps(files);
  test.deps.runDeadlineMs = 1;
  test.deps.fetchImpl = ((_, init) => new Promise((_, reject) => {
    (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true });
  })) as typeof fetch;
  const result = await runVoiceWatchdog(test.deps);
  assert.equal(result.deadlineHit, true);
  assert.equal(result.exitCode, 1);
}

console.log('✓ voice watchdog self-check passed');
