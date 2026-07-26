import { createEstimate } from '../src/hcp/estimates.js';
import { hcpPatch } from '../src/hcp/client.js';

const [,, customerUuid, addressUuid] = process.argv;

if (!customerUuid || !addressUuid) {
  console.error('Usage: npx tsx scripts/create-estimate.ts <customer_uuid> <address_uuid>');
  process.exit(1);
}

console.log(`Creating estimate for ${customerUuid} at ${addressUuid}...`);

const est = await createEstimate(customerUuid, addressUuid);

console.log('Created estimate:');
console.log(JSON.stringify(est, null, 2));
console.log(`\nESTIMATE_UUID=${est.uuid}`);
console.log(`ESTIMATE_ID=${est.estimateId}`);

// Now set the job type / name to "Remodel"
try {
  await hcpPatch(`/alpha/jobs/${est.uuid}`, {
    name: 'Remodel',
  });
  console.log('Set job name to "Remodel"');
} catch (err: any) {
  console.error('Failed to set job name:', err.message);
}
