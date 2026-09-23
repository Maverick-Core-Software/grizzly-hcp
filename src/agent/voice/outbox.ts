/**
 * C0 voice canary — durable outbox (Stage 1 foundation).
 *
 * Binding design: docs/2026-09-22-c0-voice-canary-seam-audit.md §4.2.
 *
 * PURPOSE
 *   Every caller-visible side effect C0 intends (transfer request, booking /
 *   message / reschedule handoff, ops alert, note write) is written to disk
 *   ONCE, with an idempotency key, BEFORE it is attempted. A crash between
 *   "the agent said it" and "the pipeline ran" therefore leaves a durable,
 *   replayable record instead of a silent loss, and a replay cannot double-write.
 *
 * ISOLATION (audit §0 — binding)
 *   Node builtins only: `node:fs`, `node:path`, `node:crypto`. No third-party
 *   package, no provider SDK, no network client, no production module. Nothing
 *   in production imports this file, this file imports nothing from production,
 *   and there is no fail-open path or fallback into an existing voice relay.
 *
 * STORAGE SHAPE
 *   Append-only JSONL, one JSON object per line.
 *     * A NEW record is written with a single append (O_APPEND) — the cheapest
 *       write that cannot truncate what is already durable.
 *     * A STATUS TRANSITION rewrites the file atomically via `.tmp` + `rename`
 *       (the shape the booking approval poller already uses), so a torn write
 *       can never leave a half-record at the live path.
 *     * Reads are defensive: a corrupt or partially written line is skipped and
 *       counted, never fatal. Duplicate idempotency keys never yield a second
 *       record — reads are last-wins per key, so reopening the file (process
 *       restart) sees exactly one record per key.
 *   Single writer, by contract. Concurrency arbitration is deliberately NOT
 *   solved here: the audit keeps an embedded SQL database out of the canary, so
 *   this store assumes one writer process and no concurrent replay.
 *
 * REDACTION
 *   `redactRecord` / `redactValue` are the ONLY sanctioned way to hand a record
 *   to an operator surface (alert body, ops dump, dashboard). Phone-like strings
 *   are masked, e-mail addresses are masked, and the result is flagged
 *   `redacted: true`. A 10–15 digit number is indistinguishable from a phone
 *   number, so numeric values of that shape are masked too, and a standalone
 *   10–15 digit run is masked wherever it sits inside free-form text — not only
 *   when the whole value is phone-shaped (over-redaction is safe; under-redaction
 *   is not). `list()` is the internal-facing read and is
 *   not redacted; use `snapshot()` for anything that leaves the process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nextRetryAt, retryExhausted } from './c0-limits.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export type OutboxStatus =
  | 'pending'
  | 'in_flight'
  | 'done'
  | 'failed'
  | 'human_reconciliation_required'
  | 'stale_alerted';

/** Allow-list, not deny-list: an unknown status is refused, never stored. */
export const OUTBOX_STATUSES: readonly OutboxStatus[] = [
  'pending',
  'in_flight',
  'done',
  'failed',
  'human_reconciliation_required',
  'stale_alerted',
];

export type OutboxKind =
  | 'transfer'
  | 'booking'
  | 'message'
  | 'reschedule'
  | 'service_intent'
  | 'ops_alert'
  | 'note';

/** Allow-list of C0 side-effect kinds — anything else is refused at the door. */
export const OUTBOX_KINDS: readonly OutboxKind[] = [
  'transfer',
  'booking',
  'message',
  'reschedule',
  'service_intent',
  'ops_alert',
  'note',
];

/**
 * Idempotency keys are OPAQUE. The accepted charset has no `+`, no `@`, no
 * whitespace and no parentheses, and at least one non-digit character is
 * required — so a key structurally cannot carry a phone number or an e-mail
 * address into any operational surface that echoes it.
 */
