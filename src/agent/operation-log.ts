import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { randomUUID } from 'crypto';

// ponytail: JSONL for prototype. Upgrade to SQLite (better-sqlite3) when concurrent
// writes or retry lookups get painful — schema stays the same, just swap read/write fns.
const LOG_PATH = path.join(process.cwd(), 'data', 'operations.jsonl');

export type OperationStatus =
  | 'in_progress'
  | 'completed'
  | 'failed_compensated'
  | 'failed_needs_review';

export interface OperationProgress {
  customerId?: string;
  estimateUuid?: string;
  lineItemsAdded?: number;
  techsAssigned?: string[];
  depositSet?: boolean;
  [key: string]: unknown;
}

export interface OperationRecord {
  operationId: string;
  type: string;
  requestedBy: string;
  approvedAt: string;
  idempotencyKey: string;
  inputs: Record<string, unknown>;
  progress: OperationProgress;
  status: OperationStatus;
  error?: string;
  manualRecovery?: string;
  createdAt: string;
  completedAt?: string;
}

export function makeIdempotencyKey(
  type: string,
  approvedPayload: unknown,
  requestedBy: string
): string {
  const normalized = JSON.stringify(sortDeep(approvedPayload));
  return crypto
    .createHash('sha256')
    .update(`${type}|${normalized}|${requestedBy}`)
    .digest('hex')
    .slice(0, 16);
}

function sortDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortDeep);
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj as object).sort()) {
      out[k] = sortDeep((obj as Record<string, unknown>)[k]);
    }
    return out;
  }
  return obj;
}

function readAll(): OperationRecord[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs
    .readFileSync(LOG_PATH, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as OperationRecord);
}

function writeAll(records: OperationRecord[]): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOG_PATH, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

export function createOperation(
  fields: Omit<OperationRecord, 'createdAt' | 'completedAt'> & { operationId?: string }
): OperationRecord {
  const { operationId: externalId, ...rest } = fields;
  const record: OperationRecord = {
    operationId: externalId ?? randomUUID(),
    createdAt: new Date().toISOString(),
    ...rest,
  };
  const all = readAll();
  all.push(record);
  writeAll(all);
  return record;
}

export function updateOperation(
  operationId: string,
  update: Partial<Omit<OperationRecord, 'operationId' | 'createdAt'>>
): OperationRecord | null {
  const all = readAll();
  const idx = all.findIndex(r => r.operationId === operationId);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...update };
  const terminal = update.status === 'completed' || update.status?.startsWith('failed');
  if (terminal) all[idx].completedAt = new Date().toISOString();
  writeAll(all);
  return all[idx];
}

export function findByIdempotencyKey(key: string): OperationRecord | undefined {
  return readAll().find(r => r.idempotencyKey === key);
}

export function findByOperationId(operationId: string): OperationRecord | undefined {
  return readAll().find(r => r.operationId === operationId);
}
