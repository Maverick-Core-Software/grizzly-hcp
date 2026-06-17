import 'dotenv/config';
import { getContext, closeBrowser } from '../../browser.js';

export interface Job {
  id: string;
  customer: string;
  address: string;
  status: string;
  scheduled: string;
  total: string;
}

export async function listJobs(status: 'scheduled' | 'in_progress' | 'completed' = 'scheduled'): Promise<Job[]> {
  const ctx = await getContext();
  const page = await ctx.newPage();

  await page.goto(`https://pro.housecallpro.com/pro/jobs?status=${status}`, { waitUntil: 'networkidle' });

  // Wait for job rows to load
  await page.waitForSelector('[data-testid="job-row"], .job-row, tr[data-id]', { timeout: 10_000 }).catch(() => null);

  const jobs: Job[] = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="job-row"], .job-row, tr[data-id]'));
    return rows.map(row => ({
      id: row.getAttribute('data-id') ?? '',
      customer: row.querySelector('[data-testid="customer-name"], .customer-name')?.textContent?.trim() ?? '',
      address: row.querySelector('[data-testid="address"], .address')?.textContent?.trim() ?? '',
      status: row.querySelector('[data-testid="status"], .status-badge')?.textContent?.trim() ?? '',
      scheduled: row.querySelector('[data-testid="scheduled"], .scheduled-time')?.textContent?.trim() ?? '',
      total: row.querySelector('[data-testid="total"], .job-total')?.textContent?.trim() ?? '',
    }));
  });

  await page.close();
  return jobs;
}

// Run directly: tsx src/automations/jobs/list-jobs.ts
const isMain = process.argv[1]?.endsWith('list-jobs.ts');
if (isMain) {
  listJobs().then(jobs => {
    console.log(JSON.stringify(jobs, null, 2));
    console.log(`\nTotal: ${jobs.length} jobs`);
  }).finally(closeBrowser);
}
