import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadC0Config, resolveOutboxPath } from '../../../src/agent/voice/c0-config.js';
import { Outbox } from '../../../src/agent/voice/outbox.js';
import { analyzeOutboxHealth, type StaleOutboxEntry, type StaleTier } from '../../../src/agent/voice/outbox-monitor.js';
import { resolveC0DataRoot, resolveMonitorRepoRoot, resolveMonitorStoragePaths } from './data-root.js';
import { loadMonitorEnv } from './env.js';

export interface MonitorFetch {
  (input: string, init: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<unknown>;
}

export type AlertTier = StaleTier | 'human_reconciliation_required';
export interface AlertCrossing { readonly id: string; readonly tier: AlertTier; }
export interface MonitorAlertStateLoad {
  readonly crossings: readonly AlertCrossing[];
  /** True only when a non-missing state file could not be trusted. */
  readonly unavailable: boolean;
}
export interface MonitorAlertState {
  load(): MonitorAlertStateLoad;
  save(crossings: readonly AlertCrossing[]): void;
}

function crossingKey(crossing: AlertCrossing): string {
  return JSON.stringify([crossing.id, crossing.tier]);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function isAlertCrossing(value: unknown): value is AlertCrossing {
  if (typeof value !== 'object' || value === null) return false;
  const parsed = value as { id?: unknown; tier?: unknown };
  if (Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'id') || !Object.hasOwn(parsed, 'tier')) return false;
  if (parsed.tier === 'human_reconciliation_required') return parsed.id === 'human_reconciliation_required';
  return typeof parsed.id === 'string'
    && /^ob_[a-f0-9]{20}$/.test(parsed.id)
    && (parsed.tier === 'stale' || parsed.tier === 'stale_repeat');
}

/** Separate, redacted monitor state: never the outbox and never caller data. */
export function createNodeMonitorAlertState(dataRoot: string): MonitorAlertState & { readonly filePath: string } {
  const filePath = path.join(dataRoot, 'monitor-alerts.jsonl');
  return {
    filePath,
    load() {
      let contents: string;
      try {
        contents = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        return { crossings: [], unavailable: !isMissingFile(error) };
      }

      const crossings: AlertCrossing[] = [];
      for (const line of contents.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isAlertCrossing(parsed)) return { crossings: [], unavailable: true };
          crossings.push(parsed);
        } catch {
          return { crossings: [], unavailable: true };
        }
      }
      return { crossings, unavailable: false };
    },
    save(crossings) {
      fs.mkdirSync(dataRoot, { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${crossings.map((crossing) => JSON.stringify({ id: crossing.id, tier: crossing.tier })).join('\n')}${crossings.length ? '\n' : ''}`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, filePath);
    },
  };
}

export interface MonitorDeps {
  readonly listRecords: () => ReturnType<Outbox['list']>;
  readonly now: () => Date;
  readonly fetchImpl: MonitorFetch;
  readonly log: (line: string) => void;
  readonly alertState: MonitorAlertState;
}

export interface MonitorConfig {
  readonly enabled: boolean;
  readonly staleAfterMs: number;
  readonly ntfyTopic: string | null;
}

function safeText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Sends at most one redacted alert for each policy crossing. This wrapper never
 * retries, appends, marks a status, or mutates the outbox: listRecords is the
 * sole store capability it receives.
 */
export function createCanaryOutboxMonitor(config: MonitorConfig, deps: MonitorDeps) {
  const loadedAlertState = deps.alertState.load();
  const alerted = new Map(loadedAlertState.crossings.map((crossing) => [crossingKey(crossing), crossing]));
  let stateWarningPending = loadedAlertState.unavailable;

  async function alert(entry: StaleOutboxEntry): Promise<void> {
    if (!config.ntfyTopic) return;
    await deps.fetchImpl(`https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`, {
      method: 'POST',
      headers: { Title: 'C0 outbox record is stale', Priority: 'high', Tags: 'warning,inbox_tray' },
      // `findStale` already omits payload/error. Do not add identifiers here.
      body: `A C0 outbox record crossed the ${entry.tier} stale threshold. Review the local C0 outbox; this alert includes no caller details.`,
    });
  }

  async function alertReconciliationRequired(): Promise<void> {
    if (!config.ntfyTopic) return;
    await deps.fetchImpl(`https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`, {
      method: 'POST',
      headers: { Title: 'C0 outbox requires human reconciliation', Priority: 'high', Tags: 'warning,inbox_tray' },
      body: 'One or more C0 outbox records require human reconciliation. Review the local C0 outbox; this alert includes no caller details.',
    });
  }

  function persistAlertState(): void {
    try { deps.alertState.save([...alerted.values()]); }
    catch { deps.log('[c0-monitor] could not persist redacted alert crossing state'); }
  }

  async function tick(): Promise<{ readonly stale: number; readonly alerted: number }> {
    if (!config.enabled) return { stale: 0, alerted: 0 };
    if (stateWarningPending) {
      deps.log('[c0-monitor] discarded unavailable redacted alert crossing state; alerting again');
      stateWarningPending = false;
    }
    const health = analyzeOutboxHealth(deps.listRecords(), deps.now(), config.staleAfterMs);
    const stale = health.stale;
    const reconciliation: AlertCrossing | null = health.counts.human_reconciliation_required > 0
      ? { id: 'human_reconciliation_required', tier: 'human_reconciliation_required' }
      : null;
    const active = new Set(stale.map((entry) => crossingKey({ id: entry.id, tier: entry.tier })));
    if (reconciliation) active.add(crossingKey(reconciliation));
    let stateChanged = false;
    for (const key of alerted.keys()) {
      if (!active.has(key)) { alerted.delete(key); stateChanged = true; }
    }

    let sent = 0;
    for (const entry of stale) {
      const crossing: AlertCrossing = { id: entry.id, tier: entry.tier };
      const key = crossingKey(crossing);
      if (alerted.has(key)) continue;
      // Record only in process memory. If alert delivery fails, no write occurs
      // and the next policy tick may attempt the alert again.
      try {
        await alert(entry);
        alerted.set(key, crossing);
        stateChanged = true;
        sent += 1;
        deps.log('[c0-monitor] sent redacted stale-outbox alert');
      } catch {
        deps.log('[c0-monitor] redacted stale-outbox alert delivery failed');
      }
    }
    if (reconciliation && !alerted.has(crossingKey(reconciliation))) {
      try {
        await alertReconciliationRequired();
        alerted.set(crossingKey(reconciliation), reconciliation);
        stateChanged = true;
        sent += 1;
        deps.log('[c0-monitor] sent redacted human-reconciliation alert');
      } catch {
        deps.log('[c0-monitor] redacted human-reconciliation alert delivery failed');
      }
    }
    if (stateChanged) persistAlertState();
    return { stale: stale.length, alerted: sent };
  }

  return { tick };
}

function loadRuntime(): { readonly config: MonitorConfig; readonly deps: MonitorDeps; readonly intervalMs: number } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env = loadMonitorEnv(path.resolve(here, '../.env.c0'));
  const repoRoot = resolveMonitorRepoRoot(here);
  // Validate the shared data-root configuration even though this process only
  // reads the separately configured outbox path.
  const dataRoot = resolveC0DataRoot(env, repoRoot);
  const c0 = loadC0Config(env);
  const storage = resolveMonitorStoragePaths(dataRoot, resolveOutboxPath(c0, repoRoot));
  const outbox = new Outbox(storage.outboxPath);
  return {
    config: { enabled: c0.enabled, staleAfterMs: c0.staleAfterMs, ntfyTopic: safeText(env.VOICE_C0_NTFY_TOPIC) },
    deps: { listRecords: () => outbox.list(), now: () => new Date(), fetchImpl: fetch as never, log: (line) => console.log(line), alertState: createNodeMonitorAlertState(path.dirname(storage.alertStatePath)) },
    intervalMs: c0.monitorIntervalMs,
  };
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const runtime = loadRuntime();
  const monitor = createCanaryOutboxMonitor(runtime.config, runtime.deps);
  void monitor.tick();
  setInterval(() => { void monitor.tick(); }, runtime.intervalMs);
  console.log('[c0-monitor] outbound outbox monitor started');
}
