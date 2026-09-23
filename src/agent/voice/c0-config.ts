/**
 * C0 voice canary — feature / configuration contract (Stage 1 foundation).
 *
 * Binding design: docs/2026-09-22-c0-voice-canary-seam-audit.md §4.1 and §6.
 *
 * DISABLED BY DEFAULT — TWO INDEPENDENT GATES
 *   1. The enable flag must be the literal string `'true'`. Absent, `false`,
 *      `TRUE`, `1`, `yes` — every one of them is OFF. The string compare is the
 *      whole gate; the unsafe branch is simply absent.
 *   2. The caller must appear in the allow-list. An empty or absent allow-list
 *      refuses EVERY caller, whatever gate 1 says — emptiness is safe by
 *      construction, not by a special case.
 *   Both gates closed ⇒ the caller of this contract must perform no action at
 *   all: no dial, no spawn, no write, no alert, and no delegation anywhere.
 *
 * ISOLATION (audit §0 — binding)
 *   Node builtins only (`node:path`), plus the C0-local redaction helper in
 *   `./outbox.js`. No third-party package, no provider SDK, no network client,
 *   no credential, no production module. This module opens no socket, performs
 *   no I/O, and reads no secret — it parses a plain string map that the caller
 *   supplies, defaulting to the process environment.
 *
 * READ SURFACE IS AN ALLOW-LIST
 *   `C0_ENV_NAMES` is the complete set of environment keys this module reads.
 *   It reads nothing else — no provider key, no account SID, no token.
 *
 * STAGE 1 SCOPE NOTE
 *   This file IS the "feature/config contract" seam. The controller that
 *   consumes it (the module that actually decides a turn) is deferred to the
 *   next approved stage; the defaults accepted here are what it will inherit.
 */
import path from 'node:path';
import { maskPhone } from './outbox.js';

// ─── Defaults (accepted for Stage 1; recorded in the audit) ─────────────────

/** Absent env ⇒ OFF. This constant exists so "default false" is assertable. */
export const VOICE_C0_ENABLED_DEFAULT = false;

export const DEFAULT_OUTBOX_PATH = 'data/c0/voice-outbox.jsonl';
export const DEFAULT_C0_MAPPING_PATH = 'data/c0/voice-c0-mapping.jsonl';
export const DEFAULT_OUTBOX_STALE_MS = 300_000;
export const DEFAULT_OUTBOX_MONITOR_INTERVAL_MS = 60_000;

/** E.164 only: `+`, a non-zero country digit, 8–15 digits total. */
export const E164_RE = /^\+[1-9]\d{7,14}$/;

/**
 * The COMPLETE set of environment keys the C0 foundation reads. Anything not
 * on this list is invisible to C0 by construction.
 */
export const C0_ENV_NAMES = [
  'VOICE_C0_ENABLED',
  'VOICE_C0_ALLOWLIST',
  'VOICE_C0_PROVIDER',
  'VOICE_C0_MODEL',
  'VOICE_C0_NTFY_TOPIC',
  'VOICE_C0_MAPPING_PATH',
  'VOICE_OUTBOX_PATH',
  'VOICE_OUTBOX_STALE_MS',
  'VOICE_OUTBOX_MONITOR_INTERVAL_MS',
] as const;

export type C0EnvName = (typeof C0_ENV_NAMES)[number];

export type C0Env = Record<string, string | undefined>;

// ─── Contract shapes ────────────────────────────────────────────────────────

export interface C0Config {
  /** Gate 1. */
  enabled: boolean;
  /** Gate 2 — normalized E.164, deduped, sorted. Empty ⇒ refuse everything. */
  allowlist: readonly string[];
  /** Config NAMES only. Explicit emission is required; never a platform default. */
  provider: string | null;
  model: string | null;
  /** Canary-only notification topic name; no credential is ever read here. */
  ntfyTopic: string | null;
  outboxPath: string;
  mappingPath: string;
  staleAfterMs: number;
  monitorIntervalMs: number;
  /** Non-fatal configuration problems, already redacted. */
  warnings: readonly string[];
}

export type C0GateReason =
  | 'allowed'
  | 'disabled_flag_off'
  | 'allowlist_empty'
  | 'caller_missing'
  | 'caller_not_allowlisted';

export interface C0GateResult {
  allowed: boolean;
  reason: C0GateReason;
}

export interface RedactedC0Config {
  redacted: true;
  enabled: boolean;
  allowlistCount: number;
  allowlistMasked: readonly string[];
  provider: string | null;
  model: string | null;
  ntfyTopic: string | null;
  outboxPath: string;
  mappingPath: string;
  staleAfterMs: number;
  monitorIntervalMs: number;
  warnings: readonly string[];
}

// ─── Gate 1 ─────────────────────────────────────────────────────────────────

