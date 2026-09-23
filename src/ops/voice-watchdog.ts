/**
 * One-shot watchdog for the public Grizzly voice line.
 *
 * Run with `npx tsx src/ops/voice-watchdog.ts`.  The systemd timer owns the
 * schedule; this module deliberately does not load dotenv so it never reads a
 * local .env file.  Production supplies the environment through EnvironmentFile.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { Resolver } from 'node:dns';
import { promises as nodeFs } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { formatOpsSms, sendOpsSms } from './alert.js';

const execFile = promisify(execFileCallback);
const RUN_DEADLINE_MS = 70_000;
const OPERATION_TIMEOUT_MS = 20_000;
const WATERMARK_OVERLAP_MS = 10 * 60_000;
const FAILURE_STATUSES = new Set(['busy', 'failed', 'no-answer', 'canceled']);
const RELAY_ALERT_CODES = new Set([64102, 64106, 64107, 11200, 11205, 12100]);
const MAX_SEEN = 500;
const MAX_RETRY_RECORDS = 100;
const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_BACKOFF_MINUTES = [2, 4, 8, 16, 32] as const;
const DROP_PATTERN = /Drop: TCP\{\[fd7a:[^\]]+\]:\d+ > \[[^\]]+\]:\d+\} \d+ no rules matched/;

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type ProbeResult = { ok: boolean; detail?: string };
export type AddressProbe = { twiml: ProbeResult; websocket: ProbeResult };
export type SourceStatus = 'ok' | 'failed' | 'unavailable' | 'incomplete';
export type ProbeStatus = 'ok' | 'failed' | 'untestable';

export type VoiceWatchdogState = {
  lastRunAt?: string;
  seenCallSids: string[];
  seenAlertSids: string[];
  seenIncidentKeys: string[];
  retryRecords: RetryRecord[];
  undeliverableIncidentKeys: string[];
  consecutiveProbeFailures: number;
  publicPathAlertOpen: boolean;
};

export type VoiceWatchdogConfig = {
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
  publicUrl: string;
  statePath: string;
  testCallers: string[];
};

export type WatchdogFs = {
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>;
  readFile: (file: string, encoding: 'utf8') => Promise<string>;
  rename: (from: string, to: string) => Promise<void>;
  writeFile: (file: string, value: string, encoding: 'utf8') => Promise<void>;
};

export type VoiceWatchdogDeps = {
  config: VoiceWatchdogConfig;
  fetchImpl: typeof fetch;
  resolvePublic: (host: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;
  probeAddress: (voiceUrl: URL, address: ResolvedAddress, signal?: AbortSignal) => Promise<AddressProbe>;
  now: () => Date;
  fs: WatchdogFs;
  exec: (command: string, args: string[], signal?: AbortSignal) => Promise<{ stdout: string }>;
  deliverAlert: (title: string, body: string, signal?: AbortSignal) => Promise<AlertDeliveryStatus>;
  log: (message: string) => void;
  /** Test-only override; production always uses the fixed 70 second deadline. */
  runDeadlineMs?: number;
};

export type WatchdogRunResult = {
  ok: boolean;
  exitCode: number;
  failuresFound: number;
  drops: number | null;
  probes: Array<{ address: ResolvedAddress; twiml: ProbeResult; websocket: ProbeResult; status: ProbeStatus }>;
  alertsSent: string[];
  state: VoiceWatchdogState;
  sources: { calls: SourceStatus; alerts: SourceStatus; probe: SourceStatus; journal: SourceStatus };
  deadlineHit: boolean;
  unattributedAlerts: Array<{ errorCode: number; alertSidMasked: string }>;
  undeliverableAlerts: number;
  lastDelivery: AlertDeliveryStatus | null;
  dryRunSummary?: VoiceWatchdogDryRunSummary;
};

export type VoiceWatchdogDryRunSummary = {
  dryRun: true;
  watermarkFrom: string;
  failuresFound: Array<{ callSidMasked: string; statusOrCode: string | number; whenChicago: string; callerLast4: string; label: string }>;
  wouldAlert: string[];
  probe: Record<string, { twiml: boolean; ws: boolean }>;
  drops: number | null;
};

export type VoiceWatchdogRunOptions = {
  dryRun?: boolean;
  since?: Date;
};

type TwilioCall = {
  sid?: string;
  from?: string;
  to?: string;
  status?: string;
  duration?: string | number | null;
  start_time?: string;
  parent_call_sid?: string;
  direction?: string;
};

type TwilioAlert = {
  sid?: string;
  resource_sid?: string;
  error_code?: string | number;
  request_url?: string;
  date_created?: string;
};

type Failure = {
  id: string;
  source: 'call' | 'monitor';
  caller: string;
  at: Date;
  status?: string;
  errorCode?: number;
  lineCheck: boolean;
  callSid?: string;
  alertSid?: string;
  callSids: string[];
  alertSids: string[];
  incidentKey: string;
};

type RetryRecord = {
  incidentKey: string;
  attempts: number;
  nextAttemptAt: string;
  title: string;
  body: string;
  callSids: string[];
  alertSids: string[];
};

