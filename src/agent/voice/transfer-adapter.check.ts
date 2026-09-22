/**
 * Self-check for the canary-only transfer-adapter contract. No test framework —
 * run from the worktree root with:
 *
 *   npx tsx src/agent/voice/transfer-adapter.check.ts
 *
 * In-repo sources and fixture string maps only: no network, no credentials, no
 * process started, no service touched, nothing written to disk. Phone-like
 * fixtures use the reserved fictional range (555-01xx).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadC0Config } from './c0-config.js';
import {
  DIRECT_SCREENING_KINDS,
  TRANSFER_KINDS,
  TRANSFER_OUTCOME_STATUSES,
  TRANSFER_SCREENINGS,
  TRANSFER_TARGETS,
  TRANSFER_UNAVAILABLE_FIELDS,
  createInertTransferAdapter,
  resolveTransferKind,
  resolveTransferOutcome,
  resolveTransferScreening,
  resolveTransferTarget,
  transferAvailability,
  transferOutcomeSucceeded,
  validateTransferRequest,
  type TransferRequest,
  type TransferUnavailableOutcome,
} from './transfer-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FICTION_E164_A = '+15551230001';
const OPEN = loadC0Config({
  VOICE_C0_ENABLED: 'true',
  VOICE_C0_ALLOWLIST: FICTION_E164_A,
});

/** A phone-shaped detector, so "no destination leaked" is checked, not assumed. */
function hasPhoneShape(value: unknown): boolean {
  const text = JSON.stringify(value) ?? '';
  return /[+\d][\d\s().-]{8,}/.test(text);
}

function validRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    correlationId: 'CA-c0-0001',
    target: 'carter',
    kind: 'emergency',
    screening: 'direct',
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ─── 1. The shipped adapter is inert, and its outcome is destinationless ──
  {
    const adapter = createInertTransferAdapter();
    const outcome = (await adapter.dial(validRequest())) as TransferUnavailableOutcome;

    assert.equal(outcome.status, 'unavailable', 'the canary reports unavailable');
    assert.equal(outcome.attempted, false, 'nothing was attempted');
    assert.equal(outcome.available, false, 'nothing is available');
    assert.equal(outcome.reason, 'not_configured');
    assert.deepEqual(
      Object.keys(outcome).sort(),
      [...TRANSFER_UNAVAILABLE_FIELDS],
      'the outcome has a closed, destinationless shape',
    );
    assert.equal(
      hasPhoneShape(outcome),
      false,
      'an outcome may never carry a phone-shaped value',
    );

    // Each call is its own object, and every reason is still inert.
    const second = await adapter.dial(validRequest({ screening: 'whisper', kind: 'general' }));
    assert.notEqual(second, outcome, 'the adapter hands out fresh results');
    for (const reason of ['c0_disabled', 'allowlist_empty', 'caller_not_admitted'] as const) {
      const inert = (await createInertTransferAdapter(reason).dial(validRequest())) as
        TransferUnavailableOutcome;
      assert.equal(inert.reason, reason);
      assert.equal(inert.status, 'unavailable');
      assert.equal(inert.available, false);
      assert.equal(inert.attempted, false);
      assert.equal(hasPhoneShape(inert), false);
    }
  }

  // ─── 2. An invalid request is REJECTED, never turned into an outcome ─────
  {
    const adapter = createInertTransferAdapter();
    const rejections: ReadonlyArray<readonly [unknown, RegExp]> = [
      [null, /voice_transfer_invalid_request/],
      [undefined, /voice_transfer_invalid_request/],
      ['transfer', /voice_transfer_invalid_request/],
      [[], /voice_transfer_invalid_request/],
      [validRequest({ target: 'bob' as never }), /voice_transfer_invalid_target/],
      [validRequest({ target: FICTION_E164_A as never }), /voice_transfer_invalid_target/],
      [validRequest({ kind: 'urgent' as never }), /voice_transfer_invalid_kind/],
      [validRequest({ screening: 'silent' as never }), /voice_transfer_invalid_screening/],
      [
        validRequest({ kind: 'general', screening: 'direct' }),
        /voice_transfer_direct_screening_requires_emergency/,
      ],
      [validRequest({ correlationId: 'CA 123' }), /voice_transfer_invalid_correlation_id/],
      [validRequest({ correlationId: 'a'.repeat(65) }), /voice_transfer_invalid_correlation_id/],
      [validRequest({ correlationId: '' }), /voice_transfer_invalid_correlation_id/],
    ];
    for (const [bad, pattern] of rejections) {
      await assert.rejects(
        adapter.dial(bad as TransferRequest),
        pattern,
        `an invalid request must be rejected: ${JSON.stringify(bad)}`,
      );
      assert.throws(() => validateTransferRequest(bad), pattern);
    }

    // Whisper screening on an emergency is fine; the rule is one-directional.
    const whispered = (await adapter.dial(
      validRequest({ kind: 'emergency', screening: 'whisper' }),
    )) as TransferUnavailableOutcome;
    assert.equal(whispered.status, 'unavailable');
    assert.equal(DIRECT_SCREENING_KINDS.length, 1);
    assert.deepEqual([...DIRECT_SCREENING_KINDS], ['emergency']);
  }

  // ─── 3. A target is always a ROLE — never a number ───────────────────────
  {
    assert.deepEqual([...TRANSFER_TARGETS], ['carter', 'jaime']);
    assert.equal(
      /\d/.test(TRANSFER_TARGETS.join(',')),
      false,
      'no role may contain a digit, let alone a destination',
    );
    assert.equal(resolveTransferTarget('carter'), 'carter');
    assert.equal(resolveTransferTarget('jaime'), 'jaime');
    for (const notARole of [
      'Carter',
      'bob',
      '',
      ' ',
      'carter ',
      FICTION_E164_A,
      '5551230001',
      42,
      null,
      undefined,
      {},
      [],
    ]) {
      assert.equal(
        resolveTransferTarget(notARole),
        null,
        `${JSON.stringify(notARole)} is not a role`,
      );
    }
    assert.equal(resolveTransferKind('general'), 'general');
    assert.equal(resolveTransferKind('emergency'), 'emergency');
    assert.equal(resolveTransferKind('urgent'), null);
    assert.equal(resolveTransferScreening('whisper'), 'whisper');
    assert.equal(resolveTransferScreening('direct'), 'direct');
    assert.equal(resolveTransferScreening('none'), null);
    assert.deepEqual([...TRANSFER_KINDS], ['general', 'emergency']);
    assert.deepEqual([...TRANSFER_SCREENINGS], ['whisper', 'direct']);
  }

  // ─── 4. The outcome vocabulary is closed and 'unavailable' is not success ─
  {
    for (const status of TRANSFER_OUTCOME_STATUSES) {
      assert.equal(resolveTransferOutcome(status), status, `${status} round-trips`);
    }
    for (const unknown of ['success', 'ACCEPTED', 'accepted ', 'transferred', '', 42, null, undefined, {}]) {
      assert.equal(
        resolveTransferOutcome(unknown),
        'failed',
        `${JSON.stringify(unknown)} must never read as a success`,
      );
    }
    assert.equal(transferOutcomeSucceeded('accepted'), true);
    for (const notSuccess of ['unavailable', 'declined', 'no_answer', 'failed', 'success', null]) {
      assert.equal(transferOutcomeSucceeded(notSuccess), false, `${String(notSuccess)} is not a success`);
    }
  }

  // ─── 5. Availability is a report: every path says no ─────────────────────
  {
    const off = loadC0Config({});
    const onEmpty = loadC0Config({ VOICE_C0_ENABLED: 'true' });
    const matrix: ReadonlyArray<readonly [typeof OPEN, string | null | undefined, string]> = [
      [off, FICTION_E164_A, 'c0_disabled'],
      [off, undefined, 'c0_disabled'],
      [onEmpty, FICTION_E164_A, 'allowlist_empty'],
      [OPEN, '+15551239999', 'caller_not_admitted'],
      [OPEN, undefined, 'caller_not_admitted'],
      [OPEN, '5551230001', 'caller_not_admitted'],
      [OPEN, FICTION_E164_A, 'not_configured'],
    ];
    for (const [config, caller, expected] of matrix) {
      const availability = transferAvailability(config, caller);
      assert.equal(availability.reason, expected, `availability for ${String(caller)}`);
      assert.equal(availability.available, false, 'availability is never true at this stage');
    }

    // The widest possible configuration still cannot place a call: the gates
    // being open is exactly the case that reports "no adapter configured".
    const widest = createInertTransferAdapter(
      transferAvailability(OPEN, FICTION_E164_A).reason,
    );
    const outcome = (await widest.dial(validRequest())) as TransferUnavailableOutcome;
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.reason, 'not_configured');
    assert.equal(outcome.available, false);
    assert.equal(outcome.attempted, false);
  }

  // ─── 6. §0 source invariants for the adapter source ─────────────────────
  {
    const src = readFileSync(resolve(__dirname, 'transfer-adapter.ts'), 'utf-8');

    const specifiers = [...src.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(specifiers, ['./c0-config.js'], 'the adapter imports only the local contract');
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./'));
    }

    const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
      ['the production relay module', /voice-server/i],
      ['the production relay protocol', /conversationrelay/i],
      ['the telephony provider', /twilio/i],
      ['the realtime transport vendor', /livekit/i],
      ['a third-party model provider', /openai/i],
      ['the CRM vendor', /housecall/i],
      ['the CRM abbreviation', /\bhcp\b/i],
      ['the hypervisor host', /proxmox/i],
      ['the deploy host', /ct102/i],
      ['an embedded SQL database', /sqlite/i],
      ['a third-party HTTP/client package', /axios|@mastra|node-fetch|\bzod\b/i],
      ['a network call', /\bfetch\s*\(|node:https?|node:net|node:dns|WebSocket/i],
      ['a subprocess', /child_process|spawnSync|spawn\s*\(/i],
      ['a daemon/process shape', /setInterval|setTimeout|\.listen\s*\(|process\.exit/i],
      ['a CommonJS require', /\brequire\s*\(/],
      ['a phone-shaped literal', /\+\d{7,}/],
    ];
    for (const [label, pattern] of forbidden) {
      assert.ok(!pattern.test(src), `transfer-adapter.ts must not reference ${label}`);
    }

    assert.ok(!src.includes('process.env'), 'the adapter must not read the environment itself');
    assert.ok(!src.includes('console.'), 'the adapter must not print');
    assert.ok(!src.includes('Date.now'), 'the adapter must not read a clock');
    assert.ok(!src.includes('node:fs'), 'the adapter must not touch storage');
    assert.ok(!/available:\s*true/.test(src), 'nothing may report availability');
    assert.ok(!/attempted:\s*true/.test(src), 'nothing may report an attempt');
    assert.ok(
      !/export\s+(?:async\s+)?(?:function|const)\s+\w*(?:number|phone|destination|dialTarget)\w*/i.test(
        src,
      ),
      'no export may resolve a destination',
    );
    assert.ok(
      /status:\s*'unavailable'/.test(src),
      'the shipped outcome is unavailable, literally',
    );
  }

  console.log('transfer-adapter.check OK');
}

await main();
