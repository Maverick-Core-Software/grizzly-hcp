/**
 * Self-check for the pure stale-outbox monitor. No test framework — run from
 * the worktree root with:
 *
 *   npx tsx src/agent/voice/outbox-monitor.check.ts
 *
 * The policy functions are exercised entirely in memory with fixture records,
 * an injected clock and an injected window: the monitor's own logic performs no
 * disk, network, delivery or clock access, and this check proves it by running
 * the policy with nothing to read from and by scanning the module's source for
 * any capability that could reach outside the process.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTBOX_STATUSES as MONITOR_OUTBOX_STATUSES,
  REPORTED_STATUSES,
  STALE_ELIGIBLE_STATUSES,
  STALE_REPEAT_MULTIPLIER,
  analyzeOutboxHealth,
  findStale,
  formatStaleReport,
} from './outbox-monitor.js';
import { OUTBOX_STATUSES as CANONICAL_OUTBOX_STATUSES, type OutboxRecord } from './outbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = new Date('2026-09-22T15:00:00.000Z');
const STALE_MS = 300_000; // 5 minutes
const REPEAT_MS = STALE_MS * STALE_REPEAT_MULTIPLIER;
const fakeSid = (prefix: string): string => `${prefix}${'0'.repeat(32)}`;

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function fixture(overrides: Partial<OutboxRecord> & { idempotencyKey: string }): OutboxRecord {
  return {
    id: `ob_${overrides.idempotencyKey}`,
    callSid: fakeSid('CA'),
    kind: 'transfer',
    payload: {},
    payloadVersion: 1,
    status: 'pending',
    attempts: 0,
    createdAt: minutesAgo(0),
    lastAttemptAt: null,
    nextAttemptAt: null,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function main(): void {
  // ─── 1. The policy constants ─────────────────────────────────────────────
  {
    assert.deepEqual([...STALE_ELIGIBLE_STATUSES], ['pending', 'in_flight']);
    assert.equal(STALE_REPEAT_MULTIPLIER, 2);
    assert.ok((REPORTED_STATUSES as readonly string[]).includes('stale_alerted'));
    assert.deepEqual(
      MONITOR_OUTBOX_STATUSES,
      CANONICAL_OUTBOX_STATUSES,
      'the zero-runtime-import monitor list exactly mirrors the canonical outbox allow-list',
    );
    assert.ok((REPORTED_STATUSES as readonly string[]).includes('human_reconciliation_required'));
  }

  // ─── 2. The threshold boundary ───────────────────────────────────────────
  {
    const fresh = fixture({ idempotencyKey: 'fresh', createdAt: minutesAgo(4) });
    assert.deepEqual(findStale([fresh], NOW, STALE_MS), [], 'below the window ⇒ silent');

    const exact = fixture({ idempotencyKey: 'exact', createdAt: minutesAgo(5) });
    const atBoundary = findStale([exact], NOW, STALE_MS);
    assert.equal(atBoundary.length, 1, 'at the window ⇒ stale (>=)');
    assert.equal(atBoundary[0].ageMs, STALE_MS, 'the reported age is exact');
    assert.equal(atBoundary[0].tier, 'stale');

    const over = fixture({ idempotencyKey: 'over', createdAt: minutesAgo(6) });
    assert.equal(findStale([over], NOW, STALE_MS)[0].ageMs, 360_000);

    const inFlight = fixture({
      idempotencyKey: 'in-flight',
      status: 'in_flight',
      attempts: 1,
      createdAt: minutesAgo(10),
      lastAttemptAt: minutesAgo(9),
    });
    const reported = findStale([inFlight], NOW, STALE_MS);
    assert.equal(reported.length, 1, 'an in-flight record can go stale too');
    assert.equal(reported[0].status, 'in_flight');
    assert.equal(reported[0].attempts, 1);
  }

  // ─── 3. Terminal records never nag; a repeat needs the second tier ───────
  {
    const terminal = [
      fixture({ idempotencyKey: 'done', status: 'done', createdAt: minutesAgo(600) }),
      fixture({ idempotencyKey: 'failed', status: 'failed', createdAt: minutesAgo(600) }),
    ];
    assert.deepEqual(findStale(terminal, NOW, STALE_MS), [], 'done/failed are never stale');

    // Once reported, a record waits for the longer repeat window: one report
    // per crossing, so a monitor tick cannot become a storm.
    const justReported = fixture({
      idempotencyKey: 'reported-recently',
      status: 'stale_alerted',
      createdAt: minutesAgo(120),
      lastAttemptAt: minutesAgo(6),
    });
    assert.deepEqual(
      findStale([justReported], NOW, STALE_MS),
      [],
      'a recently reported record stays quiet until the repeat window',
    );

    const repeatDue = fixture({
      idempotencyKey: 'repeat-due',
      status: 'stale_alerted',
      createdAt: minutesAgo(120),
      lastAttemptAt: minutesAgo(10),
    });
    const repeats = findStale([repeatDue], NOW, STALE_MS);
    assert.equal(repeats.length, 1, 'the repeat window opens at 2× the threshold');
    assert.equal(repeats[0].ageMs, REPEAT_MS, 'the repeat age is measured from the last attempt');
    assert.equal(repeats[0].tier, 'stale_repeat');

    const noAttemptStamp = fixture({
      idempotencyKey: 'no-attempt-stamp',
      status: 'stale_alerted',
      createdAt: minutesAgo(30),
      lastAttemptAt: null,
    });
    assert.equal(
      findStale([noAttemptStamp], NOW, STALE_MS)[0].tier,
      'stale_repeat',
      'without an attempt stamp the repeat age falls back to creation',
    );

    const tripled = fixture({
      idempotencyKey: 'tripled',
      status: 'stale_alerted',
      createdAt: minutesAgo(120),
      lastAttemptAt: minutesAgo(14),
    });
    assert.deepEqual(
      findStale([tripled], NOW, STALE_MS, { repeatMultiplier: 3 }),
      [],
      'a caller-supplied repeat multiplier is honoured (14min < 3×5min)',
    );
    assert.equal(
      findStale([tripled], NOW, STALE_MS, { repeatMultiplier: 2 }).length,
      1,
      'the same record is due under a shorter repeat window',
    );
  }

  // ─── 4. A record stamped in the future is never stale ───────────────────
  {
    const future = fixture({ idempotencyKey: 'future', createdAt: minutesAgo(-30) });
    assert.deepEqual(findStale([future], NOW, STALE_MS), [], 'clock skew cannot invent staleness');
  }

  // ─── 5. The health report counts what it reports ─────────────────────────
  {
    const records = [
      fixture({ idempotencyKey: 'pending-old', createdAt: minutesAgo(30) }),
      fixture({ idempotencyKey: 'pending-fresh', createdAt: minutesAgo(1) }),
      fixture({ idempotencyKey: 'in-flight-old', status: 'in_flight', createdAt: minutesAgo(20) }),
      fixture({ idempotencyKey: 'done-old', status: 'done', createdAt: minutesAgo(200) }),
      fixture({ idempotencyKey: 'failed-old', status: 'failed', createdAt: minutesAgo(200) }),
      fixture({
        idempotencyKey: 'human-reconciliation',
        status: 'human_reconciliation_required',
        createdAt: minutesAgo(200),
      }),
      fixture({
        idempotencyKey: 'reported-old',
        status: 'stale_alerted',
        createdAt: minutesAgo(200),
        lastAttemptAt: minutesAgo(5),
      }),
      fixture({ idempotencyKey: 'unparseable', createdAt: 'not-a-date' }),
    ];
    const report = analyzeOutboxHealth(records, NOW, STALE_MS);

    assert.equal(report.redacted, true);
    assert.equal(report.checkedAt, NOW.toISOString(), 'the injected clock is the report clock');
    assert.equal(report.staleAfterMs, STALE_MS);
    assert.equal(report.repeatAfterMs, REPEAT_MS);
    assert.equal(report.totalRecords, 8);
    assert.equal(report.staleCount, 2, 'one stale pending record + one stale in-flight record');
    assert.equal(report.unparseableCount, 1, 'the un-parseable record is counted, not silently stale');
    assert.equal(
      report.healthyCount,
      report.totalRecords - report.staleCount - report.unparseableCount,
      'healthy + stale + unparseable == total',
    );
    assert.deepEqual(report.counts, {
      pending: 3,
      in_flight: 1,
      done: 1,
      failed: 1,
      human_reconciliation_required: 1,
      stale_alerted: 1,
    });
    assert.deepEqual(
      Object.keys(report.counts).sort(),
      [...CANONICAL_OUTBOX_STATUSES].sort(),
      'count keys exactly match the canonical outbox status allow-list',
    );
    assert.deepEqual(
      report.stale.map((entry) => entry.tier),
      ['stale', 'stale'],
    );

    assert.deepEqual(
      analyzeOutboxHealth([], NOW, STALE_MS).stale,
      [],
      'an empty outbox reports nothing stale',
    );
  }

  // ─── 6. The policy never mutates its input, and has no memory ───────────
  {
    const records = deepFreeze([
      fixture({ idempotencyKey: 'a', createdAt: minutesAgo(30) }),
      fixture({ idempotencyKey: 'b', status: 'done', createdAt: minutesAgo(30) }),
      fixture({ idempotencyKey: 'c', status: 'stale_alerted', lastAttemptAt: minutesAgo(15) }),
    ]);
    const before = JSON.stringify(records);

    const first = findStale(records, NOW, STALE_MS);
    const firstReport = analyzeOutboxHealth(records, NOW, STALE_MS);
    const lines = formatStaleReport(firstReport, { outboxPath: '/tmp/canary/voice-outbox.jsonl' });
    const second = findStale(records, NOW, STALE_MS);

    assert.equal(JSON.stringify(records), before, 'the records array is byte-identical after');
    assert.ok(Object.isFrozen(records[0]), 'the fixtures really were frozen (strict mode would throw)');
    assert.deepEqual(second, first, 'the monitor is stateless — the same input gives the same output');
    assert.ok(lines.every((line) => line.startsWith('[/tmp/canary/voice-outbox.jsonl]')));
  }

  // ─── 7. Redaction by construction: no payload, no error, ever ───────────
  {
    const withPii = fixture({
      idempotencyKey: 'pii',
      createdAt: minutesAgo(30),
      payload: { callerPhone: '+1 555-123-4567', notes: 'ring +1 555-123-4567' },
      error: 'dial failed for +1 555-123-4567',
    });
    const report = analyzeOutboxHealth([withPii], NOW, STALE_MS);
    const serialized = JSON.stringify(report);

    assert.equal(report.stale.length, 1);
    assert.ok(!serialized.includes('5551234567'), 'no phone digits may appear in a report');
    assert.ok(!serialized.includes('555-123-4567'), 'no formatted phone may appear in a report');
    assert.ok(!serialized.includes('"payload"'), 'a report never carries payload');
    assert.ok(!serialized.includes('"error"'), 'a report never carries error text');
    assert.ok(!('payload' in report.stale[0]), 'no payload key on a stale entry');
    assert.ok(!('error' in report.stale[0]), 'no error key on a stale entry');
    assert.deepEqual(
      Object.keys(report.stale[0]).sort(),
      [
        'ageMs',
        'attempts',
        'callSid',
        'createdAt',
        'id',
        'idempotencyKey',
        'kind',
        'lastAttemptAt',
        'status',
        'tier',
      ],
      'a stale entry carries identity and timing only',
    );
  }

  // ─── 8. Invalid inputs are refused loudly ───────────────────────────────
  {
    for (const window of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => findStale([], NOW, window),
        /voice_outbox_monitor_invalid_window/,
        `window ${window} is refused`,
      );
      assert.throws(
        () => analyzeOutboxHealth([], NOW, window),
        /voice_outbox_monitor_invalid_window/,
        `window ${window} is refused`,
      );
    }
    assert.throws(
      () => findStale([], new Date('nope'), STALE_MS),
      /voice_outbox_monitor_invalid_clock/,
      'an invalid clock is refused rather than defaulted to now',
    );
    assert.throws(
      () => findStale([], NOW, STALE_MS, { repeatMultiplier: 1 }),
      /voice_outbox_monitor_invalid_repeat_multiplier/,
      'a repeat multiplier below 2 would allow an alert storm',
    );
  }

  // ─── 9. The rendered report is text and says what it is ─────────────────
  {
    const quiet = formatStaleReport(analyzeOutboxHealth([], NOW, STALE_MS));
    assert.equal(quiet.length, 2, 'a clean outbox renders a header and a no-op line');
    assert.ok(quiet[0].includes('[voice-outbox]'));
    assert.ok(/nothing stale/.test(quiet[1]));

    const records = [
      fixture({ idempotencyKey: 'late', createdAt: minutesAgo(30), payload: { phone: '+15551234567' } }),
    ];
    const lines = formatStaleReport(analyzeOutboxHealth(records, NOW, STALE_MS), {
      outboxPath: 'data/voice-outbox.jsonl',
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('1 of 1 records stale'), 'the header states the count');
    assert.ok(joined.includes(`${STALE_MS}ms`), 'the header states the threshold');
    assert.ok(
      lines.some((line) => line.includes('reporting only')),
      'the report says plainly that it does not retry, write or deliver',
    );
    assert.ok(
      !joined.includes('5551234567'),
      'rendering a report cannot leak payload digits it never received',
    );
    assert.ok(lines.every((line) => typeof line === 'string'), 'the renderer returns strings only');
  }

  // ─── 10. Source proof: the monitor cannot act on the world ──────────────
  {
    const raw = readFileSync(resolve(__dirname, 'outbox-monitor.ts'), 'utf-8');
    // Capabilities are proven over CODE, with comments stripped: this module's
    // prose legitimately names the things it forbids ("no webhook"), and a
    // comment cannot call anything.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    assert.equal(
      [...code.matchAll(/^\s*import\s+(?!type\b)/gm)].length,
      0,
      'zero runtime imports — nothing the module could use to reach outside the process',
    );
    assert.ok(/^import type /m.test(code), 'the only import is a type import');
    assert.ok(!code.includes('node:'), 'no builtin module is referenced at all');

    const capability: ReadonlyArray<readonly [string, RegExp]> = [
      ['a file system surface', /\bfs\b|readFile|writeFile|appendFile|renameSync|mkdirSync|unlink|createReadStream|rmSync/i],
      ['a network surface', /\bfetch\s*\(|\bhttp\b|https|node:net|node:dns|\bnet\.|WebSocket|axios/i],
      ['a delivery surface', /sendOpsAlert|sendAlert|notify\s*\(|sendSms|webhook|publish/i],
      ['a process or timer surface', /process\.|child_process|setInterval|setTimeout|\.listen\s*\(/i],
      ['a printing surface', /console\./i],
      ['a direct clock read', /new Date\s*\(|Date\.now\s*\(/i],
      ['an outbox store surface', /new Outbox\s*\(|\.append\s*\(|markStatus|claimNext|loadC0Config/i],
    ];
    for (const [label, pattern] of capability) {
      assert.ok(!pattern.test(code), `outbox-monitor.ts must not contain ${label}`);
    }

    // Stated in the module itself, so the contract is readable at the source.
    assert.ok(raw.includes('no retry and no re-attempt'));
    assert.ok(raw.includes('Reporting is the entire contract'));
  }

  console.log('outbox-monitor.check OK');
}

main();
