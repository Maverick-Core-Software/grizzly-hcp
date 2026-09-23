import assert from 'node:assert/strict';
import {
  C0_LIMITS,
  evaluateAdmission,
  firstAudioOverdue,
  nextRetryAt,
  retryExhausted,
} from './c0-limits.js';

function main(): void {
  assert.deepEqual(C0_LIMITS, {
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
  assert.deepEqual(evaluateAdmission({ activeCalls: 0, todayCalls: 0, todayGptLiveMinutes: 0 }), {
    admit: true, reason: 'admitted',
  });
  assert.equal(evaluateAdmission({ activeCalls: 1, todayCalls: 0, todayGptLiveMinutes: 0 }).admit, false);
  assert.equal(evaluateAdmission({ activeCalls: 0, todayCalls: 30, todayGptLiveMinutes: 0 }).reason, 'daily_call_limit_reached');
  assert.equal(evaluateAdmission({ activeCalls: 0, todayCalls: 0, todayGptLiveMinutes: 90 }).reason, 'daily_gpt_live_minutes_limit_reached');

  // Mutation-style negative control: unknown capacity must never admit.
  for (const counters of [
    { activeCalls: null, todayCalls: 0, todayGptLiveMinutes: 0 },
    { activeCalls: 0, todayCalls: Number.NaN, todayGptLiveMinutes: 0 },
    { activeCalls: 0, todayCalls: 0, todayGptLiveMinutes: undefined },
  ]) {
    assert.deepEqual(evaluateAdmission(counters), { admit: false, reason: 'counters_unobservable' });
  }

  assert.equal(firstAudioOverdue({ answeredAtMs: 100, firstAudioAtMs: null, nowMs: 6_099 }), false);
  assert.equal(firstAudioOverdue({ answeredAtMs: 100, firstAudioAtMs: null, nowMs: 6_100 }), true);
  assert.equal(firstAudioOverdue({ answeredAtMs: 100, firstAudioAtMs: 200, nowMs: 9_000 }), false);
  assert.equal(firstAudioOverdue({ answeredAtMs: null, firstAudioAtMs: null, nowMs: 9_000 }), true);

  assert.equal(nextRetryAt(1, 1_000), 61_000);
  assert.equal(nextRetryAt(4, 1_000), 481_000);
  assert.equal(nextRetryAt(5, 1_000), null);
  assert.equal(nextRetryAt(0, 1_000), null);
  assert.equal(retryExhausted(4, 0, 1_799_999), false);
  assert.equal(retryExhausted(5, 0, 1), true);
  assert.equal(retryExhausted(1, 0, 1_800_000), true);
  assert.equal(retryExhausted(undefined, 0, 0), true);
  console.log('c0-limits.check OK');
}

main();
