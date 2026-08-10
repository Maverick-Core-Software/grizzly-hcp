import { hcpPatch, hcpPostForm, hcpGet } from '../src/hcp/client.js';

const EST_UUID = "est_24765cfd939c40d78e466330c123ae99";
const CSR_UUID = "csr_4ca5ba366d3043c49f94d6df62d10f49";
const NEW_ADDR_UUID = "adr_88e41bd33e924b94bf930be428c89444";
const NEW_ADDR_ID = 247943456;

// Try 1: PATCH /alpha/jobs/{est_uuid} with full address object (not just uuid)
console.log("=== Try PATCH /alpha/jobs/" + EST_UUID + " with service_address_id ===");
try {
  const r1 = await hcpPatch("/alpha/jobs/" + EST_UUID, {
    service_address_id: NEW_ADDR_ID,
  });
  console.log("SUCCESS:", JSON.stringify(r1).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}

// Try 2: PATCH /api/v2/pro/jobs/{est_uuid} 
console.log("\n=== Try PATCH /api/v2/pro/jobs/" + EST_UUID + " ===");
try {
  const r2 = await hcpPatch("/api/v2/pro/jobs/" + EST_UUID, {
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r2).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}

// Try 3: PATCH /alpha/jobs/{est_uuid} with service_address (full nested)
console.log("\n=== Try PATCH /alpha/jobs/" + EST_UUID + " with service_address object ===");
try {
  const r3 = await hcpPatch("/alpha/jobs/" + EST_UUID, {
    service_address: {
      id: NEW_ADDR_UUID,
    },
  });
  console.log("SUCCESS:", JSON.stringify(r3).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}

// Try 4: POST /pro/change_service_address (form-encoded, common HCP pattern)
console.log("\n=== Try POST /pro/change_service_address ===");
try {
  const r4 = await hcpPostForm("/pro/change_service_address", {
    job_id: EST_UUID,
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r4).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}

// Try 5: PATCH /alpha/composite_service_requests/{csr_uuid} on app. domain
// But our client uses pro. — let's try with the CSR endpoint path variations
console.log("\n=== Try PATCH /alpha/service_requests/" + CSR_UUID + " ===");
try {
  const r5 = await hcpPatch("/alpha/service_requests/" + CSR_UUID, {
    service_address_uuid: NEW_ADDR_UUID,
  });
  console.log("SUCCESS:", JSON.stringify(r5).slice(0, 800));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}
