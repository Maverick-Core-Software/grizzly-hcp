/**
 * C0 voice canary — entry / admission contract (Stage 1).
 *
 * Binding design: docs/2026-09-22-c0-voice-canary-seam-audit.md §0, §3 seam 1,
 * §4.1.
 *
 * NO PROCESS LIVES HERE
 *   This file is the PURE admission half of the entry seam: it decides whether an
 *   inbound turn may be admitted at all, and it returns a value. There is no argv
 *   guard, no port, no socket, no server, no timer, no worker, no subprocess and
 *   no environment read in this module — becoming a process is a separate, later
 *   approved change, and nothing here can start anything. The one process-shaped
 *   concern this module does own is the *contract*: what an inbound turn must
 *   look like, and what happens when it does not.
 *
 * UNTRUSTED BY DEFAULT
 *   An inbound turn is untrusted input, so admission validates before anything
 *   consumes it and fails closed to a typed inert result. The order is deliberate
 *   — nothing untrusted is USED before it has been validated, and the gate is the
 *   first use, so it runs last:
 *
 *     1. `ingress_not_an_object`      — the value must be a plain object.
 *     2. `ingress_unknown_field`      — it must carry ONLY the fields this
 *                                       contract names. This is what stops
 *                                       ingress from asserting its own
 *                                       admissibility: a self-declared enable
 *                                       flag, gate result, admission, redaction
 *                                       claim, decision or idempotency key is a
 *                                       field this shape does not have, so it is
 *                                       refused rather than honoured.
 *     3. `ingress_incomplete`         — every required field must be present and
 *                                       non-blank.
 *     4. `ingress_source_not_accepted`— the source must be locally known.
 *     5. `ingress_caller_malformed`   — the claimed identity must be E.164. It is
 *                                       never repaired into one.
 *     6. `ingress_correlation_malformed`
 *     7. `ingress_turn_ref_malformed`
 *     8. `ingress_utterance_invalid`  — the transcript must be a bounded string.
 *     9. the local two-gate decision  — `disabled_flag_off` / `allowlist_empty` /
 *                                       `caller_not_allowlisted`.
 *
 *   Note the contrast with `./c0-controller.js`, which settles its gate FIRST:
 *   that contract is handed a value its own caller built, while this one is the
 *   boundary, so here the untrusted shape is settled before the gate is asked to
 *   decide anything. Both are inert on refusal; the order is a diagnostics
 *   choice, not a safety one — but it is pinned by this module's check.
 *
 * THE ADMITTED HANDLE IS MASKED
 *   A refusal never echoes the offending key or value: it names the class of
 *   problem and nothing else, so an untrusted string cannot ride out inside a
 *   refusal. An ADMITTED turn likewise never hands the raw caller number back —
 *   the result carries a masked caller reference plus the opaque correlation id,
 *   so the identity the gate consumed does not travel further than this function.
 *   The transcript is carried verbatim as an opaque string and is never
 *   interpreted: it cannot influence a decision field, because no decision field
 *   reads it. This contract bounds the transcript; it does not launder it, and a
 *   later consumer that renders it must treat it as untrusted.
 *
 * NOTHING HERE DELIVERS ANYTHING
 *   `performed: false` and `delivered: false` ride on every result, admitted or
 *   inert. Admission returns a handle. It speaks to nobody.
 *
 * ISOLATION (audit §0 — binding)
 *   Imports only C0-local modules: `./c0-config.js` (the two gates and the E.164
 *   predicate), `./c0-controller.js` (the correlation and turn-reference shapes,
 *   re-used rather than duplicated so an admitted handle cannot be malformed in a
 *   way the controller would refuse) and `./outbox.js` (the caller-masking
 *   primitive). No third-party package, no provider API, no network client, no
 *   credential, no production module, no fallback path, and no import edge across
 *   the production boundary.
 */
