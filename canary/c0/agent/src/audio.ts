import type { MarkerWriter } from './runtime.js';

/**
 * Agents 1.9.0's agent_activity.ts:3197-3204 reaches `speaking` only after
 * `audioOut.firstFrameFut` resolves its PLAYBACK_STARTED signal; do not use SpeechCreated.
 */
export function markFirstPublishedAudio(
  state: string,
  marked: boolean,
  markers: MarkerWriter,
  callSid: string,
): boolean {
  if (marked || state !== 'speaking') return marked;
  markers.mark('first-audio', callSid);
  return true;
}
