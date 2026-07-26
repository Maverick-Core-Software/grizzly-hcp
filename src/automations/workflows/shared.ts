/**
 * Shared HCP job fetch for Maverick workflow POCs.
 */
import { hcpGet } from '../../hcp/client.js';

export interface HcpJobRow {
  id: string;
  invoice_number: string;
  description: string | null;
  total_amount: number;
  work_status: string;
  printable_address: string;
  schedule_start: string | null;
  completed_at: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  updated_at: string | null;
}

interface HcpJob {
  id: string;
  invoice_number: string;
  description: string | null;
  total_amount: number;
  work_status: string;
  printable_address: string;
  schedule: { data: { start_time: string | null } };
  work_status_timestamps: { finish: string | null };
  updated_at?: string;
  customer: { data: { display_name: string; email: string | null; mobile_number: string | null } };
}

interface JobsResponse {
  data: { data: HcpJob[] };
  total_page_count: number;
}

export async function fetchAllJobs(maxPages = 15): Promise<HcpJobRow[]> {
  const out: HcpJobRow[] = [];
  let page = 1;

  while (page <= maxPages) {
    const params = new URLSearchParams({ page: String(page), page_size: '100' });
    params.append('expand[]', 'customer');

    const res = await hcpGet<JobsResponse>(`/alpha/jobs?${params}`);
    const batch = res.data?.data ?? [];

    for (const j of batch) {
      const c = j.customer?.data;
      out.push({
        id: j.id,
        invoice_number: j.invoice_number,
        description: j.description,
        total_amount: j.total_amount,
        work_status: j.work_status,
        printable_address: j.printable_address,
        schedule_start: j.schedule?.data?.start_time ?? null,
        completed_at: j.work_status_timestamps?.finish ?? null,
        customer_name: c?.display_name ?? 'Unknown',
        customer_email: c?.email ?? null,
        customer_phone: c?.mobile_number ?? null,
        updated_at: j.updated_at ?? null,
      });
    }

    if (page >= res.total_page_count) break;
    page++;
  }

  return out;
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Open estimate / pipeline statuses (Grizzly HCP vocabulary). */
export function isOpenEstimateStatus(status: string): boolean {
  const s = status.toLowerCase();
  return (
    s.includes('estimate') ||
    s === 'needs scheduling' ||
    s === 'awaiting approval' ||
    s === 'sent'
  );
}

export function isCompletedStatus(status: string): boolean {
  return status.toLowerCase().includes('complete');
}