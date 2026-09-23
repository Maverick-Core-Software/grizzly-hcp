/**
 * C0 voice canary — stale-outbox monitor (Stage 1 foundation).
 *
 * Binding design: docs/2026-09-22-c0-voice-canary-seam-audit.md §4.3, narrowed
 * for Stage 1 to a PURE REPORT.
 *
 * WHAT IT DOES
 *   Given outbox records and a clock reading, report the records that have sat
 *   unfinished past the stale threshold, plus the status counts behind that
 *   report. Reporting is the entire contract.
 *
 * WHAT IT MUST NEVER DO — this is the property the Stage 1 shape exists to prove
 *   * no retry and no re-attempt
 *   * no write of any kind: no status marker, no seen-file, no log sink
 *   * no delivery: no alert, no SMS, no webhook, no publish
 *   * no external call of any kind
 *   * no mutation of its input — records are read-only and the report is a new
 *     object graph
 *   The caller decides what, if anything, to do with a stale report. A
 *   supervised notifier is a later approved stage, not this module.
 *
 * NO RUNTIME IMPORTS — BY DESIGN
 *   This module's only import is `import type`, which is erased before the
 *   module loads. The monitor therefore has an EMPTY runtime dependency graph:
 *   it cannot reach storage, a connection, a clock, or a credential even by
 *   accident, because it imports no module that could provide one. The clock is
 *   injected by the caller, and the stale threshold is passed in explicitly
 *   (the config contract owns the default). The ~5 lines of status counting are
 *   re-derived locally rather than imported for exactly this reason.
 *
 * REDACTION BY CONSTRUCTION
 *   A report never copies `payload` or `error` — the two fields that carry
 *   caller-supplied text — so nothing in a report needs a masking pass. The
 *   identifying fields it does carry (opaque idempotency key, call SID, kind,
 *   status, timestamps) are structurally incapable of holding a phone number.
 */
import type { OutboxRecord, OutboxStatus } from './outbox.js';

// ─── Policy ─────────────────────────────────────────────────────────────────

/**
 * Only unfinished records can be stale. `done` and `failed` are terminal and
 * never nag; `stale_alerted` is handled by the second, longer tier below.
 */
export const STALE_ELIGIBLE_STATUSES = ['pending', 'in_flight'] as const;

/**
 * A record already reported once is only reported again after a second, longer
 * window — one alert per crossing, so a monitor tick can never become a storm.
 */
export const STALE_REPEAT_MULTIPLIER = 2;

export type StaleTier = 'stale' | 'stale_repeat';

/**
 * This module intentionally has no runtime imports, so it cannot import the
 * outbox's runtime array. The compile-time completeness assertion below makes
 * this local mirror fail strict compilation whenever `OutboxStatus` gains a
 * status, while the colocated check compares it to the canonical export.
 */
export const OUTBOX_STATUSES = [
  'pending',
  'in_flight',
  'done',
  'failed',
  'human_reconciliation_required',
  'stale_alerted',
] as const satisfies readonly OutboxStatus[];

type MissingOutboxStatus = Exclude<OutboxStatus, (typeof OUTBOX_STATUSES)[number]>;
const OUTBOX_STATUS_LIST_IS_COMPLETE: MissingOutboxStatus extends never ? true : never = true;
void OUTBOX_STATUS_LIST_IS_COMPLETE;

/** Every canonical outbox status is counted, in its stable source order. */
export const REPORTED_STATUSES: readonly OutboxStatus[] = OUTBOX_STATUSES;

export type StatusCounts = Record<OutboxStatus, number>;

export interface StaleOutboxEntry {
  id: string;
  idempotencyKey: string;
  callSid: string;
  kind: string;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  /** Age in ms against the tier's basis (creation, or the last attempt). */
  ageMs: number;
  tier: StaleTier;
}

export interface OutboxStaleReport {
  /** No payload and no error field is ever present on a report. */
  redacted: true;
  checkedAt: string;
  staleAfterMs: number;
  repeatAfterMs: number;
  totalRecords: number;
  staleCount: number;
  /** Records that need no attention *and* could be aged. */
  healthyCount: number;
  /** Records whose age could not be computed (unparseable timestamp). */
  unparseableCount: number;
  counts: StatusCounts;
  stale: StaleOutboxEntry[];
}

export interface StaleMonitorOptions {
  /** Overrides `STALE_REPEAT_MULTIPLIER`. */
  repeatMultiplier?: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function fail(code: string): never {
  throw new Error(code);
}

function requireWindow(staleAfterMs: unknown): number {
  if (typeof staleAfterMs !== 'number' || !Number.isInteger(staleAfterMs) || staleAfterMs <= 0) {
    return fail('voice_outbox_monitor_invalid_window');
  }
  return staleAfterMs;
}

function requireRepeatMultiplier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 2) {
    return fail('voice_outbox_monitor_invalid_repeat_multiplier');
  }
  return value;
}

function requireNow(now: unknown): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return fail('voice_outbox_monitor_invalid_clock');
  }
  return now;
}

// ─── Pure policy ────────────────────────────────────────────────────────────