import {
  evaluateC0Gate,
  normalizeCallerE164,
  type C0Config,
  type C0GateResult,
} from './c0-config.js';
import {
  DEFAULT_TURN_REF,
  isCorrelationId,
  isTurnRef,
  type C0GateRefusalReason,
} from './c0-controller.js';
import { maskPhone } from './outbox.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * Where a turn arrived from — a CLOSED allow-list of locally known producers.
 * The keys are C0's own: no producer is named here, and an unrecognized source
 * is refused rather than treated as one of these.
 */
export type C0IngressSource = 'transport' | 'operator' | 'replay';

export const C0_INGRESS_SOURCES: readonly C0IngressSource[] = Object.freeze([
  'transport',
  'operator',
  'replay',
]);

/** The COMPLETE set of fields an inbound turn may carry. Anything else refuses. */
export const C0_INGRESS_FIELDS: readonly string[] = Object.freeze([
  'callerE164',
  'correlationId',
  'source',
  'turnRef',
  'utterance',
]);

/** The three fields a complete turn must carry. */
export const C0_INGRESS_REQUIRED_FIELDS: readonly string[] = Object.freeze([
  'callerE164',
  'correlationId',
  'source',
]);

/** A transcript is bounded so an unbounded body cannot be admitted as a turn. */
export const MAX_UTTERANCE_CHARS = 2_000;

export type C0AdmissionRefusalReason =
  | 'ingress_not_an_object'
  | 'ingress_unknown_field'
  | 'ingress_incomplete'
  | 'ingress_source_not_accepted'
  | 'ingress_caller_malformed'
  | 'ingress_correlation_malformed'
  | 'ingress_turn_ref_malformed'
  | 'ingress_utterance_invalid'
  | C0GateRefusalReason;

/** Closed field sets — a result can never grow a delivery or action field. */
export const C0_ADMITTED_FIELDS: readonly string[] = [
  'admitted',
  'callerMasked',
  'correlationId',
  'delivered',
  'gate',
  'performed',
  'source',
  'status',
  'turnRef',
  'utterance',
];

export const C0_ADMISSION_INERT_FIELDS: readonly string[] = [
  'admitted',
  'delivered',
  'gate',
  'performed',
  'reason',
  'status',
];

// ─── Result shapes ──────────────────────────────────────────────────────────

/**
 * An admitted turn. This is a HANDLE, not an action: `performed` and `delivered`
 * stay false, the caller identity is masked, and the transcript is opaque.
 */
export interface C0AdmittedIngress {
  readonly status: 'admitted';
  readonly performed: false;
  readonly delivered: false;
  readonly admitted: true;
  readonly source: C0IngressSource;
  readonly correlationId: string;
  /** Masked by construction — the raw identity does not leave this function. */
  readonly callerMasked: string;
  readonly turnRef: string;
  /** Verbatim, bounded, never interpreted. `null` when the turn carried none. */
  readonly utterance: string | null;
  /** Always the open gate: `{ allowed: true, reason: 'allowed' }`. */
  readonly gate: C0GateResult;
}

/** Nothing was admitted, nothing happened, and no value was echoed back. */
export interface C0AdmissionInertResult {
  readonly status: 'inert';
  readonly performed: false;
  readonly delivered: false;
  readonly admitted: false;
  readonly reason: C0AdmissionRefusalReason;
  /** The gate decision behind a gate refusal; null for every ingress refusal. */
  readonly gate: C0GateResult | null;
}

export type C0AdmissionResult = C0AdmittedIngress | C0AdmissionInertResult;

export interface C0EntryContract {
  /** Reject or admit one inbound turn. The only surface of this contract. */
  admit(ingress: unknown): C0AdmissionResult;
}

// ─── Predicates (pure; no value is ever echoed) ─────────────────────────────

function fail(code: string): never {
  throw new Error(code);
}

/**
 * Only a PLAIN object can be an ingress. A class instance, a boxed primitive, a
 * date or a collection object is not a turn, so it is refused at the door rather
 * than mined for fields it was never meant to carry.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A source key, or null. An unknown producer is never coerced into one. */
export function resolveIngressSource(value: unknown): C0IngressSource | null {
  return typeof value === 'string' && (C0_INGRESS_SOURCES as readonly string[]).includes(value)
    ? (value as C0IngressSource)
    : null;
}

