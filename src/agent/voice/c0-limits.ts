/** C0 canary limits — pure, fail-closed policy derived from D6. */

export const C0_LIMITS = Object.freeze({
  dialTimeoutMs: 20_000,
  ringingTimeoutMs: 15_000,
  firstAudioDeadlineMs: 6_000,
  silenceTimeoutMs: 15_000,
  maxCallDurationMs: 480_000,
  maxConcurrentCalls: 1,
  maxDailyCalls: 30,
  maxDailyGptLiveMinutes: 90,
  maxOutboxAttempts: 5,
  outboxRetryWindowMs: 1_800_000,
  outboxRetryDelaysMs: [60_000, 120_000, 240_000, 480_000, 900_000],
});

export type C0AdmissionReason =
  | 'admitted'
  | 'counters_unobservable'
  | 'concurrency_limit_reached'
  | 'daily_call_limit_reached'
  | 'daily_gpt_live_minutes_limit_reached';

export interface C0AdmissionInput {
  readonly activeCalls: unknown;
  readonly todayCalls: unknown;
  readonly todayGptLiveMinutes: unknown;
}

export interface C0AdmissionResult {
  readonly admit: boolean;
  readonly reason: C0AdmissionReason;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Unknown counter data denies admission; a canary never guesses capacity. */
export function evaluateAdmission(input: C0AdmissionInput): C0AdmissionResult {
  if (
    input === null ||
    typeof input !== 'object' ||
    !nonNegativeInteger(input.activeCalls) ||
    !nonNegativeInteger(input.todayCalls) ||
    !nonNegativeFinite(input.todayGptLiveMinutes)
  ) {
    return { admit: false, reason: 'counters_unobservable' };
  }
  if (input.activeCalls >= C0_LIMITS.maxConcurrentCalls) {
    return { admit: false, reason: 'concurrency_limit_reached' };
  }
  if (input.todayCalls >= C0_LIMITS.maxDailyCalls) {
    return { admit: false, reason: 'daily_call_limit_reached' };
  }
  if (input.todayGptLiveMinutes >= C0_LIMITS.maxDailyGptLiveMinutes) {
    return { admit: false, reason: 'daily_gpt_live_minutes_limit_reached' };
  }
  return { admit: true, reason: 'admitted' };
}

/** An absent or unobservable first-audio marker is overdue once the deadline passes. */
export function firstAudioOverdue(input: {
  readonly answeredAtMs: unknown;
  readonly firstAudioAtMs: unknown;
  readonly nowMs: unknown;
}): boolean {
  if (!nonNegativeFinite(input?.answeredAtMs) || !nonNegativeFinite(input?.nowMs)) return true;
  if (input.firstAudioAtMs !== null && input.firstAudioAtMs !== undefined) {
    return !nonNegativeFinite(input.firstAudioAtMs);
  }
  return input.nowMs - input.answeredAtMs >= C0_LIMITS.firstAudioDeadlineMs;
}

/** The next retry is deterministic and bounded; null means no safe retry remains. */
export function nextRetryAt(attempts: unknown, lastAttemptAtMs: unknown): number | null {
  if (!nonNegativeInteger(attempts) || attempts < 1 || attempts >= C0_LIMITS.maxOutboxAttempts) {
    return null;
  }
  if (!nonNegativeFinite(lastAttemptAtMs)) return null;
  const delay = C0_LIMITS.outboxRetryDelaysMs[attempts - 1];
  return delay === undefined ? null : lastAttemptAtMs + delay;
}

/** Exhaustion is conservative: invalid counters/times are exhausted, never retried. */
export function retryExhausted(attempts: unknown, createdAtMs: unknown, nowMs: unknown): boolean {
  if (!nonNegativeInteger(attempts) || !nonNegativeFinite(createdAtMs) || !nonNegativeFinite(nowMs)) return true;
  return (
    attempts >= C0_LIMITS.maxOutboxAttempts ||
    nowMs - createdAtMs >= C0_LIMITS.outboxRetryWindowMs
  );
}