function ageMsFrom(record: OutboxRecord, now: Date): number | null {
  const basis =
    record.status === 'stale_alerted'
      ? (record.lastAttemptAt ?? record.createdAt)
      : record.createdAt;
  const parsed = Date.parse(basis);
  if (!Number.isFinite(parsed)) return null;
  // A record stamped "in the future" is never stale by definition.
  return Math.max(0, now.getTime() - parsed);
}

/**
 * The stale set — pure, input-preserving, side-effect free. No retry, no write,
 * no delivery: this function only reads.
 */
export function findStale(
  records: readonly OutboxRecord[],
  now: Date,
  staleAfterMs: number,
  options: StaleMonitorOptions = {},
): StaleOutboxEntry[] {
  const window = requireWindow(staleAfterMs);
  const clock = requireNow(now);
  const repeatMultiplier = requireRepeatMultiplier(
    options.repeatMultiplier ?? STALE_REPEAT_MULTIPLIER,
  );
  const repeatAfterMs = window * repeatMultiplier;

  const stale: StaleOutboxEntry[] = [];
  for (const record of records) {
    const eligible = (STALE_ELIGIBLE_STATUSES as readonly OutboxStatus[]).includes(record.status);
    const repeatable = record.status === 'stale_alerted';
    if (!eligible && !repeatable) continue;

    const ageMs = ageMsFrom(record, clock);
    if (ageMs === null) continue;

    if (eligible) {
      if (ageMs < window) continue;
      stale.push({ ...identify(record), ageMs, tier: 'stale' });
      continue;
    }
    if (ageMs < repeatAfterMs) continue;
    stale.push({ ...identify(record), ageMs, tier: 'stale_repeat' });
  }
  return stale;
}

/** Only the non-PII identity of a record: never `payload`, never `error`. */
function identify(record: OutboxRecord): Omit<StaleOutboxEntry, 'ageMs' | 'tier'> {
  return {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    callSid: record.callSid,
    kind: record.kind,
    status: record.status,
    attempts: record.attempts,
    createdAt: record.createdAt,
    lastAttemptAt: record.lastAttemptAt,
  };
}

function countStatuses(records: readonly OutboxRecord[]): StatusCounts {
  // Derive this from the outbox's status allow-list so an added status cannot
  // silently become `undefined + 1` or fail strict type checking here.
  const counts = Object.fromEntries(
    OUTBOX_STATUSES.map((status) => [status, 0]),
  ) as StatusCounts;
  for (const record of records) {
    if ((REPORTED_STATUSES as readonly string[]).includes(record.status)) {
      counts[record.status] += 1;
    }
  }
  return counts;
}

/** The full health report. Pure; the input array is never touched. */
export function analyzeOutboxHealth(
  records: readonly OutboxRecord[],
  now: Date,
  staleAfterMs: number,
  options: StaleMonitorOptions = {},
): OutboxStaleReport {
  const clock = requireNow(now);
  const window = requireWindow(staleAfterMs);
  const repeatMultiplier = requireRepeatMultiplier(
    options.repeatMultiplier ?? STALE_REPEAT_MULTIPLIER,
  );
  const stale = findStale(records, clock, window, { repeatMultiplier });

  let unparseable = 0;
  for (const record of records) {
    const eligible = (STALE_ELIGIBLE_STATUSES as readonly OutboxStatus[]).includes(record.status);
    if (!eligible && record.status !== 'stale_alerted') continue;
    if (ageMsFrom(record, clock) === null) unparseable += 1;
  }

  return {
    redacted: true,
    checkedAt: clock.toISOString(),
    staleAfterMs: window,
    repeatAfterMs: window * repeatMultiplier,
    totalRecords: records.length,
    staleCount: stale.length,
    healthyCount: records.length - stale.length - unparseable,
    unparseableCount: unparseable,
    counts: countStatuses(records),
    stale,
  };
}

/**
 * Render a report as plain text lines. Returns strings — it prints nothing,
 * stores nothing and delivers nothing; the caller decides where they go.
 */
export function formatStaleReport(
  report: OutboxStaleReport,
  labels: { outboxPath?: string } = {},
): string[] {
  const source = labels.outboxPath ? `${labels.outboxPath}` : 'voice-outbox';
  const lines: string[] = [];
  lines.push(
    `[${source}] ${report.staleCount} of ${report.totalRecords} records stale ` +
      `(threshold ${report.staleAfterMs}ms, repeat ${report.repeatAfterMs}ms) ` +
      `checked ${report.checkedAt}`,
  );
  if (report.unparseableCount > 0) {
    lines.push(
      `[${source}] ${report.unparseableCount} record(s) could not be aged (unparseable timestamp)`,
    );
  }
  if (report.staleCount === 0) {
    lines.push(`[${source}] nothing stale — no action taken`);
    return lines;
  }
  for (const entry of report.stale) {
    lines.push(
      `[${source}] ${entry.tier} ${entry.id} kind=${entry.kind} status=${entry.status} ` +
        `ageMs=${entry.ageMs} attempts=${entry.attempts} callSid=${entry.callSid}`,
    );
  }
  // Stated in the output itself so no reader mistakes this for a retry pass.
  lines.push(`[${source}] reporting only — this monitor does not retry, write or deliver`);
  return lines;
}
