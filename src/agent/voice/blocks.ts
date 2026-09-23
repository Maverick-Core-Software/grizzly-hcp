/**
 * C0 voice canary — block content contract (Stage 1).
 *
 * Binding design: docs/2026-09-22-c0-voice-canary-seam-audit.md §3 seam 6, §4.6.
 *
 * WHAT THIS MODULE IS
 *   The complete, locally reviewed inventory of C0 wording that could ever reach
 *   a caller at a transition, plus the pure function that resolves one line from
 *   it by key. Caller-facing C0 text is a function of a KEY AND NOTHING ELSE:
 *
 *     renderC0Block(key)  ->  one static literal from C0_BLOCK_WORDING, or a
 *                             typed 'block_not_reviewed' refusal. Never a
 *                             fallback line, never an empty string, never a
 *                             generated one.
 *
 *   The renderer takes exactly one parameter. There is no interpolation, no
 *   template slot, no substitution and no second argument anywhere in this
 *   module, so a transcript, a caller name, a correlation id, a timestamp or a
 *   model completion has no path into caller wording through this seam. Changing
 *   what a caller hears requires editing this file and re-running the check --
 *   which IS the review.
 *
 * NO MODEL, NO TOOL, NO SIDE EFFECT
 *   This module invokes nothing: no model, no tool, no network, no subprocess, no
 *   clock, no filesystem, no environment, no printing. Every exported function is
 *   synchronous and returns a value, and nothing here can generate, look up or
 *   fetch a line of wording. It also delivers nothing: a rendered string is
 *   returned to the caller of the function, and this module has no delivery
 *   surface at all.
 *
 * THE AUDIT IS THE REVIEW GATE
 *   `auditC0Wording(table)` checks a wording table line by line against the rules
 *   a reviewed caller-facing line must satisfy: a reviewed key, a non-empty
 *   static string, bounded length, no leading or trailing space, printable ASCII
 *   with no control characters, no run of spaces, sentence case, terminal
 *   punctuation, no interpolation marker, and no phone-shaped or e-mail-shaped
 *   text (judged with this repo's own redaction primitive). The shipped table is
 *   asserted clean by its check, and the same audit rejects a dirty fixture, so
 *   the rules are not vacuous.
 *
 *   A caller may also pass `denyTokens` -- a list of product/vendor tokens a line
 *   may not contain. The list is an ARGUMENT, not a constant, because naming such
 *   a token in this source would put it in a Stage 1 module, which the audit's
 *   isolation rule forbids. The check supplies the list; this module never needs
 *   to know a vendor name.
 *
 * ISOLATION (audit §0 — binding)
 *   Imports only the C0-local `./outbox.js` redaction primitive. No third-party
 *   package, no provider API, no network client, no credential, no production
 *   module, no fallback path, and no import edge across the production boundary.
 *   This file does not borrow wording from anywhere, including the live relay:
 *   the lines below are C0's own static, reviewable literals, and the check pins
 *   each one to the source text that produced it.
 */
import { redactValue } from './outbox.js';

// ─── The reviewed key set ───────────────────────────────────────────────────

/**
 * The COMPLETE set of transitions C0 may speak to. A key outside this list has
 * no wording and is refused -- the vocabulary is a closed allow-list, so a new
 * transition cannot appear by accident and a typo cannot fall back to anything.
 * Frozen at runtime as well as at the type level: the inventory cannot grow, so
 * no key can exist without a reviewed line.
 */
export type C0BlockKey =
  | 'opening'
  | 'ai_disclosure'
  | 'emergency_notice'
  | 'after_hours'
  | 'transfer_connecting'
  | 'transfer_unavailable'
  | 'booking_recorded'
  | 'message_recorded'
  | 'reschedule_recorded'
  | 'deadline_transition'
  | 'closing';

export const C0_BLOCK_KEYS: readonly C0BlockKey[] = Object.freeze([
  'opening',
  'ai_disclosure',
  'emergency_notice',
  'after_hours',
  'transfer_connecting',
  'transfer_unavailable',
  'booking_recorded',
  'message_recorded',
  'reschedule_recorded',
  'deadline_transition',
  'closing',
]);

// ─── The reviewed wording ───────────────────────────────────────────────────

/** Longest reviewed line. Anything longer is not a spoken transition. */
export const MAX_WORDING_CHARS = 120;

/** A reviewed line ends as a sentence, so an operator can read it aloud. */
export const TERMINAL_PUNCTUATION = '.?!';

/** Frozen: the only way to change what a caller hears is to edit this literal. */
export const C0_BLOCK_WORDING: Readonly<Record<C0BlockKey, string>> = Object.freeze({
  opening: 'Thanks for calling Grizzly Electrical. How can I help you today?',
  ai_disclosure: 'You are speaking with an automated assistant for Grizzly Electrical. You can ask for a person at any time.',
  emergency_notice: 'If this is an emergency, such as fire, smoke, a shock, or a downed line, hang up and call 911.',
  after_hours: 'Our office is closed right now, but I can still take down what you need.',
  transfer_connecting: 'One moment please while I connect you with a person.',
  transfer_unavailable: 'I was not able to reach a person just now. Please try again later.',
  booking_recorded: 'The office will review your request and contact you.',
  message_recorded: 'The office will review your request and contact you.',
  reschedule_recorded: 'The office will review your request and contact you.',
  deadline_transition: 'Let me connect you with someone from the office.',
  closing: 'Thank you for calling Grizzly Electrical. Goodbye.',
});

