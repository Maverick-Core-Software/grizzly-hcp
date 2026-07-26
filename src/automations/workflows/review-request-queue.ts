#!/usr/bin/env tsx
/**
 * WF5 — Post-job review request queue (completed jobs, not yet queued).
 * Usage: npx tsx src/automations/workflows/review-request-queue.ts [--days 7]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fetchAllJobs, dollars, isCompletedStatus } from './shared.js';

const DEFAULT_QUEUE =
  process.env.MAVERICK_APPROVAL_QUEUE ||
  'C:/Workspace/Shared/Maverick Integrations/workflows/approval-queue.json';
const STATE_PATH =
  process.env.REVIEW_REQUEST_STATE ||
  'C:/Workspace/Shared/Maverick Integrations/workflows/state/review-requested.json';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] || fallback : fallback;
}

function loadState(): { sent: Record<string, string> } {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sent: {} };
  }
}

function saveState(s: { sent: Record<string, string> }) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf8');
}

async function main() {
  const lookbackDays = parseInt(arg('--days', '7'), 10);
  const queuePath = arg('--queue', DEFAULT_QUEUE);
  const state = loadState();
  const cutoff = Date.now() - lookbackDays * 86400000;

  let jobs: Awaited<ReturnType<typeof fetchAllJobs>> = [];
  let hcp_error: string | null = null;
  try {
    jobs = await fetchAllJobs(10);
  } catch (e) {
    hcp_error = e instanceof Error ? e.message : String(e);
  }

  const fresh = jobs.filter((j) => {
    if (!isCompletedStatus(j.work_status) || !j.completed_at) return false;
    const t = new Date(j.completed_at).getTime();
    if (t < cutoff) return false;
    return !state.sent[j.id];
  });

  const items = fresh.slice(0, 5).map((j) => ({
    id: `review-req-${j.id}`,
    workflow: 'WF5-review-request',
    created_at: new Date().toISOString(),
    status: 'pending_approval',
    hcp_job_id: j.id,
    invoice_number: j.invoice_number,
    customer_name: j.customer_name,
    customer_phone: j.customer_phone,
    completed_at: j.completed_at,
    channel: 'sms',
    draft_sms:
      `Hi ${j.customer_name.split(' ')[0] || 'there'}, thanks for choosing Grizzly Electrical! ` +
      `If you have a minute, a Google review helps other DFW homeowners find us: ` +
      `https://g.page/r/grizzlyelectrical/review (search Grizzly Electrical Rowlett if link fails). ` +
      `We appreciate you! — Grizzly`,
    approve_hint: 'On approve: send SMS via HCP; mark job id in review-requested state',
  }));

  let queue: { version: number; items: unknown[] } = { version: 1, items: [] };
  if (fs.existsSync(queuePath)) {
    try {
      queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      if (!Array.isArray(queue.items)) queue.items = [];
    } catch {
      queue = { version: 1, items: [] };
    }
  }

  const existingIds = new Set(queue.items.map((x: { id?: string }) => x.id));
  for (const item of items) {
    if (!existingIds.has(item.id)) queue.items.push(item);
  }

  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
  saveState(state);

  process.stdout.write(
    JSON.stringify({ workflow: 'WF5-review-request', hcp_error, queued: items.length, queue_path: queuePath, items }, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});