export type AlertDeliveryStatus = {
  delivered: boolean;
  sms: 'sent' | 'failed' | 'not-configured';
  ntfy: 'sent' | 'failed' | 'not-configured';
};

class DeadlineError extends Error {
  constructor() { super('watchdog deadline exceeded'); this.name = 'DeadlineError'; }
}

class IncompleteReadError extends Error {
  constructor() { super('Twilio collection incomplete before the run deadline'); this.name = 'IncompleteReadError'; }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : undefined;
}

function errorClass(error: unknown): string {
  return errorCode(error) ?? (error instanceof DeadlineError ? 'deadline' : error instanceof Error ? error.name : 'unknown');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DeadlineError || errorCode(error) === 'ABORT_ERR' || (error instanceof Error && error.name === 'AbortError');
}

async function bounded<T>(parent: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent.aborted) throw new DeadlineError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
  const abortParent = () => controller.abort();
  parent.addEventListener('abort', abortParent, { once: true });
  try {
    const abort = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => {
      reject(parent.aborted ? new DeadlineError() : Object.assign(new Error('operation timed out'), { code: 'ABORT_ERR' }));
    }, { once: true }));
    return await Promise.race([operation(controller.signal), abort]);
  } catch (error) {
    if (parent.aborted) throw new DeadlineError();
    throw error;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abortParent);
  }
}

function emptyState(): VoiceWatchdogState {
  return { seenCallSids: [], seenAlertSids: [], seenIncidentKeys: [], retryRecords: [], undeliverableIncidentKeys: [], consecutiveProbeFailures: 0, publicPathAlertOpen: false };
}

function uniqueBounded(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].slice(-MAX_SEEN);
}

export function normalizeState(value: unknown): VoiceWatchdogState {
  if (!value || typeof value !== 'object') return emptyState();
  const state = value as Partial<VoiceWatchdogState>;
  const retryRecords = Array.isArray(state.retryRecords) ? state.retryRecords.filter((record): record is RetryRecord => {
    if (!record || typeof record !== 'object') return false;
    const candidate = record as Partial<RetryRecord>;
    return typeof candidate.incidentKey === 'string' && Number.isInteger(candidate.attempts)
      && typeof candidate.nextAttemptAt === 'string' && typeof candidate.title === 'string'
      && typeof candidate.body === 'string' && Array.isArray(candidate.callSids) && Array.isArray(candidate.alertSids);
  }).slice(-MAX_RETRY_RECORDS) : [];
  return {
    lastRunAt: typeof state.lastRunAt === 'string' ? state.lastRunAt : undefined,
    seenCallSids: Array.isArray(state.seenCallSids) ? uniqueBounded(state.seenCallSids.filter((x): x is string => typeof x === 'string')) : [],
    seenAlertSids: Array.isArray(state.seenAlertSids) ? uniqueBounded(state.seenAlertSids.filter((x): x is string => typeof x === 'string')) : [],
    seenIncidentKeys: Array.isArray(state.seenIncidentKeys) ? uniqueBounded(state.seenIncidentKeys.filter((x): x is string => typeof x === 'string')) : [],
    retryRecords,
    undeliverableIncidentKeys: Array.isArray(state.undeliverableIncidentKeys) ? uniqueBounded(state.undeliverableIncidentKeys.filter((x): x is string => typeof x === 'string')) : [],
    consecutiveProbeFailures: Number.isInteger(state.consecutiveProbeFailures) && Number(state.consecutiveProbeFailures) >= 0
      ? Number(state.consecutiveProbeFailures) : 0,
    publicPathAlertOpen: state.publicPathAlertOpen === true,
  };
}

export async function readState(fs: WatchdogFs, statePath: string): Promise<{ state: VoiceWatchdogState; corrupt: boolean }> {
  try {
    return { state: normalizeState(JSON.parse(await fs.readFile(statePath, 'utf8'))), corrupt: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: emptyState(), corrupt: code !== 'ENOENT' };
  }
}

