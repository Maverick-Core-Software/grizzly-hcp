/**
 * Durable, PII-free idempotency state for signed Twilio SMS deliveries.
 *
 * This is deliberately separate from the JSONL operational log: a SQLite
 * unique key can safely arbitrate concurrent webhook retries and survives a
 * server restart.  It stores Twilio event IDs, derived operation IDs, state,
 * review reason, and timestamps only.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SmsInboundEventClaimStore, SmsInboundEventStatus, SmsIntakeReviewReason } from './sms-intake.js';

type StoredEvent = {
  status: SmsInboundEventStatus;
  operation_id: string;
};

const MAX_BUSY_ATTEMPTS = 3;

function isBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

export class SqliteSmsInboundEventStore implements SmsInboundEventClaimStore {
  private readonly db: DatabaseSync;

  constructor(path = 'data/sms-inbound-events.sqlite') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS sms_inbound_events (
        message_sid TEXT PRIMARY KEY NOT NULL,
        operation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'review', 'failed')),
        review_reason TEXT,
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async claim(input: { messageSid: string; operationId: string; receivedAt: Date }): Promise<
    | { claimed: true }
    | { claimed: false; status: SmsInboundEventStatus; operationId: string }
  > {
    for (let attempt = 0; attempt < MAX_BUSY_ATTEMPTS; attempt += 1) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const existing = this.db.prepare(
            'SELECT status, operation_id FROM sms_inbound_events WHERE message_sid = ?',
          ).get(input.messageSid) as StoredEvent | undefined;
          if (existing) {
            this.db.exec('COMMIT');
            return {
              claimed: false,
              status: existing.status,
              operationId: existing.operation_id,
            };
          }

          const timestamp = input.receivedAt.toISOString();
          this.db.prepare(`
            INSERT INTO sms_inbound_events (
              message_sid, operation_id, status, received_at, updated_at
            ) VALUES (?, ?, 'claimed', ?, ?)
          `).run(input.messageSid, input.operationId, timestamp, timestamp);
          this.db.exec('COMMIT');
          return { claimed: true };
        } catch (error) {
          try { this.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
          throw error;
        }
      } catch (error) {
        if (!isBusy(error) || attempt === MAX_BUSY_ATTEMPTS - 1) throw error;
        await wait(10 * (attempt + 1));
      }
    }
    throw new Error('Inbound event claim exhausted without a result');
  }

  async mark(input: {
    messageSid: string;
    status: Exclude<SmsInboundEventStatus, 'claimed'>;
    reviewReason?: SmsIntakeReviewReason;
  }): Promise<void> {
    this.db.prepare(`
      UPDATE sms_inbound_events
      SET status = ?, review_reason = ?, updated_at = ?
      WHERE message_sid = ?
    `).run(input.status, input.reviewReason ?? null, new Date().toISOString(), input.messageSid);
  }

  close(): void {
    this.db.close();
  }
}
