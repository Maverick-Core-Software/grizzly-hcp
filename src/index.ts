import 'dotenv/config';
import { closeBrowser } from './browser.js';
import { listJobs } from './automations/jobs/list-jobs.js';

async function main() {
  console.log('=== Grizzly HCP Automation ===\n');

  const jobs = await listJobs('scheduled');
  console.log(`Scheduled jobs: ${jobs.length}`);
  for (const job of jobs) {
    console.log(`  [${job.id}] ${job.customer} — ${job.address} (${job.scheduled})`);
  }
}

main().finally(closeBrowser);