// ─── The audit ──────────────────────────────────────────────────────────────

export type C0WordingRule =
  | 'unreviewed_key'
  | 'missing'
  | 'not_a_string'
  | 'empty'
  | 'untrimmed'
  | 'too_long'
  | 'control_character'
  | 'non_ascii'
  | 'double_space'
  | 'not_sentence_case'
  | 'no_terminal_punctuation'
  | 'interpolation_marker'
  | 'looks_sensitive'
  | 'denied_token';

export interface C0WordingViolation {
  /** The table key. Needed to fix the line; never a rendered value. */
  readonly key: string;
  readonly rule: C0WordingRule;
}

export interface C0WordingAuditOptions {
  /** Tokens a reviewed line may not contain. Supplied by the caller. */
  readonly denyTokens?: readonly string[];
}

function isReviewedKey(value: string): value is C0BlockKey {
  return (C0_BLOCK_KEYS as readonly string[]).includes(value);
}

/**
 * Audit a wording table. Pure: it reads the table, returns violations and
 * changes nothing (the shipped table is frozen, and no line is ever mutated).
 * `C0_BLOCK_WORDING` is the default subject, so auditing the shipped table is
 * `auditC0Wording()`.
 */
export function auditC0Wording(
  table: Readonly<Record<string, unknown>> = C0_BLOCK_WORDING,
  options: C0WordingAuditOptions = {},
): C0WordingViolation[] {
  const violations: C0WordingViolation[] = [];
  const denyTokens = options.denyTokens ?? [];

  // A reviewed key that is absent from the table is a gap in the inventory.
  for (const key of C0_BLOCK_KEYS) {
    if (!(key in table)) violations.push({ key, rule: 'missing' });
  }
  // A key the table carries but the inventory does not review is not allowed.
  for (const key of Object.keys(table).sort()) {
    if (!isReviewedKey(key)) {
      violations.push({ key, rule: 'unreviewed_key' });
      continue;
    }

    const line = table[key];
    if (typeof line !== 'string') {
      violations.push({ key, rule: 'not_a_string' });
      continue;
    }
    if (line === '') {
      violations.push({ key, rule: 'empty' });
      continue;
    }
    if (line !== line.trim()) violations.push({ key, rule: 'untrimmed' });
    if (line.length > MAX_WORDING_CHARS) violations.push({ key, rule: 'too_long' });
    if (/[\u0000-\u001F\u007F]/.test(line)) violations.push({ key, rule: 'control_character' });
    if (/[^\u0000-\u007F]/.test(line)) violations.push({ key, rule: 'non_ascii' });
    if (/ {2,}/.test(line)) violations.push({ key, rule: 'double_space' });
    if (line.includes('$' + '{')) violations.push({ key, rule: 'interpolation_marker' });

    // Sentence case and terminal punctuation are judged on the trimmed line,
    // so a stray space is reported once, as 'untrimmed', and not three times.
    const spoken = line.trim();
    if (!/^[A-Z]/.test(spoken)) violations.push({ key, rule: 'not_sentence_case' });
    if (spoken !== '' && !TERMINAL_PUNCTUATION.includes(spoken.slice(-1))) {
      violations.push({ key, rule: 'no_terminal_punctuation' });
    }
    // Over-redaction is safe, under-redaction is not: a line that would change
    // under this repo's own redaction is a line that carries contact detail.
    if (redactValue(line) !== line) violations.push({ key, rule: 'looks_sensitive' });
    for (const token of denyTokens) {
      if (token !== '' && line.toLowerCase().includes(token.toLowerCase())) {
        violations.push({ key, rule: 'denied_token' });
        break;
      }
    }
  }
  return violations;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

export type C0BlockRenderRefusal = 'block_not_reviewed';

/** Closed field sets — a rendered line carries text and its key, nothing else. */
export const C0_BLOCK_RENDERED_FIELDS: readonly string[] = ['key', 'ok', 'text'];
export const C0_BLOCK_REFUSAL_FIELDS: readonly string[] = ['ok', 'reason'];

export interface C0BlockRendered {
  readonly ok: true;
  readonly key: C0BlockKey;
  readonly text: string;
}

export interface C0BlockNotReviewed {
  readonly ok: false;
  readonly reason: C0BlockRenderRefusal;
}

export type C0BlockRenderResult = C0BlockRendered | C0BlockNotReviewed;

export function isC0BlockKey(value: unknown): value is C0BlockKey {
  return typeof value === 'string' && isReviewedKey(value);
}

/**
 * Resolve the reviewed line for one transition key. ONE parameter: there is
 * nowhere to pass caller text, a slot, a model completion or a destination.
 * An unknown key refuses -- it never yields a fallback string.
 */
export function renderC0Block(value: unknown): C0BlockRenderResult {
  if (!isC0BlockKey(value)) return { ok: false, reason: 'block_not_reviewed' };
  return { ok: true, key: value, text: C0_BLOCK_WORDING[value] };
}
