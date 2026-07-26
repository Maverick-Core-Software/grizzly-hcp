import { hcpPatch, hcpPostForm, hcpPost } from '../src/hcp/client.js';

const EST_UUID = "est_24765cfd939c40d78e466330c123ae99";
const CSR_UUID = "csr_4ca5ba366d3043c49f94d6df62d10f49";
const NEW_ADDR_UUID = "adr_88e41bd33e924b94bf930be428c89444";

// The HCP web app uses Ember.js with a JSON API. The address change is likely
// done via a specific mutation endpoint. Let's try the Ember/JSONAPI patterns.

// Try 1: POST /alpha/jobs/{est_uuid}/change_service_address 
console.log("=== Try POST /alpha/jobs/" + EST_UUID + "/change_service_address ===");
try {
  const r1 = await hcpPost("/alpha/jobs/" + EST_UUID + "/change_service_address", {
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r1).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}

// Try 2: POST /alpha/jobs/{est_uuid}/update_address
console.log("\n=== Try POST /alpha/jobs/" + EST_UUID + "/update_address ===");
try {
  const r2 = await hcpPost("/alpha/jobs/" + EST_UUID + "/update_address", {
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r2).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}

// Try 3: PATCH /alpha/jobs/{est_uuid} with service_address_attributes (Rails nested)
console.log("\n=== Try PATCH /alpha/jobs/" + EST_UUID + " with service_address_attributes ===");
try {
  const r3 = await hcpPatch("/alpha/jobs/" + EST_UUID, {
    service_address_attributes: {
      id: NEW_ADDR_UUID,
    },
  });
  console.log("SUCCESS:", JSON.stringify(r3).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}

// Try 4: Use the v1 API - POST /api/v1/estimates/{est_uuid}
console.log("\n=== Try PATCH /api/v1/jobs/" + EST_UUID + " ===");
try {
  const r4 = await hcpPatch("/api/v1/jobs/" + EST_UUID, {
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r4).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}

// Try 5: PUT /pro/update_service_address (form-encoded, used by estimate create)
console.log("\n=== Try POST /pro/update_service_address ===");
try {
  const r5 = await hcpPostForm("/pro/update_service_address", {
    job_uuid: EST_UUID,
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r5).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}

// Try 6: PATCH on the estimate request directly with the composite_service_request_uuid
console.log("\n=== Try PATCH /alpha/jobs/" + EST_UUID + " with composite_service_request ===");
try {
  const r6 = await hcpPatch("/alpha/jobs/" + EST_UUID, {
    composite_service_request_attributes: {
      service_address_uuid: NEW_ADDR_UUID,
    },
  });
  console.log("SUCCESS:", JSON.stringify(r6).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 200));
}
