import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { hcpGet } from '../../../hcp/client.js';

export const checkHcpMessagesTool = createTool({
  id: 'check_hcp_messages',
  description: 'Check unread messages in Housecall Pro inbox. Returns sender, subject, preview, and timestamp.',
  inputSchema: z.object({}),
  execute: async () => {
    try {
      // ponytail: endpoint from intercepted HCP traffic — re-verify with npm run intercept if this breaks
      const data = await hcpGet<{ messages?: Array<{ id: string; from: string; subject: string; preview: string; created_at: string }> }>(
        '/pro/messages?filter=unread&limit=20'
      );
      return { messages: data.messages ?? [] };
    } catch (e) {
      return { messages: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const checkScheduleTool = createTool({
  id: 'check_schedule',
  description: 'Get upcoming scheduled jobs from Housecall Pro. Returns job ID, customer name, address, scheduled time, and assigned techs.',
  inputSchema: z.object({
    days: z.number().optional().describe('How many days ahead to look (default 7)'),
  }),
  execute: async ({ days }) => {
    try {
      const data = await hcpGet<{ jobs?: unknown[] }>(`/pro/jobs/scheduled?days_ahead=${days ?? 7}&limit=50`);
      return { jobs: data.jobs ?? [] };
    } catch (e) {
      return { jobs: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const getJobTool = createTool({
  id: 'get_job',
  description: 'Get details for a specific HCP job by job ID or UUID.',
  inputSchema: z.object({
    jobId: z.string().describe('HCP job UUID (csr_...) or numeric ID'),
  }),
  execute: async ({ jobId }) => {
    try {
      const data = await hcpGet<{ job?: unknown }>(`/pro/jobs/${jobId}`);
      return { job: data.job ?? null };
    } catch (e) {
      return { job: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const listOpenJobsTool = createTool({
  id: 'list_open_jobs',
  description: 'List open/active jobs in Housecall Pro — unscheduled, in-progress, or needs followup. Good for daily briefings.',
  inputSchema: z.object({
    status: z.enum(['open', 'in_progress', 'unscheduled', 'needs_invoice']).optional().describe('Filter by status (default: all open)'),
    limit: z.number().optional().describe('Max results (default 20)'),
  }),
  execute: async ({ status, limit }) => {
    try {
      const qs = status ? `&status=${status}` : '';
      const data = await hcpGet<{ jobs?: unknown[] }>(`/pro/jobs?is_active=true${qs}&limit=${limit ?? 20}`);
      return { jobs: data.jobs ?? [] };
    } catch (e) {
      return { jobs: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const getCustomerEstimatesTool = createTool({
  id: 'get_customer_estimates',
  description: 'Get past estimates for a customer by HCP customer ID. Useful for knowing what was quoted before.',
  inputSchema: z.object({
    customerId: z.string().describe('HCP customer ID (cus_...) or UUID'),
    limit: z.number().optional().describe('Max results (default 10)'),
  }),
  execute: async ({ customerId, limit }) => {
    try {
      const data = await hcpGet<{ estimates?: unknown[] }>(`/pro/estimates?customer_id=${customerId}&limit=${limit ?? 10}`);
      return { estimates: data.estimates ?? [] };
    } catch (e) {
      return { estimates: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const hcpReadTools = {
  check_hcp_messages:       checkHcpMessagesTool,
  check_schedule:           checkScheduleTool,
  get_job:                  getJobTool,
  list_open_jobs:           listOpenJobsTool,
  get_customer_estimates:   getCustomerEstimatesTool,
};
