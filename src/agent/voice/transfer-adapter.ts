/**
 * C0 voice canary — transfer-adapter contract (Stage 1; canary-only).
 *
 * Binding design: docs/2026-09-22-c0-voice-canary-seam-audit.md §4.4.
 *
 * THE CONTRACT
 *   An adapter carries ONE already-validated transfer request and reports an
 *   outcome status. It decides nothing: which person to try, the order to try
 *   them in, what the caller hears when the attempts fail, and what gets
 *   recorded all stay with the C0 controller (a later approved stage). An
 *   adapter that resolved a destination, or made a policy decision, would be a
 *   wrong adapter.
 *
 * DEFAULT IS INERT — AND STAYS INERT
 *   The only implementation this stage ships is `createInertTransferAdapter()`,
 *   which reports `status: 'unavailable'` with `available: false` and
 *   `attempted: false` for every well-formed request, whatever the gates say.
 *   There is no environment variable, no configuration value and no flag that
 *   can turn it into a dialing adapter — an adapter capable of placing a call
 *   does not exist in this stage, so "misconfigured into dialing" is not a
 *   reachable state. Its outcome type carries no field that could hold a
 *   destination, and `createInertTransferAdapter` cannot return a target.
 *
 * NEVER A PHONE TARGET
 *   A request names a person by ROLE (`'carter' | 'jaime'`) and never a number.
 *   Roles are validated against a closed allow-list, and `resolveTransferTarget`
 *   answers `null` for anything else — including any phone-shaped string. The
 *   number a future approved adapter might need would be resolved OUTSIDE this
 *   contract; nothing passes a destination through it, so nothing here can leak
 *   one. Caller context (name, reason, callback) is not part of this contract
 *   either: the controller records that in the local outbox under redaction.
 *
 * THE OUTCOME VOCABULARY IS CLOSED
 *   `'unavailable'` means "nothing was attempted, and nothing will be" — the
 *   canary's answer. The four observable outcomes a real adapter could report
 *   follow it. `resolveTransferOutcome` maps anything unrecognized to `'failed'`
 *   so an adapter bug can never be read as a success, and only `'accepted'`
 *   counts as one.
 *
 * ISOLATION (audit §0 — binding)
 *   Imports only C0-local modules: the local gate helper and its types. No
 *   third-party package, no provider API, no network client, no credential, no
 *   production module, no fallback path, and no ability to place a call. This
 *   module performs no I/O of any kind — `dial()` is the only async surface, and
 *   the shipped implementation resolves without doing anything at all.
 */
import {
  evaluateC0Gate,
  type C0Config,
  type C0GateResult,
} from './c0-config.js';

// ─── Request vocabulary (roles, never destinations) ─────────────────────────

export type TransferTarget = 'carter' | 'jaime';

/** Closed allow-list: a role not on this list is refused, never coerced. */
export const TRANSFER_TARGETS: readonly TransferTarget[] = ['carter', 'jaime'];

export type TransferKind = 'general' | 'emergency';

export const TRANSFER_KINDS: readonly TransferKind[] = ['general', 'emergency'];

export type TransferScreening = 'whisper' | 'direct';

export const TRANSFER_SCREENINGS: readonly TransferScreening[] = ['whisper', 'direct'];

/** `'direct'` is only ever valid for an emergency — the production rule. */
export const DIRECT_SCREENING_KINDS: readonly TransferKind[] = ['emergency'];

export interface TransferRequest {
  /** Opaque correlation id, bounded; the adapter never interprets it. */
  readonly correlationId: string;
  /** A PERSON, by role. Never a number. */
  readonly target: TransferTarget;
  readonly kind: TransferKind;
  readonly screening: TransferScreening;
}

// ─── Outcome vocabulary ─────────────────────────────────────────────────────

export type TransferOutcomeStatus =
  | 'unavailable'
  | 'accepted'
  | 'declined'
  | 'no_answer'
  | 'failed';

export const TRANSFER_OUTCOME_STATUSES: readonly TransferOutcomeStatus[] = [
  'unavailable',
  'accepted',
  'declined',
  'no_answer',
  'failed',
];

/** Why the canary cannot transfer. Every value means "nothing was attempted". */
export type TransferUnavailableReason =
  | 'not_configured'
  | 'c0_disabled'
  | 'allowlist_empty'
  | 'caller_not_admitted';

export interface TransferOutcome {
  readonly status: TransferOutcomeStatus;
  /** Always false in this stage; a later adapter would set it honestly. */
  readonly attempted: boolean;
  readonly detail?: string;
}

export interface TransferUnavailableOutcome extends TransferOutcome {
  readonly status: 'unavailable';
  readonly attempted: false;
  readonly available: false;
  readonly reason: TransferUnavailableReason;
}

