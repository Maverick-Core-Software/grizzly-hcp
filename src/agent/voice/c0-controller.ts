/**
 * C0 voice canary — controller contract (Stage 1 foundation).
 *
 * Binding design: docs/2026-09-22-c0-voice-canary-seam-audit.md §0 and §4.1.
 *
 * WHAT THIS MODULE IS
 *   The typed, inert-by-default contract for one C0 turn. It owns exactly two
 *   things:
 *     1. the decision — the two gates inherited from `./c0-config.js` (enable
 *        flag, caller allow-list) plus the correlation precondition; and
 *     2. one write — a locally supplied, ALREADY-REDACTED record handed to the
 *        local durable outbox (`./outbox.js`) under a deterministic idempotency
 *        key derived from the correlation identity.
 *   It speaks to no caller, delivers nothing, alerts nobody, starts no process
 *   and opens no socket. Every path returns a value.
 *
 * FAIL CLOSED — THE TYPED INERT RESULT
 *   A turn yields either an inert result (`status: 'inert'`, `enqueued: false`)
 *   or an enqueued result (`status: 'enqueued' | 'duplicate'`, `enqueued:
 *   true`). Every result carries `performed: false` and `delivered: false`, and
 *   no path throws at its caller: a store that refuses or throws is caught and
 *   reported as `outbox_rejected`. Preconditions are evaluated in this order,
 *   each with its own typed reason:
 *
 *     flag off → allow-list empty → caller missing → caller not allow-listed
 *     → correlation missing → correlation malformed → kind not accepted
 *     → record not pre-redacted → payload invalid
 *
 *   The FIRST failed precondition decides the result; nothing after it runs, so
 *   a closed gate is settled before any correlation or record is even examined.
 *
 * THE ONLY WRITE
 *   `enqueue()` accepts a record the caller has already redacted (`redacted:
 *   true`). The payload is re-checked with this repo's own redaction helper, and
 *   a payload that would change under redaction is refused rather than quietly
 *   masked — "already redacted" is a checked precondition, not a promise. The
 *   durable write belongs to `./outbox.js`; this module never touches the
 *   filesystem itself.
 *
 * DETERMINISTIC IDEMPOTENCY
 *   The key is derived from the correlation identity only — correlation id,
 *   accepted kind, caller-confirmed intent sequence and payload version — never from payload
 *   text. Replaying the same turn recomputes the identical key, so the store
 *   returns the record it already holds (`duplicate`) and a retry cannot double
 *   write. Payload text can neither influence nor leak into a key.
 *
 * ISOLATION (audit §0 — binding)
 *   Node builtins only (`node:crypto`) plus the C0-local `./c0-config.js` and
 *   `./outbox.js` interfaces. No third-party package, no provider API, no
 *   network client, no credential, no production module, and no fallback path
 *   into any existing call relay. Nothing else in this repository imports this
 *   file; it has no entry point, no listener and no timer of its own.
 */
import { createHash } from 'node:crypto';
import {
  evaluateC0Gate,
  normalizeCallerE164,
  type C0Config,
  type C0GateReason,
  type C0GateResult,
} from './c0-config.js';
import {
  MAX_PAYLOAD_CHARS,
  OUTBOX_KINDS,
  redactValue,
  type OutboxAppendInput,
  type OutboxAppendResult,
  type OutboxKind,
  type OutboxRecord,
} from './outbox.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** Parent call identifiers are opaque, bounded, and safe to echo at an operator. */
export const CORRELATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const C0_PARENT_CALL_SID_RE = /^CA[0-9a-f]{32}$/;

/** A delivery sequence exists only after the caller confirmed the intent. */
export const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

/**
 * The kinds this contract will accept, on top of the store's own vocabulary.
 * It is deliberately NARROWER than `OUTBOX_KINDS`: the two internal store kinds
 * are not routed through a turn, and no unknown kind ever reaches the store.
 */
export const C0_ENQUEUE_KINDS: readonly OutboxKind[] = [
  'transfer',
  'reschedule',
  'booking',
  'message',
];

/** Delivery APIs may add a narrowly typed record kind without widening generic enqueue. */
export const C0_DELIVERY_KINDS: readonly OutboxKind[] = [...C0_ENQUEUE_KINDS, 'service_intent'];

export type C0TurnStatus = 'inert' | 'enqueued' | 'duplicate';

