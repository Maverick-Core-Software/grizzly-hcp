/**
 * Self-check for the C0 controller contract. No test framework — run from the
 * worktree root with:
 *
 *   npx tsx src/agent/voice/c0-controller.check.ts
 *
 * Everything below runs against a temp directory and in-repo sources only: no
 * network, no credentials, no process started, no service touched. Phone-like
 * fixtures use the reserved fictional range (555-01xx); the expected masked
 * forms come from `maskPhone`, so no assertion depends on eyeballing digits.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadC0Config } from './c0-config.js';
import {
  IDEMPOTENCY_KEY_RE,
  Outbox,
  maskPhone,
  type OutboxAppendInput,
  type OutboxAppendResult,
} from './outbox.js';
import {
  C0_ENQUEUE_KINDS,
  C0_ENQUEUED_RESULT_FIELDS,
  C0_INERT_RESULT_FIELDS,
  createC0Controller,
  deriveTurnIdempotencyKey,
  isAlreadyRedacted,
  planC0Enqueue,
  type C0Controller,
  type C0EnqueuedResult,
  type C0EnqueueRequest,
  type C0InertResult,
  type C0OutboxSink,
  type C0Plan,
  type C0ReadyPlan,
  type C0RefusalReason,
  type C0TurnResult,
} from './c0-controller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..'); // src/agent/voice → repo root

// Reserved fictional range only — 555-01xx can never be a real subscriber.
const FICTION_E164_A = '+15551230001';
const FICTION_E164_B = '+15551230002';
const FICTION_MASK_A = '+155****0001';
const FICTION_MASK_B = '+155****0002';
const CORRELATION = 'CA-c0-0001';
const TURN_PAYLOAD: Record<string, unknown> = { note: 'gate code 4', zone: 'north' };

const OFF = loadC0Config({});
const ON_EMPTY_ALLOWLIST = loadC0Config({ VOICE_C0_ENABLED: 'true' });
const ON = loadC0Config({
  VOICE_C0_ENABLED: 'true',
  VOICE_C0_ALLOWLIST: `${FICTION_E164_A},${FICTION_E164_B}`,
});

function request(overrides: Partial<C0EnqueueRequest> = {}): C0EnqueueRequest {
  return {
    callerE164: FICTION_E164_A,
    correlationId: CORRELATION,
    intentSequence: 1,
    payloadVersion: 1,
    record: { redacted: true, kind: 'transfer', payload: TURN_PAYLOAD },
    ...overrides,
  };
}

/** A store wrapper that records every call, so "no write" is observable. */
function counted(inner: C0OutboxSink): { sink: C0OutboxSink; calls: OutboxAppendInput[] } {
  const calls: OutboxAppendInput[] = [];
  return {
    calls,
    sink: {
      append(input: OutboxAppendInput): OutboxAppendResult {
        calls.push(input);
        return inner.append(input);
      },
    },
  };
}

function isInertResult(result: C0TurnResult): result is C0InertResult {
  return result.status === 'inert';
}

function isReadyPlan(plan: C0Plan): plan is C0ReadyPlan {
  return plan.outcome === 'ready';
}

/** Narrow to the inert variant and pin the three "nothing happened" flags. */
function expectInert(result: C0TurnResult): C0InertResult {
  assert.ok(isInertResult(result), `expected an inert result, saw ${result.status}`);
  assert.equal(result.performed, false, 'an inert result performed nothing');
  assert.equal(result.delivered, false, 'an inert result delivered nothing');
  assert.equal(result.enqueued, false, 'an inert result enqueued nothing');
  assert.deepEqual(Object.keys(result).sort(), [...C0_INERT_RESULT_FIELDS], 'closed inert shape');
  return result;
}

/** Narrow to the enqueued variant and pin the two "still not an action" flags. */
function expectEnqueued(result: C0TurnResult): C0EnqueuedResult {
  assert.ok(!isInertResult(result), 'expected an enqueued result');
  assert.equal(result.performed, false, 'enqueueing is not an action');
  assert.equal(result.delivered, false, 'enqueueing is not a delivery');
  assert.equal(result.enqueued, true);
  assert.equal(result.reason, null);
  assert.deepEqual(Object.keys(result).sort(), [...C0_ENQUEUED_RESULT_FIELDS], 'closed shape');
  return result;
}