export interface TransferAdapter {
  /**
   * Carry one validated request. Resolves with an outcome; an INVALID request
   * is rejected with a typed code instead of an outcome, because an
   * unvalidatable request must never be reported as a success.
   */
  dial(request: TransferRequest): Promise<TransferOutcome>;
}

/** The exact field set of the shipped outcome — a closed, destinationless shape. */
export const TRANSFER_UNAVAILABLE_FIELDS: readonly string[] = [
  'attempted',
  'available',
  'reason',
  'status',
];

// ─── Validation (pure, fail-closed, every refusal a stable code) ────────────

function fail(code: string): never {
  throw new Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A role, or null. A phone-shaped or unknown string yields null. */
export function resolveTransferTarget(value: unknown): TransferTarget | null {
  return typeof value === 'string' && (TRANSFER_TARGETS as readonly string[]).includes(value)
    ? (value as TransferTarget)
    : null;
}

export function resolveTransferKind(value: unknown): TransferKind | null {
  return typeof value === 'string' && (TRANSFER_KINDS as readonly string[]).includes(value)
    ? (value as TransferKind)
    : null;
}

export function resolveTransferScreening(value: unknown): TransferScreening | null {
  return typeof value === 'string' && (TRANSFER_SCREENINGS as readonly string[]).includes(value)
    ? (value as TransferScreening)
    : null;
}

export function isTransferCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Validate a request, or fail with a typed code. Never repairs: an unknown role
 * is a refusal, and direct screening on a non-emergency is a refusal.
 */
export function validateTransferRequest(value: unknown): TransferRequest {
  if (!isPlainObject(value)) return fail('voice_transfer_invalid_request');

  const target = resolveTransferTarget(value.target);
  if (target === null) return fail('voice_transfer_invalid_target');

  const kind = resolveTransferKind(value.kind);
  if (kind === null) return fail('voice_transfer_invalid_kind');

  const screening = resolveTransferScreening(value.screening);
  if (screening === null) return fail('voice_transfer_invalid_screening');

  if (screening === 'direct' && !DIRECT_SCREENING_KINDS.includes(kind)) {
    return fail('voice_transfer_direct_screening_requires_emergency');
  }

  if (!isTransferCorrelationId(value.correlationId)) {
    return fail('voice_transfer_invalid_correlation_id');
  }

  return { correlationId: value.correlationId, target, kind, screening };
}

// ─── Outcome resolution ─────────────────────────────────────────────────────

/**
 * Map an untrusted status onto the closed vocabulary. Anything unrecognized —
 * including a missing status, a null, or a non-string — becomes `'failed'`, so
 * an adapter can never produce a silent success.
 */
export function resolveTransferOutcome(value: unknown): TransferOutcomeStatus {
  return typeof value === 'string' &&
    (TRANSFER_OUTCOME_STATUSES as readonly string[]).includes(value)
    ? (value as TransferOutcomeStatus)
    : 'failed';
}

/** Only `'accepted'` is a success. `'unavailable'` is emphatically not one. */
export function transferOutcomeSucceeded(status: unknown): boolean {
  return resolveTransferOutcome(status) === 'accepted';
}

// ─── Availability (why the canary never dials) ──────────────────────────────

export interface TransferAvailability {
  readonly available: false;
  readonly reason: TransferUnavailableReason;
}

/**
 * Availability is a REPORT, not a switch: every path answers `available: false`
 * at this stage. An open gate reports `'not_configured'` — the gates being open
 * still leaves no adapter that can dial, which is exactly the point.
 */
export function transferAvailability(
  config: C0Config,
  callerE164?: string | null,
): TransferAvailability {
  const gate: C0GateResult = evaluateC0Gate(config, callerE164);
  if (gate.reason === 'disabled_flag_off') return { available: false, reason: 'c0_disabled' };
  if (gate.reason === 'allowlist_empty') return { available: false, reason: 'allowlist_empty' };
  if (!gate.allowed) return { available: false, reason: 'caller_not_admitted' };
  return { available: false, reason: 'not_configured' };
}

// ─── The shipped adapter: inert by construction ─────────────────────────────

/**
 * The canary adapter. It validates, then reports `'unavailable'` — it holds no
 * target, opens nothing, and has no configuration that could change its answer.
 */
export function createInertTransferAdapter(
  reason: TransferUnavailableReason = 'not_configured',
): TransferAdapter {
  const fixed: TransferUnavailableOutcome = {
    status: 'unavailable',
    attempted: false,
    available: false,
    reason,
  };
  return {
    async dial(request: TransferRequest): Promise<TransferOutcome> {
      validateTransferRequest(request); // throws a typed code on a bad request
      return { ...fixed };
    },
  };
}
