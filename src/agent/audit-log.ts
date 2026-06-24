import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const LOG_PATH = path.join(process.cwd(), 'data', 'audit.jsonl');

export interface AuditEntry {
  turnId: string;
  userRequest: string;    // short summary, no PII
  maverickResponse?: string; // full response text (logged while AUDIT_LOG_RESPONSES=true)
  intent: string;
  modelUsed: string;
  toolsInvoked: string[];
  workflowsTriggered: string[];
  hcpIdsChanged: string[];         // IDs only, not content
  approvedBy: string;
  result: string;
  sensitiveRefs: string[];         // e.g. 'customer:cust_abc', 'job:job_xyz'
  retentionDays: number;
  ts: string;
}

export function makeAuditEntry(fields: Partial<AuditEntry> & { userRequest: string }): AuditEntry {
  return {
    turnId: randomUUID(),
    intent: '',
    modelUsed: '',
    toolsInvoked: [],
    workflowsTriggered: [],
    hcpIdsChanged: [],
    approvedBy: 'carter',
    result: '',
    sensitiveRefs: [],
    retentionDays: Number(process.env.AUDIT_RETENTION_DAYS || '180'),
    ts: new Date().toISOString(),
    ...fields,
  };
}

export function writeAuditEntry(entry: AuditEntry): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

export function logAudit(fields: Partial<AuditEntry> & { userRequest: string }): string {
  const entry = makeAuditEntry(fields);
  writeAuditEntry(entry);
  return entry.turnId;
}