export const IDEMPOTENCY_KEY_RE = /^(?=.*[A-Za-z._:-])[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** Call SIDs are opaque provider ids for the same reason as the key charset. */
const CALL_SID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const TARGET_RE = /^[A-Za-z0-9._:@-]{1,64}$/;

/** Bounded payload — a record must stay a small, replayable instruction. */
export const MAX_PAYLOAD_CHARS = 8192;
export const MAX_ERROR_CHARS = 2000;

/** Default on-disk location. Git-ignored via `data/*.jsonl` in .gitignore. */
export const DEFAULT_OUTBOX_PATH = 'data/voice-outbox.jsonl';

// ─── Record shape ───────────────────────────────────────────────────────────

export interface OutboxRecord {
  id: string;
  idempotencyKey: string;
  callSid: string;
  kind: OutboxKind;
  target?: string;
  /** The only caller-supplied text the record carries. Never exposed raw. */
  payload: Record<string, unknown>;
  /** Positive schema version used in the controller's delivery key. */
  payloadVersion: number;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  /** The earliest safe retry time; null when never/ no longer retryable. */
  nextAttemptAt: string | null;
  error?: string;
}

/** Fields a caller may supply when writing. Policy fields are NOT settable. */
export interface OutboxAppendInput {
  idempotencyKey: string;
  callSid: string;
  kind: OutboxKind;
  target?: string;
  payload?: Record<string, unknown>;
  payloadVersion?: number;
  createdAt?: string;
}

export interface OutboxAppendResult {
  /** The stored record — the pre-existing one when the key was already present. */
  record: OutboxRecord;
  /** false ⇒ this key was already durable; nothing was written. */
  created: boolean;
}

/** Fields `markStatus` may patch. Anything else is refused (allow-list). */
export interface OutboxPatch {
  attempts?: number;
  lastAttemptAt?: string | null;
  nextAttemptAt?: string | null;
  error?: string | null;
  target?: string;
}

export const OUTBOX_PATCHABLE_FIELDS: readonly (keyof OutboxPatch)[] = [
  'attempts',
  'lastAttemptAt',
  'nextAttemptAt',
  'error',
  'target',
];

export interface OutboxMarkResult {
  updated: boolean;
  record: OutboxRecord | null;
  /** Present only when `updated` is false. Never an upsert. */
  reason?: 'not_found' | 'invalid_transition';
}

export interface OutboxOptions {
  /** Explicit path — never implicit, so a check can point it at a temp dir. */
  path: string;
  now?: () => Date;
}

// ─── Redacted view (the only outward-facing shape) ──────────────────────────

export interface RedactedOutboxRecord {
  redacted: true;
  id: string;
  idempotencyKey: string;
  callSid: string;
  kind: OutboxKind;
  target?: string;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  payloadVersion: number;
  error?: string;
  payload: Record<string, unknown>;
}

export interface OutboxSnapshot {
  redacted: true;
  path: string;
  total: number;
  /** Lines that failed to parse — reported, not hidden. */
  corruptLinesSkipped: number;
  counts: Record<OutboxStatus, number>;
  oldestPendingAgeMs: number | null;
  records: RedactedOutboxRecord[];
}

// ─── Redaction primitives ───────────────────────────────────────────────────

/** Requires a separator between digit groups, so ISO-8601 stamps never match. */
const INLINE_PHONE_RE = /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;

/**
 * A STANDALONE run of 10–15 digits embedded in free-form text. The grouped
 * pattern above cannot see a run written WITHOUT separators, and
 * `looksLikePhone` only fires when the whole value is phone-shaped — so without
 * this pass a note or error string carrying a bare 10-digit run would reach an
 * operator surface intact.
 *
 * Timestamp behaviour is unchanged, for the same reason the grouped pattern is
 * timestamp-safe: an ISO-8601 stamp separates its digit groups with `-`, `:`
 * and `T`, so none of its runs is ever 10 digits long. A run of 16 or more
 * digits is outside the E.164 range and is deliberately left whole rather than
 * partially masked: it cannot be a phone number.
 */
const EMBEDDED_LONG_DIGITS_RE = /(?<!\d)\d{10,15}(?!\d)/g;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function fail(code: string): never {
  throw new Error(code);
}

/** `.env.example` house style: `+146****1234`. */
export function maskPhone(value: string): string {
  const trimmed = value.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length <= 7) return `${plus}***`;
  return `${plus}${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** `caller@example.com` → `c***@example.com`. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

/** A bare digit run of 10–15 digits, or any grouped phone shape. */
function looksLikePhone(value: string): boolean {
  if (!/^[+\d][\d\s().-]*$/.test(value)) return false;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function redactString(value: string): string {
  if (EMAIL_RE.test(value.trim())) return maskEmail(value.trim());
  if (looksLikePhone(value)) return maskPhone(value);
  // `replace` on a global pattern always starts at index 0 and resets itself,
  // so there is no `lastIndex` state to trip over; no match ⇒ unchanged string.
  // The grouped pass handles separated numbers; the standalone pass then handles
  // a bare run sitting inside free-form text. Both are idempotent — a masked
  // value carries neither a grouped 3-3-4 shape nor a 10–15 digit run — so
  // re-redacting an already masked string changes nothing.
  return value
    .replace(INLINE_PHONE_RE, (match) => maskPhone(match))
    .replace(EMBEDDED_LONG_DIGITS_RE, (match) => maskPhone(match));
}

function isPhoneShapedNumber(value: number): boolean {
  if (!Number.isInteger(value)) return false;
  const digits = String(Math.abs(value));
  return /^\d{10,15}$/.test(digits);
}

/** Deep redaction for `payload`-shaped values. Arrays and nesting included. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' && isPhoneShapedNumber(value)) {
    return maskPhone(String(Math.abs(value)));
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // A phone-ish key is masked whatever its value shape, so a structured
      // value under `phone`/`callbackPhone` cannot slip through untouched.
      if (/name|address/i.test(key) && typeof entry !== 'object') {
        out[key] = '***';
        continue;
      }
      if (/phone|mobile|cell|tel|sms|caller|contact|email/i.test(key) && typeof entry !== 'object') {
        out[key] = typeof entry === 'string' ? redactString(entry) : '***';
        continue;
      }
      out[key] = redactValue(entry);
    }
    return out;
  }
  return value;
}

/**
 * The outward-facing projection of a record. Timestamps and opaque ids pass
 * through; caller-supplied text does not.
 */
export function redactRecord(record: OutboxRecord): RedactedOutboxRecord {
  return {
    redacted: true,
    id: record.id,
    idempotencyKey: redactString(record.idempotencyKey),
    callSid: redactString(record.callSid),
    kind: record.kind,
    ...(record.target !== undefined ? { target: redactString(record.target) } : {}),
    status: record.status,
    attempts: record.attempts,
    createdAt: record.createdAt,
    lastAttemptAt: record.lastAttemptAt,
    nextAttemptAt: record.nextAttemptAt,
    payloadVersion: record.payloadVersion,
    ...(record.error !== undefined ? { error: redactString(record.error) } : {}),
    payload: redactValue(record.payload) as Record<string, unknown>,
  };
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

export function emptyCounts(): Record<OutboxStatus, number> {
  return {
    pending: 0,
    in_flight: 0,
    done: 0,
    failed: 0,
    human_reconciliation_required: 0,
    stale_alerted: 0,
  };
}

export function countByStatus(
  records: readonly OutboxRecord[],
): Record<OutboxStatus, number> {
  const counts = emptyCounts();
  for (const record of records) counts[record.status] += 1;
  return counts;
}

/** Deterministic id: a replay of the same key yields the same id, always. */
export function deriveRecordId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return `ob_${digest.slice(0, 20)}`;
}

// ─── Validation (fail-closed; every refusal carries a stable code) ──────────

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_RE.test(value.trim())) {
    return fail('voice_outbox_invalid_idempotency_key');
  }
  return value.trim();
}

function validateCallSid(value: unknown): string {
  if (typeof value !== 'string' || !CALL_SID_RE.test(value.trim())) {
    return fail('voice_outbox_invalid_call_sid');
  }
  return value.trim();
}

function validateKind(value: unknown): OutboxKind {
  if (typeof value !== 'string' || !OUTBOX_KINDS.includes(value as OutboxKind)) {
    return fail('voice_outbox_invalid_kind');
  }
  return value as OutboxKind;
}

function validateStatus(value: unknown): OutboxStatus {
  if (typeof value !== 'string' || !OUTBOX_STATUSES.includes(value as OutboxStatus)) {
    return fail('voice_outbox_invalid_status');
  }
  return value as OutboxStatus;
}

function validateTarget(value: unknown): string {
  if (typeof value !== 'string' || !TARGET_RE.test(value.trim())) {
    return fail('voice_outbox_invalid_target');
  }
  return value.trim();
}

function validatePayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('voice_outbox_invalid_payload');
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return fail('voice_outbox_unserializable_payload');
  }
  if (encoded === undefined) return fail('voice_outbox_unserializable_payload');
  if (encoded.length > MAX_PAYLOAD_CHARS) return fail('voice_outbox_payload_too_large');
  return value as Record<string, unknown>;
}

function validateError(value: unknown): string {
  if (typeof value !== 'string') return fail('voice_outbox_invalid_error');
  if (value.length > MAX_ERROR_CHARS) return fail('voice_outbox_error_too_long');
  return value;
}

function validateAttempts(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return fail('voice_outbox_invalid_attempts');
  }
  return value;
}

function validatePayloadVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return fail('voice_outbox_invalid_payload_version');
  }
  return value;
}

function validateTimestamp(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fail(code);
  return value;
}

function validatePatch(patch: unknown): OutboxPatch {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail('voice_outbox_invalid_patch');
  }
  for (const key of Object.keys(patch as Record<string, unknown>)) {
    if (!OUTBOX_PATCHABLE_FIELDS.includes(key as keyof OutboxPatch)) {
      return fail('voice_outbox_unknown_patch_field');
    }
  }
  return patch as OutboxPatch;
}

const OUTBOX_TRANSITIONS: Readonly<Record<OutboxStatus, readonly OutboxStatus[]>> = Object.freeze({
  pending: ['in_flight', 'failed', 'stale_alerted', 'human_reconciliation_required'],
  in_flight: ['pending', 'done', 'failed', 'human_reconciliation_required'],
  done: [],
  failed: ['pending', 'human_reconciliation_required'],
  human_reconciliation_required: [],
  stale_alerted: ['pending', 'human_reconciliation_required'],
});

function canTransition(from: OutboxStatus, to: OutboxStatus): boolean {
  return from === to || OUTBOX_TRANSITIONS[from].includes(to);
}

/** Whether the bounded C0 retry policy has run out for this record. */
export function outboxRetryExhausted(record: Pick<OutboxRecord, 'attempts' | 'createdAt'>, nowMs: number): boolean {
  return retryExhausted(record.attempts, Date.parse(record.createdAt), nowMs);
}

/** Rebuild a record from disk, or null when the line is not a usable record. */
function coerceRecord(value: unknown): OutboxRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.length === 0) return null;
  if (typeof raw.callSid !== 'string') return null;
  if (typeof raw.kind !== 'string' || !OUTBOX_KINDS.includes(raw.kind as OutboxKind)) return null;
  if (typeof raw.status !== 'string' || !OUTBOX_STATUSES.includes(raw.status as OutboxStatus)) return null;
  if (typeof raw.attempts !== 'number' || !Number.isInteger(raw.attempts)) return null;
  if (typeof raw.createdAt !== 'string') return null;
  const payloadVersion = raw.payloadVersion === undefined ? 1 : raw.payloadVersion;
  if (typeof payloadVersion !== 'number' || !Number.isSafeInteger(payloadVersion) || payloadVersion <= 0) return null;
  return {
    id: raw.id,
    idempotencyKey: raw.idempotencyKey,
    callSid: raw.callSid,
    kind: raw.kind as OutboxKind,
    ...(typeof raw.target === 'string' ? { target: raw.target } : {}),
    payload:
      raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : {},
    payloadVersion,
    status: raw.status as OutboxStatus,
    attempts: raw.attempts,
    createdAt: raw.createdAt,
    lastAttemptAt: typeof raw.lastAttemptAt === 'string' ? raw.lastAttemptAt : null,
    nextAttemptAt: typeof raw.nextAttemptAt === 'string' ? raw.nextAttemptAt : null,
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  };
}

// ─── The store ──────────────────────────────────────────────────────────────

/**
 * File-backed, single-writer, idempotent outbox.
 *
 *   const outbox = new Outbox({ path: '/abs/path/voice-outbox.jsonl' });
 *   outbox.append({ idempotencyKey: 'k1', callSid: 'CA…', kind: 'transfer' });
 *   outbox.append({ idempotencyKey: 'k1', … });   // created: false, no second row
 */
export class Outbox {
  readonly path: string;
  private readonly now: () => Date;

  constructor(opts: OutboxOptions | string) {
    const options: OutboxOptions = typeof opts === 'string' ? { path: opts } : opts;
    if (!options || typeof options.path !== 'string' || options.path.trim() === '') {
      fail('voice_outbox_invalid_path');
    }
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Write a record once. A repeated idempotency key returns the EXISTING record
   * and writes nothing — across instances, restarts and reopens.
   */
  append(input: OutboxAppendInput): OutboxAppendResult {
    if (input === null || typeof input !== 'object') fail('voice_outbox_invalid_input');
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const callSid = validateCallSid(input.callSid);
    const kind = validateKind(input.kind);
    const payload = validatePayload(input.payload ?? {});
    const payloadVersion = validatePayloadVersion(input.payloadVersion ?? 1);
    const target = input.target === undefined ? undefined : validateTarget(input.target);

    const existing = this.find(idempotencyKey);
    if (existing) return { record: existing, created: false };

    const record: OutboxRecord = {
      id: deriveRecordId(idempotencyKey),
      idempotencyKey,
      callSid,
      kind,
      ...(target !== undefined ? { target } : {}),
      payload,
      payloadVersion,
      // Always pending: a record exists because the action has NOT run yet.
      status: 'pending',
      attempts: 0,
      createdAt: input.createdAt ?? this.now().toISOString(),
      lastAttemptAt: null,
      nextAttemptAt: null,
    };

    this.ensureDir();
    fs.appendFileSync(this.path, `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return { record, created: true };
  }

  /** Internal-facing read. Use `snapshot()` / `redactRecord()` to expose. */
  list(): OutboxRecord[] {
    return this.readAll().records;
  }

  find(idempotencyKey: string): OutboxRecord | null {
    const key = validateIdempotencyKey(idempotencyKey);
    return this.readAll().records.find((record) => record.idempotencyKey === key) ?? null;
  }

  /**
   * Transition a record's status. Refuses unknown keys — never an upsert — and
   * refuses unknown patch fields. The rewrite is atomic (`.tmp` + `rename`).
   */
  markStatus(
    idempotencyKey: string,
    status: OutboxStatus,
    patch: OutboxPatch = {},
  ): OutboxMarkResult {
    const key = validateIdempotencyKey(idempotencyKey);
    const nextStatus = validateStatus(status);
    const safePatch = validatePatch(patch);

    const { records } = this.readAll();
    const index = records.findIndex((record) => record.idempotencyKey === key);
    if (index < 0) return { updated: false, record: null, reason: 'not_found' };
    if (!canTransition(records[index].status, nextStatus)) {
      return { updated: false, record: null, reason: 'invalid_transition' };
    }

    const merged: OutboxRecord = { ...records[index], status: nextStatus };
    if (safePatch.attempts !== undefined) merged.attempts = validateAttempts(safePatch.attempts);
    if (safePatch.target !== undefined) merged.target = validateTarget(safePatch.target);
    if (safePatch.error !== undefined) {
      if (safePatch.error === null) delete merged.error;
      else merged.error = validateError(safePatch.error);
    }
    if (safePatch.lastAttemptAt !== undefined) {
      merged.lastAttemptAt = validateTimestamp(safePatch.lastAttemptAt, 'voice_outbox_invalid_last_attempt_at');
    } else if (nextStatus !== 'pending') {
      merged.lastAttemptAt = this.now().toISOString();
    }
    if (safePatch.nextAttemptAt !== undefined) {
      merged.nextAttemptAt = validateTimestamp(safePatch.nextAttemptAt, 'voice_outbox_invalid_next_attempt_at');
    } else if (nextStatus === 'pending') {
      const lastAttemptAtMs = Date.parse(merged.lastAttemptAt ?? '');
      const next = nextRetryAt(merged.attempts, lastAttemptAtMs);
      merged.nextAttemptAt = next === null ? null : new Date(next).toISOString();
    } else {
      merged.nextAttemptAt = null;
    }

    // D6: an exhausted failure/requeue is terminal for automatic delivery. Do
    // not leave a record looking pending when no retry can safely occur.
    if (
      nextStatus === 'pending' &&
      retryExhausted(merged.attempts, Date.parse(merged.createdAt), this.now().getTime())
    ) {
      merged.status = 'human_reconciliation_required';
      merged.nextAttemptAt = null;
    }

    records[index] = merged;
    this.writeAll(records);
    return { updated: true, record: merged };
  }

  /**
   * Claim the oldest pending record: it becomes `in_flight` with a bumped
   * attempt count. Returns null when nothing is claimable. Claiming never
   * creates or duplicates a row.
   */
  claimNext(): OutboxRecord | null {
    const { records } = this.readAll();
    const nowMs = this.now().getTime();
    // An exhausted pending row must become visible as human reconciliation,
    // rather than being silently skipped forever. Each transition is atomic.
    for (const record of records) {
      if (record.status === 'pending' && outboxRetryExhausted(record, nowMs)) {
        this.markStatus(record.idempotencyKey, 'human_reconciliation_required');
      }
    }

    const current = this.readAll().records;
    const next = current.find((record) =>
      record.status === 'pending' &&
      !outboxRetryExhausted(record, nowMs) &&
      (record.nextAttemptAt === null || Date.parse(record.nextAttemptAt) <= nowMs),
    );
    if (!next) return null;
    const result = this.markStatus(next.idempotencyKey, 'in_flight', {
      attempts: next.attempts + 1,
    });
    return result.updated ? result.record : null;
  }

  /** Redacted operational view — safe to hand to an alert or a dashboard. */
  snapshot(): OutboxSnapshot {
    const { records, skipped } = this.readAll();
    const pendingAges = records
      .filter((record) => record.status === 'pending')
      .map((record) => this.now().getTime() - Date.parse(record.createdAt))
      .filter((age) => Number.isFinite(age));
    return {
      redacted: true,
      path: this.path,
      total: records.length,
      corruptLinesSkipped: skipped,
      counts: countByStatus(records),
      oldestPendingAgeMs: pendingAges.length > 0 ? Math.max(...pendingAges) : null,
      records: records.map((record) => redactRecord(record)),
    };
  }

  // ─── disk ─────────────────────────────────────────────────────────────────

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
  }

  /** Last-wins per idempotency key; corrupt lines are skipped and counted. */
  private readAll(): { records: OutboxRecord[]; skipped: number } {
    let raw = '';
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch {
      return { records: [], skipped: 0 };
    }
    const order: string[] = [];
    const byKey = new Map<string, OutboxRecord>();
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      const record = coerceRecord(parsed);
      if (!record) {
        skipped += 1;
        continue;
      }
      if (!byKey.has(record.idempotencyKey)) order.push(record.idempotencyKey);
      byKey.set(record.idempotencyKey, record);
    }
    return { records: order.map((key) => byKey.get(key) as OutboxRecord), skipped };
  }

  /** Atomic full rewrite — the only whole-file write in this module. */
  private writeAll(records: readonly OutboxRecord[]): void {
    this.ensureDir();
    const body = records.map((record) => JSON.stringify(record)).join('\n');
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, records.length > 0 ? `${body}\n` : '', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmp, this.path);
  }
}