function refusal(result: C0TurnResult): C0RefusalReason {
  return expectInert(result).reason;
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'voice-c0-controller-'));
  try {
    const storePath = join(dir, 'voice-outbox.jsonl');
    const store = new Outbox({ path: storePath });
    const { sink, calls } = counted(store);
    const controller: C0Controller = createC0Controller({ config: ON, outbox: sink });

    // ─── 0. Fixture sanity: the masked forms are the ones asserted on ──────
    {
      assert.equal(maskPhone(FICTION_E164_A), FICTION_MASK_A);
      assert.equal(maskPhone(FICTION_E164_B), FICTION_MASK_B);
      assert.notEqual(FICTION_MASK_A, FICTION_MASK_B);
    }

    // ─── 1. Disabled by default: an inert result and NO store call ─────────
    {
      const off = createC0Controller({ config: OFF, outbox: sink });
      const result = expectInert(off.enqueue(request()));
      assert.equal(result.reason, 'disabled_flag_off');
      assert.deepEqual(result.gate, { allowed: false, reason: 'disabled_flag_off' });
      assert.deepEqual(off.evaluate(FICTION_E164_A), {
        allowed: false,
        reason: 'disabled_flag_off',
      });
      assert.equal(calls.length, 0, 'a closed gate must not reach the store');
      assert.equal(store.list().length, 0);
    }

    // ─── 2. Flag on + empty allow-list refuses even a valid caller ─────────
    {
      const empty = createC0Controller({ config: ON_EMPTY_ALLOWLIST, outbox: sink });
      const result = expectInert(empty.enqueue(request()));
      assert.equal(result.reason, 'allowlist_empty');
      assert.deepEqual(result.gate, { allowed: false, reason: 'allowlist_empty' });
      assert.equal(calls.length, 0);
    }

    // ─── 3. Caller preconditions ───────────────────────────────────────────
    {
      const missing = expectInert(controller.enqueue(request({ callerE164: undefined })));
      assert.equal(missing.reason, 'caller_missing');
      assert.deepEqual(missing.gate, { allowed: false, reason: 'caller_missing' });
      assert.equal(refusal(controller.enqueue(request({ callerE164: null }))), 'caller_missing');
      assert.equal(
        refusal(controller.enqueue(request({ callerE164: '+15551239999' }))),
        'caller_not_allowlisted',
      );
      // A caller number is never repaired; a non-E.164 caller is refused.
      assert.equal(
        refusal(controller.enqueue(request({ callerE164: '5551230001' }))),
        'caller_not_allowlisted',
      );

      // ...and the second allow-listed caller IS admitted.
      const second = expectEnqueued(
        controller.enqueue(request({ callerE164: FICTION_E164_B, correlationId: 'CA-c0-0002' })),
      );
      assert.equal(second.created, true);
      assert.equal(calls.length, 1, 'only the admitted caller reached the store');
      assert.equal(calls[0].callSid, 'CA-c0-0002');
      assert.equal(store.list().length, 1);
    }

    // ─── 4. Correlation preconditions ──────────────────────────────────────
    {
      const before = calls.length;
      for (const correlationId of [undefined, null, '']) {
        const result = expectInert(controller.enqueue(request({ correlationId })));
        assert.equal(result.reason, 'correlation_missing', `correlation ${String(correlationId)}`);
        assert.equal(result.gate, null, 'a non-gate refusal carries no gate');
      }
      for (const correlationId of ['CA 123', 'a'.repeat(65), 'CA+15551230001', 'CA/1']) {
        assert.equal(
          refusal(controller.enqueue(request({ correlationId }))),
          'correlation_malformed',
          `correlation ${correlationId}`,
        );
      }
      for (const intentSequence of [0, -1, 1.5, Number.NaN, '1']) {
        assert.equal(
          refusal(controller.enqueue(request({ intentSequence } as Partial<C0EnqueueRequest>))),
          'intent_sequence_malformed',
          `intent sequence ${String(intentSequence)}`,
        );
      }
      assert.equal(calls.length, before, 'no correlation failure reached the store');
    }

    // ─── 5. The FIRST failed precondition decides the result ───────────────
    {
      const refused = expectInert(
        controller.enqueue(
          request({
            callerE164: '+15551239999',
            correlationId: 'bad correlation',
            record: { redacted: false, kind: 'nope' } as unknown as C0EnqueueRequest['record'],
          }),
        ),
      );
      assert.equal(
        refused.reason,
        'caller_not_allowlisted',
        'the gate is settled before correlation or record',
      );
    }

    // ─── 6. The one write: an already-redacted record, enqueued ────────────
    {
      const { sink: freshSink, calls: freshCalls } = counted(store);
      const fresh = createC0Controller({ config: ON, outbox: freshSink });
      const result = expectEnqueued(
        fresh.enqueue(
          request({
            correlationId: 'CA-c0-0003',
            record: {
              redacted: true,
              kind: 'booking',
              target: 'carter',
              payload: { note: 'panel swap', zone: 'north' },
            },
          }),
        ),
      );

      assert.equal(result.status, 'enqueued');
      assert.equal(result.created, true);
      assert.match(result.idempotencyKey, IDEMPOTENCY_KEY_RE, 'the key is store-legal');
      assert.ok(result.idempotencyKey.startsWith('c0.delivery.'), 'the key names the cross-kind delivery identity');
      assert.equal(result.recordId, result.record.id, 'the reported id is the stored id');

      assert.equal(freshCalls.length, 1);
      assert.equal(freshCalls[0].callSid, 'CA-c0-0003', 'the correlation id is the call identity');
      assert.equal(freshCalls[0].kind, 'booking');
      assert.equal(freshCalls[0].target, 'carter');
      assert.deepEqual(freshCalls[0].payload, { note: 'panel swap', zone: 'north' });

      const persisted = store.find(result.idempotencyKey);
      assert.ok(persisted, 'the record is durable');
      assert.equal(persisted.status, 'pending', 'a queued record is never pre-marked done');
      assert.deepEqual(persisted.payload, { note: 'panel swap', zone: 'north' });
    }

    // ─── 7. Replay is a duplicate, across instances too ────────────────────
    {
      const callSid = `CA${'a'.repeat(32)}`;
      const service = expectEnqueued(controller.enqueueServiceIntent({
        callSid,
        callerE164: FICTION_E164_A,
        intentSequence: 7,
        payloadVersion: 2,
        intent: {
          name: 'Test Caller',
          callbackE164: FICTION_E164_A,
          serviceAddress: '101 Main Street',
          scope: 'Panel inspection',
          preferredWindows: 'Tuesday morning',
          callerConfirmed: true,
        },
      }));
      assert.equal(service.record.kind, 'service_intent');
      assert.equal(service.record.payload.callbackE164, FICTION_E164_A, 'durable payload retains the callback');
      assert.equal(service.record.payload.serviceAddress, '101 Main Street');
      assert.equal(service.record.payloadVersion, 2);
      assert.equal(
        expectEnqueued(controller.enqueueServiceIntent({
          callSid, callerE164: FICTION_E164_A, intentSequence: 7, payloadVersion: 2,
          intent: {
            name: 'Test Caller', callbackE164: FICTION_E164_A, serviceAddress: '101 Main Street',
            scope: 'Panel inspection', preferredWindows: 'Tuesday morning', callerConfirmed: true,
          },
        })).status,
        'duplicate',
      );
      assert.equal(
        refusal(controller.enqueueServiceIntent({
          callSid, callerE164: FICTION_E164_A, intentSequence: 8, payloadVersion: 2,
          intent: {
            name: 'Test Caller', callbackE164: FICTION_E164_A, serviceAddress: '101 Main Street',
            scope: 'Contact me at somebody@example.com', preferredWindows: 'Tuesday morning', callerConfirmed: true,
          },
        })),
        'service_intent_invalid',
      );
      for (const field of ['name', 'scope', 'preferredWindows', 'serviceAddress'] as const) {
        for (const value of ['4111 1111 1111 1111', '٤١١١ ١١١١ ١١١١ ١١١١', '۴۱۱۱ ۱۱۱۱ ۱۱۱۱ ۱۱۱۱', '४१११ ११११ ११११ ११११', '৪১১১ ১১১১ ১১১১ ১১১১', '4111-1111-1111-1111', '4111–1111–1111–1111', '4111‑1111‑1111‑1111', '4111 1111 1111 1111', '４１１１ １１１１ １１１１ １１１１', '+1 (555) 123-4567', '555.123.4567', '4111 and 1111 and 1111 and 1111', 'word4111 1111 1111 1111word']) {
          const intent = { name: 'Test Caller', callbackE164: FICTION_E164_A, serviceAddress: '101 Main Street', scope: 'Panel inspection', preferredWindows: 'Tuesday morning', callerConfirmed: true as const };
          intent[field] = value;
          assert.equal(refusal(controller.enqueueServiceIntent({ callSid, callerE164: FICTION_E164_A, intentSequence: 100 + value.length + field.length, payloadVersion: 2, intent })), 'service_intent_invalid', `${field} rejects formatted sensitive digits`);
        }
      }
      assert.equal(
        refusal(controller.enqueueServiceIntent({
          callSid: 'CA-not-valid', callerE164: FICTION_E164_A, intentSequence: 8, payloadVersion: 2,
          intent: {
            name: 'Test Caller', callbackE164: FICTION_E164_A, serviceAddress: '101 Main Street',
            scope: 'Panel inspection', preferredWindows: 'Tuesday morning', callerConfirmed: true,
          },
        })),
        'call_sid_malformed',
      );
      const transfer = expectEnqueued(controller.enqueueTransferRequest({
        callSid, callerE164: FICTION_E164_A, intentSequence: 8, role: 'office',
      }));
      assert.deepEqual(transfer.record.payload, { role: 'office' });
      assert.equal(refusal(controller.enqueueTransferRequest({
        callSid, callerE164: FICTION_E164_A, intentSequence: 9, role: 'office-number' as never,
      })), 'transfer_role_invalid');
      const snapshot = store.snapshot();
      const visible = JSON.stringify(snapshot);
      assert.ok(!visible.includes(FICTION_E164_A));
      assert.ok(!visible.includes('Test Caller'));
      assert.ok(!visible.includes('101 Main Street'));
    }

    // ─── 8. Replay is a duplicate, across instances too ────────────────────
    {
      const first = expectEnqueued(controller.enqueue(request({ correlationId: 'CA-c0-0004' })));
      assert.equal(first.created, true);

      const replay = expectEnqueued(controller.enqueue(request({ correlationId: 'CA-c0-0004' })));
      assert.equal(replay.status, 'duplicate');
      assert.equal(replay.created, false);
      assert.equal(replay.idempotencyKey, first.idempotencyKey, 'a replay recomputes the same key');

      // A fresh store + controller over the same file: process-restart replay.
      const restarted = createC0Controller({
        config: ON,
        outbox: new Outbox({ path: storePath }),
      });
      const afterRestart = expectEnqueued(
        restarted.enqueue(request({ correlationId: 'CA-c0-0004' })),
      );
      assert.equal(afterRestart.status, 'duplicate');
      assert.equal(afterRestart.created, false);

      const lines = readFileSync(storePath, 'utf-8').trim().split('\n');
      assert.equal(
        lines.filter((line) => line.includes('CA-c0-0004')).length,
        1,
        'one key ⇒ exactly one durable line',
      );
    }

    // ─── 8. The idempotency input is deterministic and closed ──────────────
    {
      const base = deriveTurnIdempotencyKey({
        correlationId: CORRELATION, kind: 'transfer', intentSequence: 1, payloadVersion: 1,
      });
      assert.match(base, IDEMPOTENCY_KEY_RE);
      assert.equal(
        base,
        deriveTurnIdempotencyKey({ correlationId: CORRELATION, kind: 'transfer', intentSequence: 1, payloadVersion: 1 }),
        'the same confirmed intent and payload version is stable',
      );
      assert.notEqual(
        base,
        deriveTurnIdempotencyKey({ correlationId: CORRELATION, kind: 'transfer', intentSequence: 2, payloadVersion: 1 }),
      );
      assert.notEqual(
        base,
        deriveTurnIdempotencyKey({ correlationId: CORRELATION, kind: 'transfer', intentSequence: 1, payloadVersion: 2 }),
      );
      assert.notEqual(
        base,
        deriveTurnIdempotencyKey({ correlationId: 'CA-c0-0009', kind: 'transfer', intentSequence: 1, payloadVersion: 1 }),
      );
      assert.equal(
        base,
        deriveTurnIdempotencyKey({ correlationId: CORRELATION, kind: 'message', intentSequence: 1, payloadVersion: 1 }),
        'a kind change cannot bypass the tuple delivery identity',
      );

      // Payload text is NOT an input to the key.
      const planA = planC0Enqueue(
        ON,
        request({
          correlationId: 'CA-c0-0005',
          record: { redacted: true, kind: 'transfer', payload: { note: 'a' } },
        }),
      );
      const planB = planC0Enqueue(
        ON,
        request({
          correlationId: 'CA-c0-0005',
          record: { redacted: true, kind: 'transfer', payload: { note: 'b' } },
        }),
      );
      assert.ok(isReadyPlan(planA) && isReadyPlan(planB));
      assert.equal(planA.idempotencyKey, planB.idempotencyKey);

      // ...and an unvalidated key input fails with a typed code.
      assert.throws(
        () => deriveTurnIdempotencyKey({ correlationId: 'bad id', kind: 'transfer', intentSequence: 1, payloadVersion: 1 }),
        /c0_invalid_correlation_id/,
      );
      assert.throws(
        () => deriveTurnIdempotencyKey({ correlationId: CORRELATION, kind: 'ops_alert', intentSequence: 1, payloadVersion: 1 }),
        /c0_invalid_kind/,
      );
      assert.throws(
        () =>
          deriveTurnIdempotencyKey({
            correlationId: CORRELATION,
            kind: 'transfer',
            intentSequence: 0,
            payloadVersion: 1,
          }),
        /c0_invalid_intent_sequence/,
      );
    }

    // ─── 9. Only an already-redacted record may be enqueued ────────────────
    {
      const before = calls.length;
      assert.equal(isAlreadyRedacted(TURN_PAYLOAD), true, 'the fixture is already redacted');

      assert.equal(
        refusal(
          controller.enqueue(
            request({ record: { kind: 'transfer' } as unknown as C0EnqueueRequest['record'] }),
          ),
        ),
        'record_not_redacted',
        'the redaction assertion is required',
      );
      assert.equal(
        refusal(
          controller.enqueue(
            request({
              record: { redacted: false, kind: 'transfer' } as unknown as C0EnqueueRequest['record'],
            }),
          ),
        ),
        'record_not_redacted',
      );
      assert.equal(
        refusal(
          controller.enqueue({
            callerE164: FICTION_E164_A,
            correlationId: CORRELATION,
            intentSequence: 1,
            payloadVersion: 1,
          } as C0EnqueueRequest),
        ),
        'record_not_redacted',
        'a missing record is a refusal, not a crash',
      );

      // A payload that would change under redaction is REFUSED, not masked.
      const dirtyPayloads: Record<string, unknown>[] = [
        { callback: '+15551230009' },
        { note: 'reach me at +1 555 123 0009' },
        { contactEmail: 'someone@example.com' },
        { note: 15551230009 },
        // The embedded case: free-form text with a STANDALONE 10-digit run and
        // no separators anywhere in it. A record that asserts `redacted: true`
        // must still be refused while redaction would change a byte of it.
        { followUp: 'called back about 5551230101 but no answer' },
      ];
      for (const payload of dirtyPayloads) {
        assert.equal(isAlreadyRedacted(payload), false, `${JSON.stringify(payload)} is dirty`);
        assert.equal(
          refusal(controller.enqueue(request({ record: { redacted: true, kind: 'transfer', payload } }))),
          'record_not_redacted',
          JSON.stringify(payload),
        );
      }
      assert.equal(calls.length, before, 'no unredacted payload reached the store');

      const onDisk = readFileSync(storePath, 'utf-8');
      assert.ok(!onDisk.includes('5551230009'), 'the raw fixture never reached disk');
      assert.ok(
        !onDisk.includes('5551230101'),
        'the embedded raw run never reached disk either',
      );
      assert.ok(!onDisk.includes('someone@example.com'), 'no e-mail address reached disk');
    }

    // ─── 10. Payload and kind preconditions ────────────────────────────────
    {
      const before = calls.length;
      assert.equal(
        refusal(
          controller.enqueue(
            request({
              record: {
                redacted: true,
                kind: 'transfer',
                payload: [] as unknown as Record<string, unknown>,
              },
            }),
          ),
        ),
        'payload_invalid',
        'an array is not a payload object',
      );
      assert.equal(
        refusal(
          controller.enqueue(
            request({ record: { redacted: true, kind: 'transfer', payload: { note: 'x'.repeat(9_000) } } }),
          ),
        ),
        'payload_invalid',
        'an oversized payload is refused here, not thrown by the store',
      );
      assert.equal(
        refusal(
          controller.enqueue(request({ record: { redacted: true, kind: 'transfer', target: 'not a target!' } })),
        ),
        'payload_invalid',
      );

      for (const kind of ['ops_alert', 'note', 'not-a-kind', '', 'TRANSFER']) {
        assert.equal(
          refusal(
            controller.enqueue(
              request({ record: { redacted: true, kind } as unknown as C0EnqueueRequest['record'] }),
            ),
          ),
          'kind_not_accepted',
          `kind ${JSON.stringify(kind)}`,
        );
      }
      assert.ok(
        C0_ENQUEUE_KINDS.every((kind) => kind !== 'ops_alert' && kind !== 'note'),
        'the controller vocabulary is narrower than the store vocabulary',
      );
      assert.equal(calls.length, before);
    }

    // ─── 11. Fail closed when the store refuses, throws or lies ────────────
    {
      const refusing: C0OutboxSink = {
        append(): OutboxAppendResult {
          throw new Error('voice_outbox_invalid_kind');
        },
      };
      const refused = expectInert(
        createC0Controller({ config: ON, outbox: refusing }).enqueue(request()),
      );
      assert.equal(refused.reason, 'outbox_rejected');
      assert.equal(refused.gate, null);

      const lying: C0OutboxSink = {
        append: (() => undefined) as unknown as (input: OutboxAppendInput) => OutboxAppendResult,
      };
      assert.equal(
        refusal(createC0Controller({ config: ON, outbox: lying }).enqueue(request())),
        'outbox_rejected',
        'a broken store result is caught, never read as success',
      );

      // A broken composition is refused at construction, loudly and typed.
      assert.throws(
        () => createC0Controller({ config: ON, outbox: null as unknown as C0OutboxSink }),
        /c0_controller_invalid_outbox/,
      );
      assert.throws(
        () => createC0Controller({} as unknown as { config: typeof ON; outbox: C0OutboxSink }),
        /c0_controller_invalid_config/,
      );
    }

    // ─── 12. The decision is pure: no store, no clock, no mutation ─────────
    {
      const frozenConfig = Object.freeze({ ...ON, allowlist: Object.freeze([...ON.allowlist]) });
      const frozenPayload = Object.freeze({ note: 'call back after 4' });
      const frozenRequest = Object.freeze({
        callerE164: FICTION_E164_A,
        correlationId: 'CA-c0-0006',
        intentSequence: 1,
        payloadVersion: 1,
        record: Object.freeze({ redacted: true as const, kind: 'message' as const, payload: frozenPayload }),
      });

      const plan = planC0Enqueue(frozenConfig, frozenRequest as unknown as C0EnqueueRequest);
      assert.ok(isReadyPlan(plan), 'a frozen, valid request plans cleanly');
      assert.deepEqual(
        Object.keys(plan).sort(),
        ['correlationId', 'idempotencyKey', 'intentSequence', 'kind', 'outcome', 'payload', 'payloadVersion'],
        'a ready plan carries exactly the store inputs plus the outcome',
      );
      assert.equal(plan.correlationId, 'CA-c0-0006');
      assert.equal(plan.kind, 'message');
      assert.deepEqual(plan.payload, { note: 'call back after 4' });
      assert.deepEqual(frozenRequest.record.payload, { note: 'call back after 4' }, 'input not mutated');

      const gateOnly = planC0Enqueue(OFF, frozenRequest as unknown as C0EnqueueRequest);
      assert.deepEqual(Object.keys(gateOnly).sort(), ['gate', 'outcome', 'reason']);
      assert.ok(!isReadyPlan(gateOnly));
      assert.equal(gateOnly.reason, 'disabled_flag_off');
      assert.equal(gateOnly.gate?.allowed, false);
    }

    // ─── 13. §0 source invariants for this stage's new sources ─────────────
    {
      const sources = readdirSync(__dirname)
        .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.check.ts'))
        .sort();
      assert.ok(
        sources.includes('c0-controller.ts') && sources.includes('transfer-adapter.ts'),
        'the invariant scan sees this stage\u2019s new sources',
      );

      const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
        ['the production relay module', /voice-server/i],
        ['the production relay protocol', /conversationrelay/i],
        ['the telephony provider', /twilio/i],
        ['the realtime transport vendor', /livekit/i],
        ['a third-party model provider', /openai/i],
        ['the CRM vendor', /housecall/i],
        ['the hypervisor host', /proxmox/i],
        ['the deploy host', /ct102/i],
        ['an embedded SQL database', /sqlite/i],
        ['a third-party HTTP/client package', /axios|@mastra|node-fetch|\bzod\b/i],
        ['a network call', /\bfetch\s*\(|node:https?|node:net|node:dns|WebSocket/i],
        ['a subprocess', /child_process|spawnSync|spawn\s*\(/i],
        ['a daemon/process shape', /setInterval|setTimeout|\.listen\s*\(|process\.exit/i],
        ['the CRM abbreviation', /\bhcp\b/i],
        ['a CommonJS require', /\brequire\s*\(/],
        ['a phone-shaped literal', /\+\d{7,}/],
      ];

      for (const file of ['c0-controller.ts', 'transfer-adapter.ts']) {
        const src = readFileSync(resolve(__dirname, file), 'utf-8');
        assert.ok(!src.includes('process.env'), `${file} must not read the environment itself`);
        assert.ok(!src.includes('console.'), `${file} must not print`);
        assert.ok(!src.includes('Date.now'), `${file} must not read a clock`);
        const specifiers = [...src.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)].map((m) => m[1]);
        assert.ok(specifiers.length > 0, `${file} declares its imports explicitly`);
        for (const specifier of specifiers) {
          assert.ok(
            specifier.startsWith('node:') || specifier.startsWith('./'),
            `${file} may import only node builtins or C0-local siblings (saw ${specifier})`,
          );
        }
        for (const [label, pattern] of forbidden) {
          assert.ok(!pattern.test(src), `${file} must not reference ${label}`);
        }
      }

      const controllerSrc = readFileSync(resolve(__dirname, 'c0-controller.ts'), 'utf-8');
      assert.ok(
        controllerSrc.includes('evaluateC0Gate('),
        'the controller takes its decision from the config contract, not its own flag',
      );
      assert.ok(controllerSrc.includes('performed: false'), 'every result is marked not-performed');
      assert.ok(controllerSrc.includes('delivered: false'), 'every result is marked not-delivered');
      assert.ok(!/delivered:\s*true/.test(controllerSrc), 'nothing may report a delivery');
      assert.ok(!/enqueued:\s*false\s*;\s*\/\//.test(controllerSrc));

      const transferSrc = readFileSync(resolve(__dirname, 'transfer-adapter.ts'), 'utf-8');
      assert.ok(transferSrc.includes('attempted: false'), 'the shipped adapter attempts nothing');
      assert.ok(!/available:\s*true/.test(transferSrc), 'nothing may report availability');
      assert.ok(!/attempted:\s*true/.test(transferSrc), 'nothing may report an attempt');
      assert.ok(
        !/export\s+(?:async\s+)?(?:function|const)\s+\w*(?:number|phone|destination|dialTarget)\w*/i.test(
          transferSrc,
        ),
        'no export may resolve a destination',
      );
    }

    // ─── 14. No check may create the repo's own outbox path ────────────────
    {
      assert.equal(existsSync(resolve(repoRoot, 'data/voice-outbox.jsonl')), false);
      assert.equal(existsSync(resolve(repoRoot, 'data/voice-outbox.jsonl.tmp')), false);
    }

    console.log('c0-controller.check OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