/** The refusal half of the gate's own vocabulary — `'allowed'` cannot refuse. */
export type C0GateRefusalReason = Exclude<C0GateReason, 'allowed'>;

export type C0RefusalReason =
  | C0GateRefusalReason
  | 'correlation_missing'
  | 'correlation_malformed'
  | 'intent_sequence_missing'
  | 'intent_sequence_malformed'
  | 'payload_version_missing'
  | 'payload_version_malformed'
  | 'call_sid_malformed'
  | 'service_intent_invalid'
  | 'transfer_role_invalid'
  | 'kind_not_accepted'
  | 'record_not_redacted'
  | 'payload_invalid'
  | 'outbox_rejected';

/** Closed field sets — a result can never grow a delivery or action field. */
export const C0_INERT_RESULT_FIELDS: readonly string[] = [
  'delivered',
  'enqueued',
  'gate',
  'performed',
  'reason',
  'status',
];

export const C0_ENQUEUED_RESULT_FIELDS: readonly string[] = [
  'created',
  'delivered',
  'enqueued',
  'idempotencyKey',
  'performed',
  'reason',
  'record',
  'recordId',
  'status',
];

// ─── Result shapes ──────────────────────────────────────────────────────────

/** Nothing happened, nothing will happen, and nothing left this process. */
export interface C0InertResult {
  readonly status: 'inert';
  readonly performed: false;
  readonly delivered: false;
  readonly enqueued: false;
  readonly reason: C0RefusalReason;
  /** The gate decision behind a gate refusal; null for every other reason. */
  readonly gate: C0GateResult | null;
}

/**
 * A record is durable. This is still not an action: `performed` and `delivered`
 * remain false — enqueueing means "the intent is recorded", nothing more.
 */
export interface C0EnqueuedResult {
  readonly status: 'enqueued' | 'duplicate';
  readonly performed: false;
  readonly delivered: false;
  readonly enqueued: true;
  readonly reason: null;
  readonly idempotencyKey: string;
  readonly recordId: string;
  readonly record: OutboxRecord;
  /** false on a replay: the store already held this key and wrote nothing. */
  readonly created: boolean;
}

export type C0TurnResult = C0InertResult | C0EnqueuedResult;

// ─── Input shapes ───────────────────────────────────────────────────────────

/**
 * The caller's record — supplied LOCALLY and supplied PRE-REDACTED. The
 * `redacted: true` literal is the caller's assertion; `planC0Enqueue` verifies
 * it against the redaction helper rather than trusting it.
 */
export interface C0RedactedRecord {
  readonly redacted: true;
  readonly kind: OutboxKind;
  readonly target?: string;
  readonly payload?: Record<string, unknown>;
}

export interface C0EnqueueRequest {
  /** Supplied by the transport; never looked up here. */
  readonly callerE164?: string | null;
  readonly correlationId?: string | null;
  /** Allocated only after caller confirmation; a missing sequence refuses. */
  readonly intentSequence?: number | null;
  /** Versioned payload schema; a missing version refuses. */
  readonly payloadVersion?: number | null;
  readonly record: C0RedactedRecord;
}

/** The minimal slice of the local store this contract composes with. */
export interface C0OutboxSink {
  append(input: OutboxAppendInput): OutboxAppendResult;
}

export interface C0ControllerDeps {
  readonly config: C0Config;
  readonly outbox: C0OutboxSink;
}

export interface C0Controller {
  /** Read-only gate view. Touches nothing, writes nothing. */
  evaluate(callerE164?: string | null): C0GateResult;
  /** The contract's only write, and never a delivery. */
  enqueue(request: C0EnqueueRequest): C0TurnResult;
  enqueueServiceIntent(request: C0ServiceIntentRequest): C0TurnResult;
  enqueueTransferRequest(request: C0TransferRequest): C0TurnResult;
}

export interface C0ServiceIntent {
  readonly name: string;
  readonly callbackE164: string;
  readonly serviceAddress: string;
  readonly scope: string;
  readonly preferredWindows: string;
  readonly callerConfirmed: true;
}

export interface C0ServiceIntentRequest {
  readonly callSid?: string | null;
  readonly callerE164?: string | null;
  readonly intentSequence?: number | null;
  readonly payloadVersion?: number | null;
  readonly intent?: C0ServiceIntent | null;
}

export interface C0TransferRequest {
  readonly callSid?: string | null;
  readonly callerE164?: string | null;
  readonly intentSequence?: number | null;
  readonly role?: 'office' | 'backup' | null;
}

