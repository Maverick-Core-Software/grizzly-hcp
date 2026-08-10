#!/usr/bin/env tsx
/**
 * WF1 — Stale estimate nurture: draft follow-ups → approval queue file.
 * Usage: npx tsx src/automations/workflows/stale-estimate-nurture.ts [--max 3] [--queue path]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fetchAllJobs, dollars, isOpenEstimateStatus } from './shared.js';

const DEFAULT_QUEUE =
  process.env.MAVERICK_APPROVAL_QUEUE ||
  'C:/Workspace/Shared/Maverick Integrations/workflows/approval-queue.json';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] || fallback : fallback;
}

function daysSince(iso: string | null): number {
  if (!iso) return 999;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 999;
  return Math.floor((Date.now() - t) / 86400000);
}

function draftSms(job: {
  customer_name: string;
  invoice_number: string;
  total_amount: number;
  description: string | null;
}): string {
  const amt = dollars(job.total_amount);
  const desc = (job.description || 'your electrical project').slice(0, 80);
  return (
    `Hi ${job.customer_name.split(' ')[0] || 'there'}, it's Grizzly Electrical — ` +
    `following up on estimate #${job.invoice_number} (${amt}) for ${desc}. ` +
    `Still happy to help or answer questions. Reply here or call (469) 863-9804. Thanks!`
  );
}

async function main() {
  const max = parseInt(arg('--max', '3'), 10);
  const queuePath = arg('--queue', DEFAULT_QUEUE);

  let jobs: Awaited<ReturnType<typeof fetchAllJobs>> = [];
  let hcp_error: string | null = null;
  try {
    jobs = await fetchAllJobs(12);
  } catch (e) {
    hcp_error = e instanceof Error ? e.message : String(e);
  }

  const candidates = jobs
    .filter((j) => isOpenEstimateStatus(j.work_status))
    .map((j) => ({
      ...j,
      stale_days: daysSince(j.schedule_start || j.updated_at),
    }))
    .filter((j) => j.stale_days >= 14)
    .sort((a, b) => b.total_amount - a.total_amount)
    .slice(0, max);

  const items = candidates.map((j) => ({
    id: `stale-est-${j.id}`,
    workflow: 'WF1-stale-estimate-nurture',
    created_at: new Date().toISOString(),
    status: 'pending_approval',
    hcp_job_id: j.id,
    invoice_number: j.invoice_number,
    customer_name: j.customer_name,
    customer_phone: j.customer_phone,
    customer_email: j.customer_email,
    amount: dollars(j.total_amount),
    stale_days: j.stale_days,
    channel: j.customer_phone ? 'sms' : 'email',
    draft_sms: draftSms(j),
    draft_email_subject: `Following up — Grizzly estimate #${j.invoice_number}`,
    draft_email_body:
      `Hi ${j.customer_name},\n\n` +
      `Wanted to check in on the estimate we sent for ${j.description || 'your project'} (${dollars(j.total_amount)}).\n\n` +
      `If you have questions or want to move forward, reply to this email or call us at (469) 863-9804.\n\n` +
      `— Grizzly Electrical Solutions`,
    approve_hint: 'Hermes: approve then mcp housecall_pro text_estimate or email_estimate',
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

  const existingIds = new Set((queue.items as Array<{ id?: string }>).map((x) => x.id));
  for (const item of items) {
    if (!existingIds.has(item.id)) queue.items.push(item);
  }

  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

  process.stdout.write(
    JSON.stringify(
      {
        workflow: 'WF1-stale-estimate-nurture',
        hcp_error,
        queued: items.length,
        queue_path: queuePath,
        items,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});