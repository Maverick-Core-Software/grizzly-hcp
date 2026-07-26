#!/usr/bin/env tsx
/**
 * WF2 — Morning owner brief (JSON to stdout).
 * Usage: npx tsx src/automations/workflows/morning-brief.ts
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fetchAllJobs, dollars, isOpenEstimateStatus } from './shared.js';

const SEO_ROOT = process.env.SEO_AGENTS_DIR || 'C:/Workspace/Active/SEO-Agents-App';

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function startOfDayCT(): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return new Date(`${y}-${m}-${d}T00:00:00-05:00`);
}

async function main() {
  let jobs: Awaited<ReturnType<typeof fetchAllJobs>> = [];
  let hcp_error: string | null = null;
  try {
    jobs = await fetchAllJobs(8);
  } catch (e) {
    hcp_error = e instanceof Error ? e.message : String(e);
  }

  const day0 = startOfDayCT();
  const day3 = new Date(day0.getTime() + 3 * 86400000);

  const scheduled = jobs.filter((j) => {
    if (!j.schedule_start) return false;
    const t = new Date(j.schedule_start).getTime();
    return t >= day0.getTime() && t < day3.getTime();
  });

  const unscheduled = jobs.filter((j) => !j.schedule_start && !isCompletedStatus(j.work_status));
  const openEstimates = jobs.filter((j) => isOpenEstimateStatus(j.work_status));
  const openTotalCents = openEstimates.reduce((s, j) => s + j.total_amount, 0);

  const wfPath = path.join(SEO_ROOT, 'outputs', 'workflow_status.json');
  const aqPath = path.join(SEO_ROOT, 'outputs', 'action_queue.json');
  const wf = readJsonSafe(wfPath);
  const aq = readJsonSafe(aqPath);

  let pendingActions = 0;
  const actions = (aq as { actions?: Array<{ status?: string }> })?.actions;
  if (Array.isArray(actions)) {
    pendingActions = actions.filter((a) => a.status === 'pending' || a.status === 'awaiting_approval').length;
  }

  const brief = {
    generated_at: new Date().toISOString(),
    workflow: 'WF2-morning-brief',
    hcp_error,
    calendar_next_3d: scheduled.slice(0, 8).map((j) => ({
      invoice: j.invoice_number,
      customer: j.customer_name,
      when: j.schedule_start,
      description: j.description,
      amount: dollars(j.total_amount),
      status: j.work_status,
    })),
    unscheduled_count: unscheduled.length,
    unscheduled_sample: unscheduled.slice(0, 5).map((j) => ({
      invoice: j.invoice_number,
      customer: j.customer_name,
      amount: dollars(j.total_amount),
      status: j.work_status,
    })),
    open_estimates_count: openEstimates.length,
    open_estimates_total: dollars(openTotalCents),
    seo_phase: (wf as { phase?: string })?.phase ?? 'unknown',
    seo_status: (wf as { status?: string })?.status ?? 'unknown',
    marketing_pending_approvals: pendingActions,
    slack_markdown: hcp_error
      ? `*Grizzly morning brief* (HCP offline — run \`npm run login\` in grizzly-hcp)\n• Marketing approvals pending: *${pendingActions}*\n• SEO phase: ${String((wf as { phase?: string })?.phase ?? 'n/a')}`
      : formatSlack({
      scheduled,
      unscheduledCount: unscheduled.length,
      openCount: openEstimates.length,
      openTotal: dollars(openTotalCents),
      pendingActions,
      seoPhase: String((wf as { phase?: string })?.phase ?? 'n/a'),
    }),
  };

  process.stdout.write(JSON.stringify(brief, null, 2));
}

function isCompletedStatus(status: string): boolean {
  return status.toLowerCase().includes('complete');
}

function formatSlack(ctx: {
  scheduled: ReturnType<typeof fetchAllJobs> extends Promise<infer T> ? T : never;
  unscheduledCount: number;
  openCount: number;
  openTotal: string;
  pendingActions: number;
  seoPhase: string;
}): string {
  const lines = [
    '*Grizzly morning brief*',
    `• Jobs next 3 days: *${ctx.scheduled.length}*`,
    ...ctx.scheduled.slice(0, 4).map(
      (j) => `  – #${j.invoice_number} ${j.customer_name} (${j.schedule_start?.slice(0, 10) ?? 'TBD'})`,
    ),
    `• Unscheduled pipeline: *${ctx.unscheduledCount}*`,
    `• Open estimates: *${ctx.openCount}* (${ctx.openTotal})`,
    `• Marketing approvals pending: *${ctx.pendingActions}* (SEO phase: ${ctx.seoPhase})`,
  ];
  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});