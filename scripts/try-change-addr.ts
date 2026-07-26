import { hcpPatch, hcpPostForm } from '../src/hcp/client.js';

const EST_UUID = "est_24765cfd939c40d78e466330c123ae99";
const CSR_UUID = "csr_4ca5ba366d3043c49f94d6df62d10f49";
const BEST_UUID = "best_76601b2da8ef472bb22abdef85cf98a5";
const NEW_ADDR = "adr_88e41bd33e924b94bf930be428c89444";

// Try 1: PATCH on the composite service request with service_address_uuid
console.log("=== Try PATCH /alpha/composite_service_requests/" + CSR_UUID + " (service_address_uuid) ===");
try {
  const r1 = await hcpPatch("/alpha/composite_service_requests/" + CSR_UUID, {
    service_address_uuid: NEW_ADDR,
  });
  console.log("SUCCESS:", JSON.stringify(r1).slice(0, 500));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}

// Try 2: PATCH on the CSR with address_id (numeric)
console.log("\n=== Try PATCH /alpha/composite_service_requests/" + CSR_UUID + " (address_id=247943456) ===");
try {
  const r2 = await hcpPatch("/alpha/composite_service_requests/" + CSR_UUID, {
    address_id: 247943456,
  });
  console.log("SUCCESS:", JSON.stringify(r2).slice(0, 500));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}

// Try 3: PATCH on best_estimate
console.log("\n=== Try PATCH /alpha/best_estimates/" + BEST_UUID + " ===");
try {
  const r3 = await hcpPatch("/alpha/best_estimates/" + BEST_UUID, {
    service_address_uuid: NEW_ADDR,
  });
  console.log("SUCCESS:", JSON.stringify(r3).slice(0, 500));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}

// Try 4: PUT /pro/change_address (form-encoded like other /pro/ endpoints)
console.log("\n=== Try POST /pro/change_estimate_address/" + EST_UUID + " ===");
try {
  const r4 = await hcpPostForm("/pro/change_estimate_address/" + EST_UUID, {
    service_address_uuid: NEW_ADDR,
  });
  console.log("SUCCESS:", JSON.stringify(r4).slice(0, 500));
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
}
