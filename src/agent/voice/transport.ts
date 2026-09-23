/**
 * C0 voice canary — transport contract (Stage 1).
 *
 * Binding design: docs/2026-09-22-c0-voice-canary-seam-audit.md §0, §3 seam 5,
 * §4.5.
 *
 * WHAT THIS MODULE IS
 *   The pure, disabled-by-default lifecycle contract for a future canary
 *   transport. It takes an ADMITTED ingress handle — the only shape this stage
 *   admits a turn through — plus the local config, and returns either a typed
 *   inert result or an inert PLAN:
 *
 *     planC0Transport(config, handle)  ->  a typed refusal, or a plan whose
 *                                          every "something happened" flag is
 *                                          false
 *
 *   It opens nothing, joins nothing, dispatches nothing, resolves no address and
 *   speaks to no caller. There is no socket, no port, no endpoint, no credential
 *   and no provider call in this file: a plan is DATA that a future approved
 *   adapter would read, and that adapter is the only thing that could ever act.
 *
 * THE LIFECYCLE IS MODELLED AS DATA, NOT AS ACTION
 *   Phases: admitted -> ready -> connecting -> active -> ended. This stage can
 *   PLAN ('ready') and nothing else. `canEnterC0Phase` answers false for every
 *   phase that would need a transport, so no caller of this module can use it to
 *   open one, and `transportCapability()` states the same fact in one place:
 *   connecting, carrying media and reaching a caller are all false.
 *
 * WHAT IT REFUSES, AND IN WHICH ORDER
 *   `transport_ingress_not_admitted`   — the value is not an admitted handle.
 *   `transport_ingress_handle_invalid` — it claims admission but fails
 *                                        re-verification: wrong field set, a
 *                                        closed gate, a non-inert result, a raw
 *                                        caller number where a masked reference
 *                                        belongs, or an identity the controller
 *                                        would refuse. A handle is RE-VERIFIED,
 *                                        never trusted.
 *   `transport_disabled`               — the enable flag is not on.
 *   `transport_allowlist_empty`        — the flag is on, but no caller is
 *                                        admitted, so nothing may be planned.
 *
 *   The INPUT is settled before the STATE: a value that is not an admitted
 *   handle is not a transport input at all, so the environment question never
 *   arises. This is the same "validate before use" posture as the entry
 *   contract, and the check pins it.
 *
 * THE PLAN CARRIES NO CALLER CONTENT
 *   A plan echoes the opaque correlation id, the source, the confirmed sequence and payload version, the
 *   masked caller reference and the transcript LENGTH — never the transcript
 *   itself. There is therefore no field in this contract in which caller text
 *   could travel, and no field a destination, endpoint or room could occupy.
 *
 * ISOLATION (audit §0 — binding)
 *   Composes only local C0 interfaces: `./c0-entry.js` (the admitted handle, its
 *   field set, its source and transcript vocabulary), `./c0-config.js` (the
 *   config contract and the E.164 predicate) and `./c0-controller.js` (the
 *   correlation and turn-reference predicates). It deliberately does NOT import
 *   the content contract: a transport never chooses what a caller hears, so this
 *   module holds no wording at all. No third-party package, no provider SDK, no
 *   endpoint, no network client, no credential, no environment read, no timer,
 *   no process, no subprocess, no production module, and no import edge across
 *   the production boundary.
 */
import { E164_RE, type C0Config } from './c0-config.js';
import { isCorrelationId, isPositiveInteger } from './c0-controller.js';
import {
  C0_ADMITTED_FIELDS,
  C0_INGRESS_SOURCES,
  MAX_UTTERANCE_CHARS,
  type C0AdmittedIngress,
  type C0IngressSource,
} from './c0-entry.js';

// ─── The lifecycle, as a closed vocabulary ──────────────────────────────────

export type C0TransportPhase = 'admitted' | 'ready' | 'connecting' | 'active' | 'ended';

