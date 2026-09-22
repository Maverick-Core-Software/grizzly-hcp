/**
 * Self-check for the C0 durable outbox. No test framework — run from the
 * worktree root with:
 *
 *   npx tsx src/agent/voice/outbox.check.ts
 *
 * Everything runs in a fresh temp directory. The repo's own
 * `data/voice-outbox.jsonl` is never created, read or written. The phone and
 * e-mail fixtures are the reserved fictional range / example.com — no real
 * caller data appears in this file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OUTBOX_PATH,
  IDEMPOTENCY_KEY_RE,
  MAX_PAYLOAD_CHARS,
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  Outbox,
  countByStatus,
  deriveRecordId,
} from './outbox.js';
import type { OutboxKind } from './outbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** Reserved fictional number (555-01xx / 555-123-4567) — never a real line. */
const FICTION_PHONE = '+1 555-123-4567';
const FICTION_PHONE_COMPACT = '+155****4567';
/**
 * A reserved-fictional 10-digit run written with NO separators, so it appears
 * inside a phrase exactly the way a bare number does in free-form text. The
 * grouped pattern cannot see it — this is the embedded case.
 */
const FICTION_DIGITS_BARE = '5551230101';
const FICTION_DIGITS_BARE_MASKED = '555****0101';
const FICTION_EMAIL = 'caller@example.com';
const STAMP_1 = '2026-09-22T15:01:00.000Z';
const STAMP_2 = '2026-09-22T15:02:00.000Z';
const STAMP_3 = '2026-09-22T15:03:00.000Z';

const TRANSFER_KEY = 'call:CA1:transfer';

