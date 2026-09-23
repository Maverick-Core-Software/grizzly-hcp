import assert from 'node:assert/strict';
import { FIRST_AUDIO_DEADLINE_MS, firstAudioOverdue } from './policy.js';

const answeredAtMs = 1_000_000;

assert.equal(
  firstAudioOverdue({ answeredAtMs, firstAudioAtMs: null, nowMs: answeredAtMs + FIRST_AUDIO_DEADLINE_MS - 1 }),
  false,
  'silence below the deadline is not overdue',
);
assert.equal(
  firstAudioOverdue({ answeredAtMs, firstAudioAtMs: null, nowMs: answeredAtMs + FIRST_AUDIO_DEADLINE_MS }),
  true,
  'silence at the deadline is overdue',
);
assert.equal(
  firstAudioOverdue({ answeredAtMs, firstAudioAtMs: answeredAtMs + 1, nowMs: answeredAtMs + 60_000 }),
  false,
  'a first-audio marker closes the deadline',
);
assert.equal(firstAudioOverdue({ answeredAtMs: null, firstAudioAtMs: null, nowMs: answeredAtMs + 60_000 }), true);
assert.throws(
  () => firstAudioOverdue({ answeredAtMs, firstAudioAtMs: null, nowMs: answeredAtMs }, 0),
  /c0_detector_invalid_first_audio_deadline/,
);

console.log('policy.check OK');
