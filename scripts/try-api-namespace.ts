/**
 * The assign_technician MCP tool uses a two-step pattern:
 * 1. GET /api/estimates/{est_uuid} → gets an /api/ namespace UUID
 * 2. PUT /api/estimates/{api_uuid}/assignees
 * Maybe the address change follows the same pattern.
 */
import { hcpGet, hcpPatch, hcpPut } from '../src/hcp/client.js';

const EST_UUID = "est_24765cfd939c40d78e466330c123ae99";
const NEW_ADDR_UUID = "adr_88e41bd33e924b94bf930be428c89444";

// Step 1: Get the /api/ namespace UUID
console.log('=== GET /api/estimates/' + EST_UUID + ' ===');
let apiUuid: string | null = null;
try {
  const est = await hcpGet(`/api/estimates/${EST_UUID}`);
  console.log('Full response:', JSON.stringify(est).slice(0, 1000));
  apiUuid = (est as any).uuid || (est as any).id || null;
  console.log('api UUID:', apiUuid);
} catch (e) {
  console.log('FAILED:', e.message.slice(0, 300));
}

// Try PUT /api/estimates/{api_uuid} with service_address
if (apiUuid) {
  console.log('\n=== PUT /api/estimates/' + apiUuid + ' (service_address_uuid) ===');
  try {
    const r1 = await hcpPut(`/api/estimates/${apiUuid}`, {
      service_address_uuid: NEW_ADDR_UUID,
    });
    console.log('SUCCESS:', JSON.stringify(r1).slice(0, 500));
  } catch (e) {
    console.log('FAILED:', e.message.slice(0, 300));
  }

  // Try PATCH with address_uuid  
  console.log('\n=== PATCH /api/estimates/' + apiUuid + ' (address_uuid) ===');
  try {
    const r2 = await hcpPatch(`/api/estimates/${apiUuid}`, {
      address_uuid: NEW_ADDR_UUID,
    });
    console.log('SUCCESS:', JSON.stringify(r2).slice(0, 500));
  } catch (e) {
    console.log('FAILED:', e.message.slice(0, 300));
  }

  // Try PUT /api/estimates/{api_uuid}/service_address
  console.log('\n=== PUT /api/estimates/' + apiUuid + '/service_address ===');
  try {
    const r3 = await hcpPut(`/api/estimates/${apiUuid}/service_address`, {
      service_address_uuid: NEW_ADDR_UUID,
    });
    console.log('SUCCESS:', JSON.stringify(r3).slice(0, 500));
  } catch (e) {
    console.log('FAILED:', e.message.slice(0, 300));
  }

  // Try PATCH /api/jobs/{api_uuid}
  console.log('\n=== PATCH /api/jobs/' + apiUuid + ' ===');
  try {
    const r4 = await hcpPatch(`/api/jobs/${apiUuid}`, {
      service_address_uuid: NEW_ADDR_UUID,
    });
    console.log('SUCCESS:', JSON.stringify(r4).slice(0, 500));
  } catch (e) {
    console.log('FAILED:', e.message.slice(0, 300));
  }
} else {
  // If the /api/ endpoint failed, try with the est_uuid directly
  console.log('\n=== PUT /api/estimates/' + EST_UUID + ' ===');
  try {
    const r = await hcpPut(`/api/estimates/${EST_UUID}`, {
      service_address_uuid: NEW_ADDR_UUID,
    });
    console.log('SUCCESS:', JSON.stringify(r).slice(0, 500));
  } catch (e) {
    console.log('FAILED:', e.message.slice(0, 300));
  }
}
