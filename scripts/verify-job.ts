import { hcpGet, hcpPatch } from '../src/hcp/client.js';

const [,, jobUuid] = process.argv;
if (!jobUuid) {
  console.error('Usage: npx tsx scripts/verify-job.ts <job_uuid>');
  process.exit(1);
}

// The estimate was created with estimate_id: 494624336 and uuid: est_...
// Let's try the API with the numeric ID, and also try different alpha endpoints
const numericId = '494624336';

const endpoints = [
  `/alpha/jobs/${numericId}`,
  `/api/v2/pro/requests/${numericId}`,
  `/api/v2/pro/jobs/${numericId}`,
  `/alpha/jobs/${jobUuid}?expand[]=basic_info&expand[]=customer&expand[]=service_address`,
];

for (const ep of endpoints) {
  try {
    const job = await hcpGet<any>(ep);
    console.log(`✅ Success on ${ep}`);
    console.log('\n=== JOB DATA ===');
    const data = JSON.stringify(job, null, 2);
    console.log(data.substring(0, 4000));
    break;
  } catch (e: any) {
    console.log(`❌ ${ep}: ${e.message?.substring(0, 120)}`);
  }
}