/** Present means "a non-blank string was supplied" — absent and blank are alike. */
function isPresent(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null;
}

/**
 * A closed gate always carries a refusal reason, so the `'allowed'` arm is
 * unreachable here. Mapping it to the most conservative refusal keeps the
 * vocabulary closed without inventing a reason (same posture as the controller).
 */
function gateRefusal(gate: C0GateResult): C0GateRefusalReason {
  if (gate.reason === 'allowed') return 'disabled_flag_off';
  return gate.reason;
}

function admitted(result: Omit<C0AdmittedIngress, 'performed' | 'delivered' | 'admitted'>): C0AdmittedIngress {
  return { ...result, performed: false, delivered: false, admitted: true };
}

function inert(reason: C0AdmissionRefusalReason, gate: C0GateResult | null = null): C0AdmissionInertResult {
  return {
    status: 'inert',
    performed: false,
    delivered: false,
    admitted: false,
    reason,
    gate,
  };
}

// ─── Admission ──────────────────────────────────────────────────────────────

/**
 * Admit or refuse one inbound turn. Pure: no clock, no I/O, no store, no
 * environment, no delivery — the config is passed in already parsed.
 */
export function admitC0Ingress(config: C0Config, ingress: unknown): C0AdmissionResult {
  // 1. The value itself.
  if (!isPlainObject(ingress)) return inert('ingress_not_an_object');

  // 2. A self-assertion is refused on that ground first, whatever else is missing.
  for (const key of Object.keys(ingress)) {
    if (!C0_INGRESS_FIELDS.includes(key)) return inert('ingress_unknown_field');
  }

  // 3. Completeness: absent and blank are the same failure.
  for (const field of C0_INGRESS_REQUIRED_FIELDS) {
    if (!isPresent(ingress[field])) return inert('ingress_incomplete');
  }

  // 4. The producer must be one this canary knows.
  const source = resolveIngressSource(ingress.source);
  if (source === null) return inert('ingress_source_not_accepted');

  // 5. The claimed identity: E.164 or nothing. Never repaired.
  const caller = normalizeCallerE164(ingress.callerE164 as string);
  if (caller === null) return inert('ingress_caller_malformed');

  // 6. The correlation id must be one the controller would also accept.
  if (!isCorrelationId(ingress.correlationId)) return inert('ingress_correlation_malformed');

  // 7. An optional turn reference follows the controller's shape.
  let turnRef = DEFAULT_TURN_REF;
  const rawTurnRef = ingress.turnRef;
  if (rawTurnRef !== undefined && rawTurnRef !== null) {
    if (typeof rawTurnRef !== 'string' || rawTurnRef.trim() === '' || !isTurnRef(rawTurnRef)) {
      return inert('ingress_turn_ref_malformed');
    }
    turnRef = rawTurnRef.trim();
  }

  // 8. An optional transcript: a string, bounded. Carried verbatim; never read.
  let utterance: string | null = null;
  const rawUtterance = ingress.utterance;
  if (rawUtterance !== undefined && rawUtterance !== null) {
    if (typeof rawUtterance !== 'string' || rawUtterance.length > MAX_UTTERANCE_CHARS) {
      return inert('ingress_utterance_invalid');
    }
    utterance = rawUtterance;
  }

  // 9. Only now is anything USED: the local two-gate decision on a validated claim.
  const gate = evaluateC0Gate(config, caller);
  if (!gate.allowed) return inert(gateRefusal(gate), gate);

  return admitted({
    status: 'admitted',
    source,
    correlationId: ingress.correlationId as string,
    callerMasked: maskPhone(caller),
    turnRef,
    utterance,
    gate,
  });
}

/**
 * The guarded composition: a contract cannot exist without an explicit,
 * already-parsed config. Constructing one with something else fails loudly.
 */
export function createC0EntryContract(config: C0Config): C0EntryContract {
  if (config === null || typeof config !== 'object') fail('c0_entry_invalid_config');
  return {
    admit(ingress: unknown): C0AdmissionResult {
      return admitC0Ingress(config, ingress);
    },
  };
}
