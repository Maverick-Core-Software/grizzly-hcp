/**
 * Change the service address on an existing estimate/job.
 * Tries multiple known HCP internal API endpoints.
 */
import { hcpPatch, hcpPut, hcpPost, hcpPostForm } from '../src/hcp/client.js';

const EST_ID = process.argv[2];
const NEW_ADDR_UUID = process.argv[3];

if (!EST_ID || !NEW_ADDR_UUID) {
  console.error('Usage: npx tsx scripts/change-address.ts <est_uuid> <new_addr_uuid>');
  process.exit(1);
}

console.log(`Changing ${EST_ID} service address to ${NEW_ADDR_UUID}...`);

const attempts = [
  // 1: PATCH /alpha/jobs/{est} with service_address_id (numeric)
  () => hcpPatch(`/alpha/jobs/${EST_ID}`, { service_address_id: 247943456 }),
  // 2: PUT /alpha/jobs/{est} with service_address_uuid
  () => hcpPut(`/alpha/jobs/${EST_ID}`, { service_address_uuid: NEW_ADDR_UUID }),
  // 3: PATCH /pro/requests/react/{est}/update_service_address  
  () => hcpPatch(`/pro/requests/react/${EST_ID}/update_service_address`, { service_address_uuid: NEW_ADDR_UUID }),
  // 4: POST /alpha/jobs/{est}/change_address
  () => hcpPost(`/alpha/jobs/${EST_ID}/change_address`, { service_address_uuid: NEW_ADDR_UUID }),
  // 5: PATCH /alpha/estimates/{est} with address
  () => hcpPatch(`/alpha/estimates/${EST_ID}`, { service_address_uuid: NEW_ADDR_UUID }),
  // 6: POST form-encoded /pro/requests/react/{est}/update_service_address
  () => hcpPostForm(`/pro/requests/react/${EST_ID}/update_service_address`, { service_address_uuid: NEW_ADDR_UUID }),
];

for (let i = 0; i < attempts.length; i++) {
  try {
    const result = await attempts[i]();
    const addr = result?.printable_address || result?.address_id || 'unknown';
    console.log(`[${i+1}] SUCCESS: addr=${addr}`, JSON.stringify(result).slice(0, 200));
    if (result?.printable_address?.includes('Sycamore') || result?.address_id === NEW_ADDR_UUID) {
      console.log('ADDRESS CHANGED CONFIRMED');
      break;
    }
  } catch (e: any) {
    console.log(`[${i+1}] FAIL: ${e.message.slice(0, 150)}`);
  }
}