/**
 * The enable flag. Only the literal string `'true'` turns C0 on — an absent
 * variable, `false`, `TRUE` or `1` all leave it off.
 */
export function isC0Enabled(env: C0Env = process.env): boolean {
  return env.VOICE_C0_ENABLED === 'true';
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function optString(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Light formatting normalization only — never repairs a missing `+`. */
export function normalizeCallerE164(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/[\s().-]/g, '');
  return E164_RE.test(trimmed) ? trimmed : null;
}

/**
 * Parse the allow-list. Non-E.164 entries are DROPPED (fail-closed) and the
 * warning names only the entry position — never the digits, so a config
 * warning cannot leak a phone number into a log.
 */
export function parseAllowlist(
  raw: string | undefined,
  warnings: string[] = [],
): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const accepted = new Set<string>();
  entries.forEach((entry, index) => {
    const normalized = normalizeCallerE164(entry);
    if (normalized === null) {
      warnings.push(
        `VOICE_C0_ALLOWLIST entry #${index + 1} is not E.164 — ignored`,
      );
      return;
    }
    accepted.add(normalized);
  });
  return [...accepted].sort();
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: C0EnvName,
  warnings: string[],
): number {
  const value = optString(raw);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warnings.push(`${name} is not a positive integer — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Load the C0 contract from a string map (defaults to the process environment).
 * Pure: given the same map it always returns the same config.
 */
export function loadC0Config(env: C0Env = process.env): C0Config {
  const warnings: string[] = [];
  const enabled = isC0Enabled(env);
  const allowlist = parseAllowlist(env.VOICE_C0_ALLOWLIST, warnings);

  if (enabled && allowlist.length === 0) {
    warnings.push(
      'VOICE_C0_ALLOWLIST is empty — every caller is refused while the enable flag is on',
    );
  }

  const outboxPath = optString(env.VOICE_OUTBOX_PATH) ?? DEFAULT_OUTBOX_PATH;
  const mappingPath = optString(env.VOICE_C0_MAPPING_PATH) ?? DEFAULT_C0_MAPPING_PATH;

  return {
    enabled,
    allowlist,
    provider: optString(env.VOICE_C0_PROVIDER),
    model: optString(env.VOICE_C0_MODEL),
    ntfyTopic: optString(env.VOICE_C0_NTFY_TOPIC),
    outboxPath,
    mappingPath,
    staleAfterMs: positiveInt(
      env.VOICE_OUTBOX_STALE_MS,
      DEFAULT_OUTBOX_STALE_MS,
      'VOICE_OUTBOX_STALE_MS',
      warnings,
    ),
    monitorIntervalMs: positiveInt(
      env.VOICE_OUTBOX_MONITOR_INTERVAL_MS,
      DEFAULT_OUTBOX_MONITOR_INTERVAL_MS,
      'VOICE_OUTBOX_MONITOR_INTERVAL_MS',
      warnings,
    ),
    warnings,
  };
}

/** The outbox path C0 would use, resolved against a caller-supplied cwd. */
export function resolveOutboxPath(config: C0Config, cwd: string = process.cwd()): string {
  return path.resolve(cwd, config.outboxPath);
}

// ─── Gate 2 ─────────────────────────────────────────────────────────────────

/**
 * Evaluate both gates. Closed ⇒ the caller must decline and stop. Note the
 * ordering: the enable flag is checked first, and an empty allow-list refuses
 * even a caller that "would" match, so no configuration error can open a gate.
 */
export function evaluateC0Gate(
  config: C0Config,
  callerE164?: string | null,
): C0GateResult {
  if (!config.enabled) return { allowed: false, reason: 'disabled_flag_off' };
  if (config.allowlist.length === 0) return { allowed: false, reason: 'allowlist_empty' };
  if (!callerE164) return { allowed: false, reason: 'caller_missing' };
  const normalized = normalizeCallerE164(callerE164);
  if (normalized === null || !config.allowlist.includes(normalized)) {
    return { allowed: false, reason: 'caller_not_allowlisted' };
  }
  return { allowed: true, reason: 'allowed' };
}

// ─── Operator view ──────────────────────────────────────────────────────────

/** Redacted operational view — the allow-list is masked, never revealed. */
export function redactedConfig(config: C0Config): RedactedC0Config {
  return {
    redacted: true,
    enabled: config.enabled,
    allowlistCount: config.allowlist.length,
    allowlistMasked: config.allowlist.map((entry) => maskPhone(entry)),
    provider: config.provider,
    model: config.model,
    ntfyTopic: config.ntfyTopic,
    outboxPath: config.outboxPath,
    mappingPath: config.mappingPath,
    staleAfterMs: config.staleAfterMs,
    monitorIntervalMs: config.monitorIntervalMs,
    warnings: config.warnings,
  };
}