/** The order a future adapter would walk. Frozen — the vocabulary cannot grow. */
export const C0_TRANSPORT_PHASES: readonly C0TransportPhase[] = Object.freeze([
  'admitted',
  'ready',
  'connecting',
  'active',
  'ended',
]);

/**
 * The only phases reachable in this stage. Both are inert: arriving at them
 * opens nothing. Every phase beyond them would need a transport, so this
 * contract will not let anyone enter one.
 */
export const C0_INERT_PHASES: readonly C0TransportPhase[] = Object.freeze(['admitted', 'ready']);

export type C0TransportRefusalReason =
  | 'transport_ingress_not_admitted'
  | 'transport_ingress_handle_invalid'
  | 'transport_disabled'
  | 'transport_allowlist_empty';

export type C0TransportCapabilityReason = 'not_implemented_at_this_stage';

/** Closed field sets — a result can never grow a connection or delivery field. */
export const C0_TRANSPORT_PLAN_FIELDS: readonly string[] = [
  'callerMasked',
  'callerVisible',
  'connected',
  'correlationId',
  'delivered',
  'dispatched',
  'intentSequence',
  'payloadVersion',
  'performed',
  'phase',
  'source',
  'status',
  'utteranceChars',
];

export const C0_TRANSPORT_INERT_FIELDS: readonly string[] = [
  'callerVisible',
  'connected',
  'delivered',
  'dispatched',
  'performed',
  'reason',
  'status',
];

// ─── Result shapes ──────────────────────────────────────────────────────────

/** Nothing was attempted, and nothing in this stage can attempt it. */
export interface C0TransportCapability {
  readonly connects: false;
  readonly dispatchesMedia: false;
  readonly callerVisible: false;
  readonly reason: C0TransportCapabilityReason;
}

/**
 * A plan. It is data about a turn that was already admitted — not a connection,
 * not a media path and not an utterance: `performed`, `delivered`, `connected`,
 * `dispatched` and `callerVisible` are false and stay false.
 */
export interface C0TransportPlan {
  readonly status: 'planned';
  /** Where a future adapter would begin. Nothing has happened at this phase. */
  readonly phase: 'ready';
  readonly performed: false;
  readonly delivered: false;
  readonly connected: false;
  readonly dispatched: false;
  readonly callerVisible: false;
  readonly correlationId: string;
  readonly source: C0IngressSource;
  readonly intentSequence: number;
  readonly payloadVersion: number;
  readonly callerMasked: string;
  /** The transcript LENGTH only: no caller text travels through this contract. */
  readonly utteranceChars: number;
}

export interface C0TransportInertResult {
  readonly status: 'inert';
  readonly performed: false;
  readonly delivered: false;
  readonly connected: false;
  readonly dispatched: false;
  readonly callerVisible: false;
  readonly reason: C0TransportRefusalReason;
}

export type C0TransportResult = C0TransportPlan | C0TransportInertResult;

export interface C0TransportContract {
  plan(ingress: unknown): C0TransportResult;
  capability(): C0TransportCapability;
}

// ─── Predicates (pure; a handle is re-verified, never trusted) ──────────────

function fail(code: string): never {
  throw new Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function inert(reason: C0TransportRefusalReason): C0TransportInertResult {
  return {
    status: 'inert',
    performed: false,
    delivered: false,
    connected: false,
    dispatched: false,
    callerVisible: false,
    reason,
  };
}

/** The closed field set of an admitted handle must match exactly. */
function hasExactAdmittedFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  if (keys.length !== C0_ADMITTED_FIELDS.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== C0_ADMITTED_FIELDS[index]) return false;
  }
  return true;
}

/**
 * Re-verify an admitted handle. Returns it only when every invariant the entry
 * contract establishes still holds; anything else is null, and the caller turns
 * that into a typed refusal.
 */
