/**
 * Pure first-audio deadline policy. This local mirror was necessary because
 * Task A's shared c0-limits module was not present when detector work began;
 * it now has the same fail-closed semantics while keeping this independent
 * fallback detector runnable without the agent or LiveKit process.
 */
export const FIRST_AUDIO_DEADLINE_MS = 6_000;

export interface FirstAudioDeadlineInput {
  readonly answeredAtMs: number | null;
  readonly firstAudioAtMs: number | null;
  readonly nowMs: number;
}

/**
 * An answer marker starts the deadline. Any first-audio marker closes it; an
 * answer marker in the future is never overdue. This function has no clock,
 * filesystem, client, or process dependency.
 */
export function firstAudioOverdue(
  input: FirstAudioDeadlineInput,
  deadlineMs: number = FIRST_AUDIO_DEADLINE_MS,
): boolean {
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error('c0_detector_invalid_first_audio_deadline');
  }
  if (input.answeredAtMs === null || !Number.isFinite(input.answeredAtMs) || !Number.isFinite(input.nowMs)) {
    return true;
  }
  if (input.firstAudioAtMs !== null) return !Number.isFinite(input.firstAudioAtMs);
  return input.nowMs - input.answeredAtMs >= deadlineMs;
}