export async function writeJsonAtomic(fs: WatchdogFs, file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

export function redactPhoneNumbers(value: string): string {
  return value.replace(/\+?\d[\d\s().-]{6,}\d/g, (phone) => {
    const digits = phone.replace(/\D/g, '');
    return digits.length < 7 ? phone : `***${digits.slice(-4)}`;
  });
}

export function countIngressDrops(journal: string): number {
  return journal.split(/\r?\n/).filter((line) => DROP_PATTERN.test(line)).length;
}

export function classifyFailedCall(call: TwilioCall): boolean {
  const status = String(call.status ?? '').toLowerCase();
  return FAILURE_STATUSES.has(status) || (status === 'completed' && Number(call.duration) === 0);
}

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function watermarkFor(state: VoiceWatchdogState, now: Date): Date {
  const saved = validDate(state.lastRunAt);
  if (saved && saved <= now) return new Date(saved.getTime() - WATERMARK_OVERLAP_MS);
  return new Date(now.getTime() - 30 * 60_000);
}

function centralTime(at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(at);
}

function maskedIdentifier(value: string): string {
  return value.length <= 4 ? '****' : `${value.slice(0, 2)}***${value.slice(-4)}`;
}

function callerLast4(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : 'unknown';
}

function isAfterWatermark(at: Date, watermark: Date): boolean {
  return at.getTime() >= watermark.getTime();
}

function basicAuth(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

/**
 * Watchdog-local delivery is intentionally observable.  Do not route through
 * sendOpsAlert: it deliberately swallows per-channel failures for other callers.
 */
export async function deliverWatchdogAlert(
  title: string, body: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<AlertDeliveryStatus> {
  const channelFetch: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal });
  const topic = process.env.OPS_NTFY_TOPIC || process.env.NTFY_TOPIC || '';
  const sms = await sendOpsSms(formatOpsSms(title, body), { fetchImpl: channelFetch });
  let ntfy: AlertDeliveryStatus['ntfy'] = 'not-configured';
  if (topic) {
    try {
      const response: Response = await channelFetch(`${process.env.NTFY_URL || 'https://ntfy.sh'}/${topic}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Title: title.replace(/[^\x20-\xff]/g, '').trim(),
          Priority: 'urgent',
          Tags: 'rotating_light',
        },
        body,
      });
      ntfy = response.ok ? 'sent' : 'failed';
    } catch {
      ntfy = 'failed';
    }
  }
  const smsStatus: AlertDeliveryStatus['sms'] = sms.sent ? 'sent' : sms.reason === 'not-configured' ? 'not-configured' : 'failed';
  return { delivered: smsStatus === 'sent' || ntfy === 'sent', sms: smsStatus, ntfy };
}

async function fetchJsonPages<T>(
  deps: VoiceWatchdogDeps, firstUrl: URL, accountSid: string, authToken: string, field: string, signal: AbortSignal,
): Promise<T[]> {
  const result: T[] = [];
  let next: URL | null = firstUrl;
  let continuationSeen = false;
  try {
    while (next) {
      const pageUrl: URL = next;
      const json: Record<string, unknown> = await bounded(signal, (operationSignal) => fetchJsonRecord(deps, pageUrl, {
        headers: { Authorization: basicAuth(accountSid, authToken) },
      }, operationSignal));
      if (Array.isArray(json[field])) result.push(...json[field] as T[]);
      const nextPage: string | null = typeof json.next_page_uri === 'string' && json.next_page_uri ? json.next_page_uri : null;
      continuationSeen ||= !!nextPage;
      next = nextPage ? new URL(nextPage, pageUrl.origin) : null;
    }
  } catch (error) {
    if (continuationSeen && isAbortError(error)) throw new IncompleteReadError();
    throw error;
  }
  return result;
}

/** Keep the fetch controller alive until its body has been consumed or cancelled. */
async function fetchJsonRecord(
  deps: VoiceWatchdogDeps, url: URL, init: RequestInit, operationSignal: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let response: Response | undefined;
  const abort = (): void => {
    controller.abort();
    if (response?.body) void response.body.cancel().catch(() => undefined);
  };
  operationSignal.addEventListener('abort', abort, { once: true });
  try {
    response = await deps.fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`Twilio HTTP ${response.status}`);
    const json: unknown = await response.json();
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Twilio response was not an object');
    return json as Record<string, unknown>;
  } finally {
    operationSignal.removeEventListener('abort', abort);
  }
}

async function listTwilioCalls(deps: VoiceWatchdogDeps, watermark: Date, signal: AbortSignal): Promise<TwilioCall[]> {
  const { accountSid, authToken, phoneNumber } = deps.config;
  if (!accountSid || !authToken || !phoneNumber) throw new Error('Twilio voice credentials or number are not configured');
  const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`);
  url.searchParams.set('To', phoneNumber);
  url.searchParams.set('StartTime>=', watermark.toISOString());
  url.searchParams.set('PageSize', '1000');
  return fetchJsonPages<TwilioCall>(deps, url, accountSid, authToken, 'calls', signal);
}

async function listTwilioAlerts(deps: VoiceWatchdogDeps, watermark: Date, signal: AbortSignal): Promise<TwilioAlert[]> {
  const { accountSid, authToken } = deps.config;
  if (!accountSid || !authToken) throw new Error('Twilio voice credentials are not configured');
  const url = new URL('https://monitor.twilio.com/v1/Alerts');
  url.searchParams.set('StartDate', watermark.toISOString());
  url.searchParams.set('PageSize', '1000');
  return fetchJsonPages<TwilioAlert>(deps, url, accountSid, authToken, 'alerts', signal);
}

async function fetchTwilioCall(deps: VoiceWatchdogDeps, sid: string, signal: AbortSignal): Promise<TwilioCall> {
  const { accountSid, authToken } = deps.config;
  if (!accountSid || !authToken) throw new Error('Twilio voice credentials are not configured');
  const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(sid)}.json`);
  return await bounded(signal, async (operationSignal): Promise<TwilioCall> =>
    await fetchJsonRecord(deps, url, { headers: { Authorization: basicAuth(accountSid, authToken) } }, operationSignal) as TwilioCall);
}

function matchingRelayAlert(alert: TwilioAlert, voiceHost: string): number | null {
  const code = Number(alert.error_code);
  if (!RELAY_ALERT_CODES.has(code) || !alert.request_url) return null;
  try { return new URL(alert.request_url).hostname.toLowerCase() === voiceHost.toLowerCase() ? code : null; } catch { return null; }
}

function isTestCaller(caller: string, testCallers: string[]): boolean {
  return testCallers.includes(caller);
}

function normalizedEndpoint(value: string | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function callStart(call: TwilioCall): Date | null {
  return validDate(call.start_time);
}

function incidentKeyFor(calls: TwilioCall[], at: Date): string {
  const parent = calls.map((call) => call.parent_call_sid).find(Boolean)
    ?? calls.map((call) => call.sid).find((sid) => !!sid && calls.some((call) => call.parent_call_sid === sid));
  if (parent) return `parent:${parent}`;
  const identity = createHash('sha256').update(`${normalizedEndpoint(calls[0]?.from)}|${normalizedEndpoint(calls[0]?.to)}`).digest('hex').slice(0, 16);
  return `near:${identity}:${at.getTime()}`;
}

function incidentWasSeen(failure: Failure, state: VoiceWatchdogState): boolean {
  if (state.seenIncidentKeys.includes(failure.incidentKey)) return true;
  if (failure.incidentKey.startsWith('parent:') && state.seenCallSids.includes(failure.incidentKey.slice('parent:'.length))) return true;
  if (failure.incidentKey.startsWith('near:')) {
    const [, identity, timestamp] = failure.incidentKey.split(':');
    return state.seenIncidentKeys.some((key) => {
      const [, seenIdentity, seenTimestamp] = key.split(':');
      return key.startsWith('near:') && seenIdentity === identity && Math.abs(Number(seenTimestamp) - Number(timestamp)) <= 5_000;
    });
  }
  // Migrate safely from the first watchdog state format while new incident keys accrue.
  return failure.callSids.some((sid) => state.seenCallSids.includes(sid)) || failure.alertSids.some((sid) => state.seenAlertSids.includes(sid));
}

function groupCallIncidents(calls: TwilioCall[], testCallers: string[]): Failure[] {
  const validCalls = calls.filter((call): call is TwilioCall & { sid: string; start_time: string } => !!call.sid && !!callStart(call));
  const parent = validCalls.map((_call, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]));
  const join = (left: number, right: number): void => { const a = root(left); const b = root(right); if (a !== b) parent[b] = a; };
  const bySid = new Map(validCalls.map((call, index) => [call.sid, index]));
  const byParent = new Map<string, number>();
  validCalls.forEach((call, index) => {
    if (!call.parent_call_sid) return;
    const directParent = bySid.get(call.parent_call_sid);
    if (directParent !== undefined) join(index, directParent);
    const sibling = byParent.get(call.parent_call_sid);
    if (sibling !== undefined) join(index, sibling);
    byParent.set(call.parent_call_sid, index);
  });
  for (let left = 0; left < validCalls.length; left += 1) {
    for (let right = left + 1; right < validCalls.length; right += 1) {
      const a = validCalls[left]; const b = validCalls[right];
      const from = normalizedEndpoint(a.from); const to = normalizedEndpoint(a.to);
      const sameEndpoints = !!from && !!to && from === normalizedEndpoint(b.from) && to === normalizedEndpoint(b.to);
      if (sameEndpoints && Math.abs(callStart(a)!.getTime() - callStart(b)!.getTime()) <= 5_000) join(left, right);
    }
  }
  const groups = new Map<number, TwilioCall[]>();
  validCalls.forEach((call, index) => groups.set(root(index), [...(groups.get(root(index)) ?? []), call]));
  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((a, b) => callStart(a)!.getTime() - callStart(b)!.getTime());
    const inbound = ordered.find((call) => String(call.direction ?? '').toLowerCase().startsWith('inbound'));
    const representative = inbound ?? ordered.find((call) => classifyFailedCall(call)) ?? ordered[0];
    const at = callStart(ordered[0])!;
    return {
      id: incidentKeyFor(ordered, at), source: 'call', caller: representative.from || ordered.find((call) => call.from)?.from || 'unknown',
      at, status: representative.status, lineCheck: ordered.some((call) => isTestCaller(call.from ?? '', testCallers)),
      callSid: representative.sid, alertSid: undefined, callSids: ordered.map((call) => call.sid!), alertSids: [], incidentKey: incidentKeyFor(ordered, at),
    };
  });
}

export type PublicDnsResolver = {
  setServers: (servers: string[]) => void;
  resolve4: (host: string) => Promise<string[]>;
  resolve6: (host: string) => Promise<string[]>;
  cancel: () => void;
};

function nodePublicDnsResolver(): PublicDnsResolver {
  const resolver = new Resolver();
  return {
    setServers: (servers) => resolver.setServers(servers),
    resolve4: (host) => new Promise((resolve, reject) => resolver.resolve4(host, (error, addresses) => error ? reject(error) : resolve(addresses))),
    resolve6: (host) => new Promise((resolve, reject) => resolver.resolve6(host, (error, addresses) => error ? reject(error) : resolve(addresses))),
    cancel: () => resolver.cancel(),
  };
}

export function createPublicDnsResolve(
  resolverFactory: () => PublicDnsResolver = nodePublicDnsResolver,
): (host: string, signal?: AbortSignal) => Promise<ResolvedAddress[]> {
  return async (host: string, signal?: AbortSignal) => {
    // One Resolver per lookup ensures an abort cancels only this c-ares request.
    const resolver = resolverFactory();
    // Do not use the host's resolver: on AIWA it may route through MagicDNS.
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    const controller = new AbortController();
    const abort = () => { controller.abort(); resolver.cancel(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const awaitDns = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const rejectAbort = () => reject(new DeadlineError());
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        operation.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', rejectAbort));
      });
      const [a, aaaa] = await Promise.allSettled([awaitDns(resolver.resolve4(host)), awaitDns(resolver.resolve6(host))]);
      if (signal?.aborted) throw new DeadlineError();
      const addresses: ResolvedAddress[] = [];
      if (a.status === 'fulfilled') addresses.push(...a.value.map((address) => ({ address, family: 4 as const })));
      if (aaaa.status === 'fulfilled') addresses.push(...aaaa.value.map((address) => ({ address, family: 6 as const })));
      if (!addresses.length) throw new Error('public DNS did not return A or AAAA records');
      return addresses;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  };
}

function requestProbe(options: https.RequestOptions, validate: (status: number, body: string) => boolean, signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => { if (!settled) { settled = true; resolve(result); } };
    const request = https.request(options, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body = (body + chunk).slice(0, 64 * 1024); });
      response.on('end', () => finish(validate(response.statusCode ?? 0, body)
        ? { ok: true } : { ok: false, detail: `HTTP ${response.statusCode ?? 0}` }));
    });
    const abort = () => request.destroy(Object.assign(new Error('deadline'), { code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', abort, { once: true });
    request.setTimeout(OPERATION_TIMEOUT_MS, () => request.destroy(new Error('timeout')));
    request.on('upgrade', (response, socket) => {
      socket.destroy(); // A handshake check only; never send relay traffic.
      finish(validate(response.statusCode ?? 0, '') ? { ok: true } : { ok: false, detail: `HTTP ${response.statusCode ?? 0}` });
    });
    request.on('error', (error) => finish({ ok: false, detail: `${errorCode(error) ?? error.message}`.slice(0, 120) }));
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.end();
  });
}

export async function probePublicAddress(voiceUrl: URL, address: ResolvedAddress, signal?: AbortSignal): Promise<AddressProbe> {
  const port = voiceUrl.port ? Number(voiceUrl.port) : 443;
  const common: https.RequestOptions = {
    hostname: address.address, family: address.family, port, servername: voiceUrl.hostname,
    rejectUnauthorized: true, headers: { Host: voiceUrl.host },
  };
  const twiml = requestProbe({ ...common, method: 'POST', path: '/twiml', headers: { ...common.headers, 'Content-Length': '0' } },
    (status, body) => status === 200 && body.includes('<ConversationRelay'), signal);
  const websocket = requestProbe({
    ...common, method: 'GET', path: '/ws', headers: {
      ...common.headers, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    },
  }, (status) => status === 101, signal);
  const [twimlResult, websocketResult] = await Promise.all([twiml, websocket]);
  return { twiml: twimlResult, websocket: websocketResult };
}

function dropSummary(drops: number | null): string {
  return drops === null ? 'unavailable' : String(drops);
}

function failureAlertBody(failure: Failure, drops: number | null): string {
  return [
    `Caller: ${failure.caller || 'unknown'}`,
    `Time: ${centralTime(failure.at)}`,
    failure.lineCheck ? 'Classification: line check' : 'Classification: customer call',
    failure.status ? `Call status: ${failure.status}` : '',
    failure.errorCode ? `Twilio error code: ${failure.errorCode}` : '',
    `Tailscale ingress drops since last run: ${dropSummary(drops)}`,
    'Action: call the customer back.',
  ].filter(Boolean).join('\n');
}

function sourceStatus(result: PromiseSettledResult<unknown>): SourceStatus {
  if (result.status === 'fulfilled') return 'ok';
  return result.reason instanceof IncompleteReadError ? 'incomplete' : 'failed';
}

function probeStatus(address: ResolvedAddress, probe: AddressProbe): ProbeStatus {
  if (probe.twiml.ok && probe.websocket.ok) return 'ok';
  const localIpv6Error = address.family === 6 && [probe.twiml, probe.websocket].some((result) =>
    ['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].some((code) => result.detail?.includes(code)));
  return localIpv6Error ? 'untestable' : 'failed';
}

function isReachablePublicFailure(probe: { address: ResolvedAddress; twiml: ProbeResult; websocket: ProbeResult; status: ProbeStatus }): boolean {
  if (probe.status !== 'failed') return false;
  if (probe.address.family === 4) return true;
  return [probe.twiml, probe.websocket].some((result) => result.detail?.startsWith('HTTP '));
}

export async function runVoiceWatchdog(deps: VoiceWatchdogDeps, options: VoiceWatchdogRunOptions = {}): Promise<WatchdogRunResult> {
  const now = deps.now();
  const { state, corrupt } = await readState(deps.fs, deps.config.statePath);
  const watermark = options.since ?? watermarkFor(state, now);
  const voiceUrl = new URL(deps.config.publicUrl);
  const alertsSent: string[] = [];
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), deps.runDeadlineMs ?? RUN_DEADLINE_MS);
  if (corrupt && !options.dryRun) deps.log('[voice-watchdog] state was unreadable; using the last 30 minutes only');

  try {
    const [callsResult, alertsResult, journalResult, dnsResult] = await Promise.allSettled([
      listTwilioCalls(deps, watermark, deadline.signal), listTwilioAlerts(deps, watermark, deadline.signal),
      bounded(deadline.signal, (signal) => deps.exec('journalctl', ['-u', 'tailscaled', '--since', watermark.toISOString(), '--no-pager'], signal)),
      bounded(deadline.signal, (signal) => deps.resolvePublic(voiceUrl.hostname, signal)),
    ]);

    const sources = {
      calls: sourceStatus(callsResult), alerts: sourceStatus(alertsResult),
      journal: journalResult.status === 'fulfilled' ? 'ok' as SourceStatus : 'unavailable' as SourceStatus,
      probe: dnsResult.status === 'fulfilled' ? 'ok' as SourceStatus : 'failed' as SourceStatus,
    };
    const calls = callsResult.status === 'fulfilled' ? callsResult.value : [];
    const monitorAlerts = alertsResult.status === 'fulfilled' ? alertsResult.value : [];
    const drops = journalResult.status === 'fulfilled' ? countIngressDrops(journalResult.value.stdout) : null;
    const addresses = dnsResult.status === 'fulfilled' ? dnsResult.value : [];
    const probes = await Promise.all(addresses.map(async (address) => {
      try {
        const result = await bounded(deadline.signal, (signal) => deps.probeAddress(voiceUrl, address, signal));
        return { address, ...result, status: probeStatus(address, result) };
      } catch (error) {
        const detail = errorCode(error) ?? errorClass(error);
        const result: AddressProbe = { twiml: { ok: false, detail }, websocket: { ok: false, detail } };
        return { address, ...result, status: probeStatus(address, result) };
      }
    }));
    if (sources.probe === 'ok' && probes.some((probe) => probe.status === 'failed')) sources.probe = 'failed';

    const twilioInitiallyComplete = sources.calls === 'ok' && sources.alerts === 'ok';
    let monitorLookupComplete = true;
    const failedCalls = twilioInitiallyComplete ? calls.filter((call) => {
      const at = validDate(call.start_time);
      return classifyFailedCall(call) && !!call.sid && !!at && isAfterWatermark(at, watermark);
    }) : [];
    const allCallsBySid = new Map(calls.filter((call): call is TwilioCall & { sid: string } => !!call.sid).map((call) => [call.sid, call]));
    const relevantMonitorAlerts: Array<{ alert: TwilioAlert; code: number; at: Date }> = [];
    if (twilioInitiallyComplete) for (const alert of monitorAlerts) {
      const at = validDate(alert.date_created);
      const code = matchingRelayAlert(alert, voiceUrl.hostname);
      if (alert.sid && at && code && isAfterWatermark(at, watermark)) relevantMonitorAlerts.push({ alert, code, at });
    }

    // Monitor Alerts name the affected CallSid in resource_sid, not in call_sid.
    // A missing resource is unattributed, not an incomplete collection: Calls remain
    // the primary missed-call signal and the alert SID is safely deduped.
    const unattributedAlerts: Array<{ errorCode: number; alertSidMasked: string }> = [];
    for (const item of relevantMonitorAlerts.filter(({ alert }) => !alert.resource_sid)) {
      const sid = item.alert.sid!;
      if (!state.seenAlertSids.includes(sid)) {
        unattributedAlerts.push({ errorCode: item.code, alertSidMasked: maskedIdentifier(sid) });
        if (!options.dryRun) state.seenAlertSids = uniqueBounded([...state.seenAlertSids, sid]);
        deps.log(`[voice-watchdog] unattributed Monitor Alert sid=${maskedIdentifier(sid)} code=${item.code}`);
      }
    }
    const fetchedByResourceSid = new Map<string, TwilioCall>();
    const resourceSids = [...new Set(relevantMonitorAlerts.map(({ alert }) => alert.resource_sid).filter((sid): sid is string => !!sid && !allCallsBySid.has(sid)))];
    const fetched = await Promise.allSettled(resourceSids.map(async (sid) => [sid, await fetchTwilioCall(deps, sid, deadline.signal)] as const));
    for (const result of fetched) {
      if (result.status === 'fulfilled' && result.value[1].sid) fetchedByResourceSid.set(result.value[0], result.value[1]);
      else monitorLookupComplete = false;
    }
    if (!monitorLookupComplete) sources.alerts = 'incomplete';

    const incidentCalls = [...failedCalls];
    if (monitorLookupComplete) for (const { alert, at } of relevantMonitorAlerts) {
      const resourceSid = alert.resource_sid;
      const call = resourceSid ? allCallsBySid.get(resourceSid) ?? fetchedByResourceSid.get(resourceSid) : undefined;
      if (call?.sid && !incidentCalls.some((existing) => existing.sid === call.sid)) incidentCalls.push({ ...call, start_time: call.start_time ?? at.toISOString() });
    }

    const incidents = monitorLookupComplete ? groupCallIncidents(incidentCalls, deps.config.testCallers) : [];
    const incidentByCallSid = new Map(incidents.flatMap((incident) => incident.callSids.map((sid) => [sid, incident])));
    if (monitorLookupComplete) for (const item of relevantMonitorAlerts) {
      if (!item.alert.resource_sid) continue;
      const incident = item.alert.resource_sid ? incidentByCallSid.get(item.alert.resource_sid) : undefined;
      if (!incident) { monitorLookupComplete = false; sources.alerts = 'incomplete'; break; }
      incident.errorCode ??= item.code;
      incident.alertSid ??= item.alert.sid;
      incident.alertSids.push(item.alert.sid!);
    }

    const pendingIncidentKeys = new Set(state.retryRecords.map((record) => record.incidentKey));
    const failures = monitorLookupComplete ? incidents.filter((incident) => !incidentWasSeen(incident, state)
      && !pendingIncidentKeys.has(incident.incidentKey) && !state.undeliverableIncidentKeys.includes(incident.incidentKey)) : [];
    let alertDeliveryFailed = false;
    let lastDelivery: AlertDeliveryStatus | null = null;
    const dueRetries = state.retryRecords.filter((record) => new Date(record.nextAttemptAt) <= now);
    const retainedRetries = state.retryRecords.filter((record) => new Date(record.nextAttemptAt) > now);
    const deliveryAttempts: Array<{ incidentKey: string; attempts: number; title: string; body: string; callSids: string[]; alertSids: string[] }> = [
      ...failures.map((failure) => ({ incidentKey: failure.incidentKey, attempts: 0, title: 'Voice line: missed call', body: failureAlertBody(failure, drops), callSids: failure.callSids, alertSids: failure.alertSids })),
      ...dueRetries,
    ];
    for (const attempt of deliveryAttempts) {
      if (options.dryRun) { alertsSent.push(attempt.title); continue; }
      try { lastDelivery = await bounded(deadline.signal, (signal) => deps.deliverAlert(attempt.title, attempt.body, signal)); }
      catch { lastDelivery = { delivered: false, sms: 'failed', ntfy: 'failed' }; }
      if (lastDelivery.delivered) {
        alertsSent.push(attempt.title);
        state.seenCallSids = uniqueBounded([...state.seenCallSids, ...attempt.callSids]);
        state.seenAlertSids = uniqueBounded([...state.seenAlertSids, ...attempt.alertSids]);
        state.seenIncidentKeys = uniqueBounded([...state.seenIncidentKeys, attempt.incidentKey]);
        continue;
      }
      alertDeliveryFailed = true;
      const attempts = attempt.attempts + 1;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        state.undeliverableIncidentKeys = uniqueBounded([...state.undeliverableIncidentKeys, attempt.incidentKey]);
        state.seenCallSids = uniqueBounded([...state.seenCallSids, ...attempt.callSids]);
        state.seenAlertSids = uniqueBounded([...state.seenAlertSids, ...attempt.alertSids]);
        state.seenIncidentKeys = uniqueBounded([...state.seenIncidentKeys, attempt.incidentKey]);
        deps.log(`[voice-watchdog] alert given up incident=${maskedIdentifier(attempt.incidentKey)}`);
      } else {
        const delayMinutes = RETRY_BACKOFF_MINUTES[Math.min(attempts - 1, RETRY_BACKOFF_MINUTES.length - 1)];
        retainedRetries.push({ ...attempt, attempts, nextAttemptAt: new Date(now.getTime() + delayMinutes * 60_000).toISOString() });
      }
    }
    if (!options.dryRun) state.retryRecords = retainedRetries.slice(-MAX_RETRY_RECORDS);

    const publicFailures = probes.filter(isReachablePublicFailure);
    const publicPathFailing = publicFailures.length > 0;
    if (publicPathFailing) {
      state.consecutiveProbeFailures += 1;
      if (state.consecutiveProbeFailures >= 2 && !state.publicPathAlertOpen) {
        let publicDelivery: AlertDeliveryStatus | null = null;
        if (!options.dryRun) try { publicDelivery = await bounded(deadline.signal, (signal) => deps.deliverAlert('Voice line: public path failing', [
          `Public host: ${voiceUrl.hostname}`, `Failed addresses: ${publicFailures.map((probe) => probe.address.address).join(', ')}`,
          `Tailscale ingress drops since last run: ${dropSummary(drops)}`, 'Action: investigate Funnel/tailscaled, then call any missed customers back.',
        ].join('\n'), signal)); } catch { alertDeliveryFailed = true; }
        lastDelivery = publicDelivery ?? lastDelivery;
        if (options.dryRun || publicDelivery?.delivered) { alertsSent.push('Voice line: public path failing'); state.publicPathAlertOpen = true; }
        else alertDeliveryFailed = true;
      }
    } else if (sources.probe === 'ok') {
      state.consecutiveProbeFailures = 0;
      if (state.publicPathAlertOpen) {
        let recoveryDelivery: AlertDeliveryStatus | null = null;
        if (!options.dryRun) try { recoveryDelivery = await bounded(deadline.signal, (signal) => deps.deliverAlert('Voice line: recovered', `Public path is healthy for ${voiceUrl.hostname}.\nTailscale ingress drops since last run: ${dropSummary(drops)}`, signal)); } catch { alertDeliveryFailed = true; }
        lastDelivery = recoveryDelivery ?? lastDelivery;
        if (options.dryRun || recoveryDelivery?.delivered) { alertsSent.push('Voice line: recovered'); state.publicPathAlertOpen = false; }
        else alertDeliveryFailed = true;
      }
    }

    const deadlineHit = deadline.signal.aborted;
    const twilioComplete = sources.calls === 'ok' && sources.alerts === 'ok';
    if (twilioComplete) state.lastRunAt = now.toISOString();
    const heartbeat = {
      at: now.toISOString(), ok: twilioComplete && sources.probe === 'ok' && sources.journal === 'ok' && !alertDeliveryFailed && !deadlineHit,
      sources, probe: probes.map((probe) => ({ address: probe.address.address, family: probe.address.family, twiml: probe.twiml.ok, websocket: probe.websocket.ok, status: probe.status })),
      failures_found: failures.length, drops, journal_error: journalResult.status === 'rejected' ? errorClass(journalResult.reason) : undefined,
      unattributedAlerts,
      undeliverableAlerts: state.undeliverableIncidentKeys.length,
      lastDelivery,
    };
    const exitCode = twilioComplete && !deadlineHit && !alertDeliveryFailed ? 0 : 1;
    if (options.dryRun) {
      return {
        ok: heartbeat.ok, exitCode, failuresFound: failures.length, drops, probes, alertsSent, state, sources, deadlineHit,
        unattributedAlerts, undeliverableAlerts: state.undeliverableIncidentKeys.length, lastDelivery,
        dryRunSummary: {
          dryRun: true, watermarkFrom: watermark.toISOString(),
        failuresFound: failures.map((failure) => ({
          callSidMasked: maskedIdentifier(failure.callSid ?? failure.alertSid ?? failure.id),
          statusOrCode: failure.errorCode ?? failure.status ?? 'unknown', whenChicago: centralTime(failure.at),
          callerLast4: callerLast4(failure.caller), label: failure.lineCheck ? 'line check' : 'customer',
        })),
        wouldAlert: alertsSent,
        probe: Object.fromEntries(probes.map((probe) => [probe.address.address, { twiml: probe.twiml.ok, ws: probe.websocket.ok }])),
        drops,
      },
    };
    }
    await writeJsonAtomic(deps.fs, deps.config.statePath, state);
    await writeJsonAtomic(deps.fs, path.join(path.dirname(deps.config.statePath), 'voice-watchdog-heartbeat.json'), heartbeat);
    deps.log(redactPhoneNumbers(`[voice-watchdog] ok=${heartbeat.ok} failures=${failures.length} drops=${dropSummary(drops)} probes=${probes.map((probe) => `${probe.address.address}:${probe.status}`).join(',') || 'dns-failed'}`));
    return { ok: heartbeat.ok, exitCode, failuresFound: failures.length, drops, probes, alertsSent, state, sources, deadlineHit,
      unattributedAlerts, undeliverableAlerts: state.undeliverableIncidentKeys.length, lastDelivery };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function envList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function parseVoiceWatchdogArgs(argv: string[]): { dryRun: boolean; since?: Date } {
  let dryRun = false;
  let since: Date | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--since') {
      const value = argv[++index];
      const parsed = value ? new Date(value) : new Date('invalid');
      if (Number.isNaN(parsed.getTime())) throw new Error('--since requires a valid ISO timestamp');
      since = parsed;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { dryRun, since };
}

async function main(): Promise<void> {
  const cli = parseVoiceWatchdogArgs(process.argv.slice(2));
  const dryRun = cli.dryRun || /^(true|1|yes)$/i.test(process.env.VOICE_WATCHDOG_DRY_RUN ?? '');
  if (cli.since && !dryRun) throw new Error('--since is supported only with --dry-run');
  if (/^(false|0|no)$/i.test(process.env.VOICE_WATCHDOG_ENABLED ?? 'true') && !dryRun) {
    console.log('[voice-watchdog] disabled by VOICE_WATCHDOG_ENABLED');
    return;
  }
  const publicUrl = process.env.VOICE_WATCHDOG_PUBLIC_URL || process.env.VOICE_PUBLIC_URL || 'https://voice.grizzlyelectrical.net';
  const statePath = path.resolve(process.cwd(), 'data/voice-watchdog-state.json');
  const result = await runVoiceWatchdog({
    config: {
      accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER, publicUrl, statePath,
      testCallers: envList(process.env.VOICE_WATCHDOG_TEST_CALLERS),
    },
    fetchImpl: fetch, resolvePublic: createPublicDnsResolve(), probeAddress: probePublicAddress,
    now: () => new Date(), fs: nodeFs,
    exec: async (command, args, signal) => { const output = await execFile(command, args, { maxBuffer: 2 * 1024 * 1024, signal }); return { stdout: output.stdout }; },
    deliverAlert: async (title, body, signal) => await deliverWatchdogAlert(title, body, signal), log: console.log,
  }, { dryRun, since: cli.since });
  if (dryRun) console.log(JSON.stringify(result.dryRunSummary));
  process.exit(result.exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error) => {
    console.error(`[voice-watchdog] failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
  });
}
