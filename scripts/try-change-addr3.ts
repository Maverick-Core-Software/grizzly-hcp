import { hcpPatch, hcpPostForm, hcpPost } from '../src/hcp/client.js';

const EST_UUID = "est_24765cfd939c40d78e466330c123ae99";
const CSR_UUID = "csr_4ca5ba366d3043c49f94d6df62d10f49";
const NEW_ADDR_UUID = "adr_88e41bd33e924b94bf930be428c89444";

// The HCP web app likely uses a specific mutation endpoint.
// Let me try the request/update pattern used by the JS app

// Try 1: PUT /pro/requests/{csr_id}/update_service_address (form-encoded)
console.log("=== Try POST /pro/requests/467166953/update_service_address ===");
try {
  const r1 = await hcpPostForm("/pro/requests/467166953/update_service_address", {
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r1).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}

// Try 2: PATCH /alpha/jobs/{est_uuid} with address_uuid (not service_address_uuid)
console.log("\n=== Try PATCH /alpha/jobs/" + EST_UUID + " (address_uuid) ===");
try {
  const r2 = await hcpPatch("/alpha/jobs/" + EST_UUID, {
    address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r2).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}

// Try 3: POST /pro/jobs/{est_uuid}/change_address (form-encoded) 
console.log("\n=== Try POST /pro/jobs/" + EST_UUID + "/change_address ===");
try {
  const r3 = await hcpPostForm("/pro/jobs/" + EST_UUID + "/change_address", {
    address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r3).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}

// Try 4: PUT /alpha/jobs/{est_uuid} (PUT instead of PATCH)
console.log("\n=== Try PUT /alpha/jobs/" + EST_UUID + " ===");
try {
  const r4 = await hcpPatch("/alpha/jobs/" + EST_UUID, {
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r4).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}