// ─── The pure decision ──────────────────────────────────────────────────────

export interface C0InertPlan {
  readonly outcome: 'inert';
  readonly reason: C0RefusalReason;
  readonly gate: C0GateResult | null;
}

export interface C0ReadyPlan {
  readonly outcome: 'ready';
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly intentSequence: number;
  readonly payloadVersion: number;
  readonly kind: OutboxKind;
  readonly target?: string;
  readonly payload: Record<string, unknown>;
}

export type C0Plan = C0InertPlan | C0ReadyPlan;

// ─── Validation primitives (pure; each refusal has a stable code) ───────────

function fail(code: string): never {
  throw new Error(code);
}

export function isCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_RE.test(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isAcceptedKind(value: unknown): value is OutboxKind {
  if (typeof value !== 'string') return false;
  // The store's vocabulary is the outer bound; this contract's is the inner one.
  if (!(OUTBOX_KINDS as readonly string[]).includes(value)) return false;
  return (C0_ENQUEUE_KINDS as readonly string[]).includes(value);
}

/**
 * `true` only when this repo's own redaction helper would leave the payload
 * byte-identical — i.e. no phone-shaped or e-mail-shaped text survives in it.
 */
export function isAlreadyRedacted(payload: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(redactValue(payload)) === JSON.stringify(payload);
  } catch {
    return false;
  }
}

function requireCorrelationId(value: unknown): string {
  if (!isCorrelationId(value)) return fail('c0_invalid_correlation_id');
  return value;
}

function requirePositiveInteger(value: unknown, code: string): number {
  if (!isPositiveInteger(value)) return fail(code);
  return value;
}

function requireKind(value: unknown): OutboxKind {
  if (typeof value !== 'string' || !(C0_DELIVERY_KINDS as readonly string[]).includes(value)) {
    return fail('c0_invalid_kind');
  }
  return value as OutboxKind;
}

function validTarget(value: unknown): string | null {
  // Mirrors the store's accepted shape so a bad target is refused here instead
  // of throwing there; the value itself is opaque and never interpreted.
  return typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,64}$/.test(value.trim())
    ? value.trim()
    : null;
}

function validPayload(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  let encoded: unknown;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof encoded !== 'string' || encoded.length > MAX_PAYLOAD_CHARS) return null;
  return value as Record<string, unknown>;
}

function validParentCallSid(value: unknown): value is string {
  return typeof value === 'string' && C0_PARENT_CALL_SID_RE.test(value);
}

function validIntentText(value: unknown, maxChars: number): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxChars) return false;
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  if (/[^@\s]+@[^@\s]+\.[^@\s]+/.test(value)) return false;
  // Canonicalize compatibility digits plus all common separator forms before
  // applying a deliberately conservative capture boundary.
  const normalized = value.normalize('NFKC').replace(/[\p{Pd}\p{Zs}\u2011\u00A0\u202F\u2212]/gu, ' ');
  const digits = normalized.match(/\p{Nd}/gu) ?? [];
  if (digits.length >= 10) return false;
  // A seven-digit chain is phone-like even if ordinary punctuation hides it.
  return !/(?:\p{Nd}[\s().,;:/\\_-]*){7,}/u.test(normalized);
}

function validateServiceIntent(value: unknown): C0ServiceIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const intent = value as Record<string, unknown>;
  if (Object.keys(intent).sort().join(',') !== 'callbackE164,callerConfirmed,name,preferredWindows,scope,serviceAddress') {
    return null;
  }
  const callbackE164 = normalizeCallerE164(intent.callbackE164 as string);
  if (callbackE164 === null || intent.callerConfirmed !== true) return null;
  if (!validIntentText(intent.name, 120)) return null;
  if (!validIntentText(intent.serviceAddress, 240)) return null;
  if (!validIntentText(intent.scope, 1_000)) return null;
  if (!validIntentText(intent.preferredWindows, 500)) return null;
  return {
    name: intent.name,
    callbackE164,
    serviceAddress: intent.serviceAddress,
    scope: intent.scope,
    preferredWindows: intent.preferredWindows,
    callerConfirmed: true,
  };
}

/**
 * The deterministic idempotency input for a turn.
 *
 * Pure and total over validated input; throws a typed code on an unvalidated
 * one (`planC0Enqueue` never calls it with input it has not already accepted).
 * The digest covers the correlation identity only — payload text is not an
 * input, so a replay of the turn recomputes the identical key.
 */
