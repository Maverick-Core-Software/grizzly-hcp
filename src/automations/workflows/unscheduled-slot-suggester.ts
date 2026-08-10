#!/usr/bin/env tsx
/**
 * WF6 (W3 #2) — Unscheduled job → slot suggester → approval queue.
 * Suggest-only POC: does NOT call update_job_schedule until a future approve-execute step.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fetchAllJobs, dollars } from './shared.js';
import { needsScheduling, proposeSlots, draftScheduleSms } from './slot-heuristics.js';

const DEFAULT_QUEUE =
  process.env.MAVERICK_APPROVAL_QUEUE ||
  'C:/Workspace/Shared/Maverick Integrations/workflows/approval-queue.json';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] || fallback : fallback;
}

function daysWaiting(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

async function main() {
  const max = parseInt(arg('--max', '3'), 10);
  const queuePath = arg('--queue', DEFAULT_QUEUE);

  const jobs = await fetchAllJobs(15);
  const scheduledStarts = jobs.map((j) => j.schedule_start).filter(Boolean) as string[];
  const slots = proposeSlots(scheduledStarts, 3);

  const unscheduled = jobs
    .filter((j) => needsScheduling(j))
    .map((j) => ({
      ...j,
      wait_days: daysWaiting(j.updated_at),
      score: j.total_amount + daysWaiting(j.updated_at) * 5000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);

  const items = unscheduled.map((j) => {
    const label = j.description || `Job #${j.invoice_number}`;
    const body = draftScheduleSms(j.customer_name, label, slots);
    return {
      id: `wf6-schedule-${j.id}`,
      workflow: 'WF6-unscheduled-slot-suggester',
      created_at: new Date().toISOString(),
      status: 'pending_approval',
      hcp_job_id: j.id,
      invoice_number: j.invoice_number,
      customer_name: j.customer_name,
      customer_phone: j.customer_phone,
      total_display: dollars(j.total_amount),
      wait_days: j.wait_days,
      proposed_slots: slots,
      channel: 'sms',
      draft_body: body,
      demo_note: 'Approve = copy/send manually or wire text_job in phase 2',
    };
  });

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const existing = new Set((queue.items || []).map((x: { id?: string }) => x.id));
  for (const item of items) {
    if (!existing.has(item.id)) queue.items.push(item);
  }
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

  const digest_markdown =
    `*Dispatch suggester* — ${unscheduled.length} unscheduled (top by $ + wait)\n` +
    unscheduled
      .map(
        (j, i) =>
          `${i + 1}. #${j.invoice_number} ${j.customer_name} — ${dollars(j.total_amount)} (${j.wait_days}d waiting)`,
      )
      .join('\n') +
    (slots.length ? `\nSuggested windows: ${slots.map((s) => s.label).join(' · ')}` : '');

  process.stdout.write(
    JSON.stringify(
      {
        workflow: 'WF6-unscheduled-slot-suggester',
        unscheduled_report_total: jobs.filter((j) => needsScheduling(j)).length,
        queued: items.length,
        proposed_slots: slots,
        queue_path: queuePath,
        digest_markdown,
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