function linesOf(file: string): string[] {
  return fs.readFileSync(file, 'utf-8').split('\n').filter((line) => line.trim() !== '');
}

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-c0-outbox-'));
  const file = path.join(dir, 'voice-outbox.jsonl');
  const clock = { at: new Date(STAMP_1) };
  const outbox = new Outbox({ path: file, now: () => clock.at });
  const context = `temp dir ${dir}`;

  try {
    // ─── 1. A write is durable and starts pending ───────────────────────────
    {
      const first = outbox.append({
        idempotencyKey: TRANSFER_KEY,
        callSid: 'CA1',
        kind: 'transfer',
        target: 'carter',
        payload: { reason: 'panel arcing', callerPhone: FICTION_PHONE },
      });
      assert.equal(first.created, true, 'the first write creates the record');
      assert.equal(first.record.status, 'pending', 'a record exists before the action runs');
      assert.equal(first.record.attempts, 0);
      assert.equal(first.record.createdAt, STAMP_1, 'the injected clock stamps creation');
      assert.equal(first.record.lastAttemptAt, null);
      assert.equal(first.record.id, deriveRecordId(TRANSFER_KEY), 'ids are deterministic');
      assert.match(first.record.id, /^ob_[0-9a-f]{20}$/);
      assert.equal(linesOf(file).length, 1, 'one append ⇒ exactly one durable line');
    }

    // ─── 2. Idempotency: a repeated key writes nothing ──────────────────────
    {
      const again = outbox.append({
        idempotencyKey: TRANSFER_KEY,
        callSid: 'CA1',
        kind: 'transfer',
        payload: { reason: 'panel arcing' },
      });
      assert.equal(again.created, false, 'a duplicate key is not written again');
      assert.equal(again.record.id, deriveRecordId(TRANSFER_KEY));
      assert.equal(linesOf(file).length, 1, 'a duplicate key adds no second record');
    }

    // ─── 3. Dedupe holds across reopen (a restart replay) ───────────────────
    {
      const reopened = new Outbox({ path: file, now: () => clock.at });
      const records = reopened.list();
      assert.equal(records.length, 1, 'a reopened file sees exactly one record per key');
      assert.equal(
        records[0].payload.callerPhone,
        FICTION_PHONE,
        'the durable payload survives the round trip',
      );

      const acrossReopen = reopened.append({
        idempotencyKey: TRANSFER_KEY,
        callSid: 'CA1',
        kind: 'transfer',
      });
      assert.equal(acrossReopen.created, false, 'dedupe holds across reopen');
      assert.equal(linesOf(file).length, 1);
    }

    // ─── 4. Keys are opaque: PII cannot be smuggled into the key ────────────
    {
      const before = linesOf(file).length;
      for (const bad of [FICTION_PHONE_COMPACT, '5551230001', 'short', 'has space', FICTION_EMAIL, 'ca+1', 'a'.repeat(129)]) {
        assert.throws(
          () => outbox.append({ idempotencyKey: bad, callSid: 'CA1', kind: 'transfer' }),
          /voice_outbox_invalid_idempotency_key/,
          `the key ${JSON.stringify(bad)} is refused`,
        );
      }
      assert.ok(!IDEMPOTENCY_KEY_RE.test(FICTION_PHONE_COMPACT), 'a phone number cannot be a key');
      assert.ok(!IDEMPOTENCY_KEY_RE.test(FICTION_EMAIL), 'an e-mail address cannot be a key');
      assert.equal(linesOf(file).length, before, 'a refused key writes nothing');
    }

    // ─── 5. Kind and payload validation is an allow-list ────────────────────
    {
      for (const kind of OUTBOX_KINDS) {
        const written = outbox.append({ idempotencyKey: `kind:${kind}`, callSid: 'CA1', kind });
        assert.equal(written.record.kind, kind);
      }
      assert.throws(
        () =>
          outbox.append({
            idempotencyKey: 'kind:unknown',
            callSid: 'CA1',
            kind: 'wire_transfer' as never,
          }),
        /voice_outbox_invalid_kind/,
        'an unknown kind is refused rather than stored',
      );
      assert.throws(
        () =>
          outbox.append({
            idempotencyKey: 'payload:array',
            callSid: 'CA1',
            kind: 'message',
            payload: [] as unknown as Record<string, unknown>,
          }),
        /voice_outbox_invalid_payload/,
        'an array payload is refused',
      );
      assert.throws(
        () =>
          outbox.append({
            idempotencyKey: 'payload:huge',
            callSid: 'CA1',
            kind: 'message',
            payload: { blob: 'x'.repeat(MAX_PAYLOAD_CHARS + 1) },
          }),
        /voice_outbox_payload_too_large/,
        'an oversized payload is refused',
      );
      assert.throws(
        () => outbox.append({ idempotencyKey: 'call:bad', callSid: 'not a sid!', kind: 'note' }),
        /voice_outbox_invalid_call_sid/,
      );
    }

    // ─── 6. Status transitions: validated, atomic, never an upsert ──────────
    {
      const before = linesOf(file).length;
      const claimed = outbox.markStatus(TRANSFER_KEY, 'in_flight', { attempts: 1 });
      assert.equal(claimed.updated, true);
      assert.equal(claimed.record?.status, 'in_flight');
      assert.equal(claimed.record?.attempts, 1);
      assert.equal(claimed.record?.lastAttemptAt, STAMP_1, 'a transition stamps the attempt time');
      assert.equal(linesOf(file).length, before, 'a transition does not append a second row');

      clock.at = new Date(STAMP_2);
      const done = outbox.markStatus(TRANSFER_KEY, 'done');
      assert.equal(done.record?.status, 'done');
      assert.equal(done.record?.lastAttemptAt, STAMP_2);

      assert.throws(
        () => outbox.markStatus(TRANSFER_KEY, 'retrying' as never),
        /voice_outbox_invalid_status/,
      );
      assert.throws(
        () => outbox.markStatus(TRANSFER_KEY, 'done', { payload: {} } as never),
        /voice_outbox_unknown_patch_field/,
        'an unknown patch field is refused',
      );

      const beforeMissing = linesOf(file).length;
      const missing = outbox.markStatus('call:CA-absent:transfer', 'done');
      assert.deepEqual(
        missing,
        { updated: false, record: null, reason: 'not_found' },
        'markStatus never creates a record',
      );
      assert.equal(linesOf(file).length, beforeMissing, 'a not_found mark does not write');

      assert.deepEqual(
        [...new Set(fs.readdirSync(dir))].filter((entry) => entry.includes('.tmp')),
        [],
        'the atomic rewrite leaves no .tmp file behind',
      );
    }

    // ─── 7. claimNext walks the pending set once, and stays claimed ─────────
    {
      outbox.append({ idempotencyKey: 'call:CA2:message', callSid: 'CA2', kind: 'message' });
      outbox.append({ idempotencyKey: 'call:CA3:note', callSid: 'CA3', kind: 'note' });

      const pendingBefore = outbox
        .list()
        .filter((record) => record.status === 'pending')
        .map((record) => record.idempotencyKey);
      assert.ok(pendingBefore.length >= 2, 'there is something to claim');

      const before = linesOf(file).length;
      const claimed: string[] = [];
      for (let guard = 0; guard < 64; guard += 1) {
        const next = outbox.claimNext();
        if (!next) break;
        claimed.push(next.idempotencyKey);
        assert.equal(next.status, 'in_flight');
        assert.equal(next.attempts, 1, 'the first claim bumps attempts to 1');
        if (guard === 63) throw new Error('claimNext did not terminate');
      }
      assert.deepEqual(claimed, pendingBefore, 'every pending record is claimed exactly once');
      assert.equal(linesOf(file).length, before, 'claiming adds no rows');
      assert.equal(outbox.claimNext(), null, 'nothing claimable ⇒ null');

      const reopened = new Outbox({ path: file, now: () => clock.at });
      assert.equal(
        reopened.claimNext(),
        null,
        'claims are durable — a restart cannot re-claim what is already in flight',
      );
      assert.equal(reopened.snapshot().counts.pending, 0);
    }

    // ─── 8. Corrupt lines are skipped and counted, never fatal ──────────────
    {
      const healthy = outbox.list().length;
      fs.appendFileSync(file, '{"id":"ob_broken","idempotencyKey":"broken:1"}\n', 'utf-8');
      fs.appendFileSync(file, 'not json at all\n', 'utf-8');
      fs.appendFileSync(file, '\n', 'utf-8');

      const reopened = new Outbox({ path: file, now: () => clock.at });
      assert.equal(reopened.list().length, healthy, 'a corrupt trailing line is not fatal');
      assert.equal(
        reopened.snapshot().corruptLinesSkipped,
        2,
        'skipped lines are counted rather than hidden',
      );
    }

    // ─── 9. The snapshot is redacted; the durable record is not ────────────
    {
      outbox.append({
        idempotencyKey: 'call:CA9:transfer',
        callSid: 'CA9',
        kind: 'transfer',
        target: 'carter',
        payload: {
          callerName: 'Test Caller',
          callerPhone: FICTION_PHONE,
          phone: FICTION_PHONE_COMPACT,
          email: FICTION_EMAIL,
          notes: `ring ${FICTION_PHONE} before dispatch`,
          // Free-form text carrying a STANDALONE 10-digit run with no
          // separators anywhere in it. The grouped pattern cannot see this, so
          // it is the embedded case a durable operator surface must not leak.
          followUp: `called back about ${FICTION_DIGITS_BARE} but no answer`,
          nested: { callbackPhone: '555-123-4567', estimateId: 1234567890 },
        },
      });
      clock.at = new Date(STAMP_3);
      outbox.markStatus('call:CA9:transfer', 'failed', {
        error: `dial failed at ${STAMP_3} for ${FICTION_PHONE}`,
      });

      const view = outbox.snapshot();
      assert.equal(view.redacted, true);
      const serialized = JSON.stringify(view);
      for (const secret of ['5551234567', '555-123-4567', FICTION_EMAIL, '1234567890']) {
        assert.ok(
          !serialized.includes(secret),
          `the redacted snapshot must not contain ${secret}`,
        );
      }
      assert.ok(serialized.includes('+155****4567'), 'the phone is masked, not dropped');
      assert.ok(serialized.includes('c***@example.com'), 'the e-mail is masked');
      // The embedded case: a bare 10-digit run inside free-form text must be
      // masked in the DURABLE snapshot view, not only whole-string numbers.
      assert.ok(
        !serialized.includes(FICTION_DIGITS_BARE),
        'a standalone 10-digit run embedded in a phrase is masked in the snapshot',
      );
      assert.ok(
        serialized.includes(FICTION_DIGITS_BARE_MASKED),
        'and the snapshot carries the masked form of that run',
      );
      assert.ok(
        serialized.includes(STAMP_3),
        'timestamps survive redaction intact (they are not phone numbers)',
      );

      const target = view.records.find((record) => record.idempotencyKey === 'call:CA9:transfer');
      assert.ok(target, 'the redacted record is present');
      assert.equal(target.redacted, true);
      assert.equal(target.payload.callerPhone, '+155****4567');
      assert.equal(target.payload.phone, '+155****4567');
      assert.equal(target.payload.email, 'c***@example.com');
      assert.equal(target.payload.notes, 'ring +155****4567 before dispatch');
      assert.equal(
        target.payload.followUp,
        `called back about ${FICTION_DIGITS_BARE_MASKED} but no answer`,
        'the phrase keeps its words and loses only the embedded digits',
      );
      const nested = target.payload.nested as Record<string, unknown>;
      assert.equal(nested.callbackPhone, '555****4567');
      assert.equal(nested.estimateId, '123****7890', 'a phone-shaped number is masked too');
      assert.ok(
        typeof target.error === 'string' && target.error.includes('+155****4567'),
        'an embedded phone in an error string is masked',
      );
      assert.ok(
        typeof target.error === 'string' && target.error.includes(STAMP_3),
        'the timestamp inside the error string is untouched',
      );

      // Redaction is an exposure boundary, not data loss: the record on disk
      // keeps the real value, because that is what a replay needs.
      assert.ok(
        fs.readFileSync(file, 'utf-8').includes(FICTION_PHONE),
        'the durable record still holds the real value',
      );
    }

    // ─── 10. Counts add up ─────────────────────────────────────────────────
    {
      const records = outbox.list();
      const counts = countByStatus(records);
      assert.deepEqual(Object.keys(counts).sort(), [...OUTBOX_STATUSES].sort());
      const total = OUTBOX_STATUSES.reduce((sum, status) => sum + counts[status], 0);
      assert.equal(total, records.length, 'per-status counts sum to the record count');
    }

    // ─── 11. The source keeps the guarantees this check just proved ────────
    {
      const src = fs.readFileSync(path.resolve(__dirname, 'outbox.ts'), 'utf-8');
      assert.ok(src.includes('fs.appendFileSync'), 'new records use a single append');
      assert.ok(src.includes('fs.renameSync(tmp, this.path)'), 'transitions use .tmp + rename');
      assert.ok(
        !/setInterval|setTimeout|process\.exit|\.listen\s*\(|child_process/.test(src),
        'the outbox owns no process, no timer and no socket',
      );
      assert.ok(
        !/twilio|livekit|openai|sqlite|voice-server|conversationrelay|axios|@mastra|\bhcp\b/i.test(src),
        'the outbox references no provider, no third-party client and no production relay',
      );
      for (const specifier of [...src.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)].map(
        (match) => match[1],
      )) {
        assert.ok(specifier.startsWith('node:'), `outbox.ts imports only node builtins (${specifier})`);
      }

      // The default outbox path belongs to the repo, and this check never
      // creates it.
      assert.equal(
        fs.existsSync(path.resolve(repoRoot, DEFAULT_OUTBOX_PATH)),
        false,
        'the checks never touch the repo default outbox path',
      );
    }

    console.log(`outbox.check OK (${context}, ${outbox.list().length} records exercised)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