export function deriveTurnIdempotencyKey(input: {
  correlationId: string;
  kind: OutboxKind;
  intentSequence: number;
  payloadVersion: number;
}): string {
  const correlationId = requireCorrelationId(input?.correlationId);
  const kind = requireKind(input?.kind);
  const intentSequence = requirePositiveInteger(input?.intentSequence, 'c0_invalid_intent_sequence');
  const payloadVersion = requirePositiveInteger(input?.payloadVersion, 'c0_invalid_payload_version');
  const digest = createHash('sha256')
    .update(`${correlationId}\u0000${intentSequence}\u0000${payloadVersion}`)
    .digest('hex');
  // The stable delivery key deliberately does not encode kind: a reconnect
  // must not create a second durable record after a classification change.
  void kind;
  return `c0.delivery.${digest.slice(0, 24)}`;
}

/**
 * A closed gate always carries a refusal reason, so the `'allowed'` arm is
 * unreachable here. Mapping it to the most conservative refusal keeps the
 * vocabulary closed without inventing a reason.
 */
function refusalReasonFor(gate: C0GateResult): C0GateRefusalReason {
  if (gate.reason === 'allowed') return 'disabled_flag_off';
  return gate.reason;
}

function inertPlan(reason: C0RefusalReason, gate: C0GateResult | null = null): C0InertPlan {
  return { outcome: 'inert', reason, gate };
}

/**
 * Decide a turn WITHOUT performing anything: no store, no clock, no I/O. The
 * precondition order documented at the top of this file lives here, and the
 * first refusal wins.
 */
export function planC0Enqueue(config: C0Config, input: C0EnqueueRequest): C0Plan {
  // 1–4. The two gates. A closed gate settles the turn before anything else.
  const gate = evaluateC0Gate(config, input?.callerE164);
  if (!gate.allowed) return inertPlan(refusalReasonFor(gate), gate);

  // 5–6. Correlation preconditions: identity must be present and well-formed.
  const rawCorrelation = input?.correlationId;
  if (rawCorrelation === undefined || rawCorrelation === null || rawCorrelation === '') {
    return inertPlan('correlation_missing');
  }
  if (!isCorrelationId(rawCorrelation)) return inertPlan('correlation_malformed');
  const intentSequence = input?.intentSequence;
  if (intentSequence === undefined || intentSequence === null) return inertPlan('intent_sequence_missing');
  if (!isPositiveInteger(intentSequence)) return inertPlan('intent_sequence_malformed');
  const payloadVersion = input?.payloadVersion;
  if (payloadVersion === undefined || payloadVersion === null) return inertPlan('payload_version_missing');
  if (!isPositiveInteger(payloadVersion)) return inertPlan('payload_version_malformed');

  // 7. The caller's record must carry the redaction assertion.
  const record: unknown = input?.record;
  if (record === null || typeof record !== 'object') return inertPlan('record_not_redacted');
  const candidate = record as { redacted?: unknown; kind?: unknown; target?: unknown; payload?: unknown };
  if (candidate.redacted !== true) return inertPlan('record_not_redacted');

  // 8. The kind must be on this contract's allow-list.
  if (!isAcceptedKind(candidate.kind)) return inertPlan('kind_not_accepted');

  // 9. The payload must be a small, serializable object — and already redacted.
  const payload = validPayload(candidate.payload);
  if (payload === null) return inertPlan('payload_invalid');
  if (!isAlreadyRedacted(payload)) return inertPlan('record_not_redacted');

  // 10. An optional target is opaque, but it must be the shape the store accepts.
  let target: string | undefined;
  if (candidate.target !== undefined) {
    const resolvedTarget = validTarget(candidate.target);
    if (resolvedTarget === null) return inertPlan('payload_invalid');
    target = resolvedTarget;
  }

  return {
    outcome: 'ready',
    idempotencyKey: deriveTurnIdempotencyKey({
      correlationId: rawCorrelation,
      kind: candidate.kind,
      intentSequence,
      payloadVersion,
    }),
    correlationId: rawCorrelation,
    intentSequence,
    payloadVersion,
    kind: candidate.kind,
    ...(target !== undefined ? { target } : {}),
    payload,
  };
}

// ─── The controller ─────────────────────────────────────────────────────────