function verifyAdmittedHandle(value: unknown): C0AdmittedIngress | null {
  if (!isPlainObject(value)) return null;
  if (value.status !== 'admitted' || value.admitted !== true) return null;
  if (value.performed !== false || value.delivered !== false) return null;
  if (!hasExactAdmittedFields(value)) return null;

  const gate = value.gate;
  if (!isPlainObject(gate) || gate.allowed !== true || gate.reason !== 'allowed') return null;

  if (!isCorrelationId(value.correlationId)) return null;
  if (!isPositiveInteger(value.intentSequence) || !isPositiveInteger(value.payloadVersion)) return null;

  const callerMasked = value.callerMasked;
  if (typeof callerMasked !== 'string' || callerMasked.trim() === '') return null;
  // A raw number is never a handle's caller reference: it must be masked.
  if (E164_RE.test(callerMasked.trim())) return null;

  if (!(C0_INGRESS_SOURCES as readonly string[]).includes(value.source as string)) return null;

  const utterance = value.utterance;
  if (
    utterance !== null &&
    (typeof utterance !== 'string' || utterance.length > MAX_UTTERANCE_CHARS)
  ) {
    return null;
  }

  return value as unknown as C0AdmittedIngress;
}

// ─── The contract ───────────────────────────────────────────────────────────

/** What this stage can do: plan, and nothing else. */
export function transportCapability(): C0TransportCapability {
  return {
    connects: false,
    dispatchesMedia: false,
    callerVisible: false,
    reason: 'not_implemented_at_this_stage',
  };
}

/** Only the inert phases are reachable. Every transport phase is not. */
export function canEnterC0Phase(value: unknown): boolean {
  return typeof value === 'string' && (C0_INERT_PHASES as readonly string[]).includes(value);
}

/** The successor in the modelled order, or null at the end and for non-phases. */
export function nextC0Phase(value: unknown): C0TransportPhase | null {
  if (typeof value !== 'string') return null;
  const index = (C0_TRANSPORT_PHASES as readonly string[]).indexOf(value);
  if (index < 0 || index === C0_TRANSPORT_PHASES.length - 1) return null;
  return C0_TRANSPORT_PHASES[index + 1];
}

/**
 * Plan a transport for one admitted turn. Pure: no clock, no I/O, no socket, no
 * provider, no environment — the config is passed in already parsed. The input is
 * settled before the state, and both refusals are typed and inert.
 */
export function planC0Transport(config: C0Config, ingress: unknown): C0TransportResult {
  // 1. The input. Anything that is not even claiming admission is not a handle.
  if (!isPlainObject(ingress)) return inert('transport_ingress_not_admitted');
  if (ingress.status !== 'admitted' && ingress.admitted !== true) {
    return inert('transport_ingress_not_admitted');
  }
  const handle = verifyAdmittedHandle(ingress);
  if (handle === null) return inert('transport_ingress_handle_invalid');

  // 2. The state. The canary must be on and still admitting callers.
  if (config === null || typeof config !== 'object' || config.enabled !== true) {
    return inert('transport_disabled');
  }
  if (!Array.isArray(config.allowlist) || config.allowlist.length === 0) {
    return inert('transport_allowlist_empty');
  }

  // 3. A plan. Nothing is opened, joined, dispatched or spoken.
  return {
    status: 'planned',
    phase: 'ready',
    performed: false,
    delivered: false,
    connected: false,
    dispatched: false,
    callerVisible: false,
    correlationId: handle.correlationId,
    source: handle.source,
    intentSequence: handle.intentSequence,
    payloadVersion: handle.payloadVersion,
    callerMasked: handle.callerMasked,
    utteranceChars: handle.utterance === null ? 0 : handle.utterance.length,
  };
}

/**
 * The guarded composition: a contract cannot exist without an explicit,
 * already-parsed config.
 */
export function createC0TransportContract(config: C0Config): C0TransportContract {
  if (config === null || typeof config !== 'object') fail('c0_transport_invalid_config');
  return {
    plan(ingress: unknown): C0TransportResult {
      return planC0Transport(config, ingress);
    },
    capability(): C0TransportCapability {
      return transportCapability();
    },
  };
}