function inertResult(reason: C0RefusalReason, gate: C0GateResult | null = null): C0InertResult {
  return {
    status: 'inert',
    performed: false,
    delivered: false,
    enqueued: false,
    reason,
    gate,
  };
}

function persistReadyPlan(outbox: C0OutboxSink, plan: C0ReadyPlan): C0TurnResult {
  try {
    const stored = outbox.append({
      idempotencyKey: plan.idempotencyKey,
      callSid: plan.correlationId,
      kind: plan.kind,
      ...(plan.target !== undefined ? { target: plan.target } : {}),
      payload: plan.payload,
      payloadVersion: plan.payloadVersion,
    });
    return {
      status: stored.created ? 'enqueued' : 'duplicate',
      performed: false,
      delivered: false,
      enqueued: true,
      reason: null,
      idempotencyKey: plan.idempotencyKey,
      recordId: stored.record.id,
      record: stored.record,
      created: stored.created,
    };
  } catch {
    return inertResult('outbox_rejected');
  }
}

function validatedGate(config: C0Config, callerE164: string | null | undefined): C0GateResult | C0InertResult {
  const gate = evaluateC0Gate(config, callerE164);
  return gate.allowed ? gate : inertResult(refusalReasonFor(gate), gate);
}

/**
 * Compose the contract. The configuration and the store are both INJECTED —
 * this module reads no environment variable and no path of its own, so a
 * controller cannot exist without an explicit, already-parsed config.
 */
export function createC0Controller(deps: C0ControllerDeps): C0Controller {
  if (deps === null || typeof deps !== 'object' || deps.config === null || typeof deps.config !== 'object') {
    fail('c0_controller_invalid_config');
  }
  if (deps.outbox === null || typeof deps.outbox !== 'object' || typeof deps.outbox.append !== 'function') {
    fail('c0_controller_invalid_outbox');
  }
  const { config, outbox } = deps;

  return {
    evaluate(callerE164?: string | null): C0GateResult {
      return evaluateC0Gate(config, callerE164);
    },

    enqueue(request: C0EnqueueRequest): C0TurnResult {
      const plan = planC0Enqueue(config, request);

      // Inert: no store call is made at all, so a refusal cannot write.
      if (plan.outcome === 'inert') return inertResult(plan.reason, plan.gate);

      return persistReadyPlan(outbox, plan);
    },

    enqueueServiceIntent(request: C0ServiceIntentRequest): C0TurnResult {
      const gated = validatedGate(config, request?.callerE164);
      if ('status' in gated) return gated;
      if (!validParentCallSid(request?.callSid)) return inertResult('call_sid_malformed');
      if (!isPositiveInteger(request?.intentSequence) || !isPositiveInteger(request?.payloadVersion)) {
        return inertResult('service_intent_invalid');
      }
      const intent = validateServiceIntent(request?.intent);
      if (intent === null) return inertResult('service_intent_invalid');
      return persistReadyPlan(outbox, {
        outcome: 'ready',
        idempotencyKey: deriveTurnIdempotencyKey({
          correlationId: request.callSid,
          kind: 'service_intent',
          intentSequence: request.intentSequence,
          payloadVersion: request.payloadVersion,
        }),
        correlationId: request.callSid,
        intentSequence: request.intentSequence,
        payloadVersion: request.payloadVersion,
        kind: 'service_intent',
        payload: intent as unknown as Record<string, unknown>,
      });
    },

    enqueueTransferRequest(request: C0TransferRequest): C0TurnResult {
      const gated = validatedGate(config, request?.callerE164);
      if ('status' in gated) return gated;
      if (!validParentCallSid(request?.callSid)) return inertResult('call_sid_malformed');
      if (!isPositiveInteger(request?.intentSequence)) return inertResult('intent_sequence_malformed');
      if (request?.role !== 'office' && request?.role !== 'backup') return inertResult('transfer_role_invalid');
      const payloadVersion = 1;
      return persistReadyPlan(outbox, {
        outcome: 'ready',
        idempotencyKey: deriveTurnIdempotencyKey({
          correlationId: request.callSid,
          kind: 'transfer',
          intentSequence: request.intentSequence,
          payloadVersion,
        }),
        correlationId: request.callSid,
        intentSequence: request.intentSequence,
        payloadVersion,
        kind: 'transfer',
        payload: { role: request.role },
      });
    },
  };
}
