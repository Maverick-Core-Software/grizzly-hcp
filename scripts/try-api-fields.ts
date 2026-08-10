import { hcpGet, hcpPatch, hcpPut } from '../src/hcp/client.js';

const BEST_UUID = "best_76601b2da8ef472bb22abdef85cf98a5";
const NEW_ADDR_UUID = "adr_88e41bd33e924b94bf930be428c89444";
const NEW_ADDR_ID = 247943456;

// Try address_id (numeric) and address_uuid on /api/estimates/
console.log('=== PUT /api/estimates/best with address_id (numeric) ===');
try {
  const r1 = await hcpPut(`/api/estimates/${BEST_UUID}`, {
    address_id: NEW_ADDR_ID,
  });
  console.log('address_id:', r1.address_id, 'address_uuid:', r1.address_uuid);
} catch (e) {
  console.log('FAILED:', e.message.slice(0, 200));
}

// Try PUT /api/estimates/best with address_uuid
console.log('\n=== PUT /api/estimates/best with address_uuid ===');
try {
  const r2 = await hcpPut(`/api/estimates/${BEST_UUID}`, {
    address_uuid: NEW_ADDR_UUID,
  });
  console.log('address_id:', r2.address_id, 'address_uuid:', r2.address_uuid);
} catch (e) {
  console.log('FAILED:', e.message.slice(0, 200));
}

// Try PUT /api/estimates/best with both
console.log('\n=== PUT /api/estimates/best with both address_id + address_uuid ===');
try {
  const r3 = await hcpPut(`/api/estimates/${BEST_UUID}`, {
    address_id: NEW_ADDR_ID,
    address_uuid: NEW_ADDR_UUID,
  });
  console.log('address_id:', r3.address_id, 'address_uuid:', r3.address_uuid);
} catch (e) {
  console.log('FAILED:', e.message.slice(0, 200));
}

// Try PUT /api/estimates/best with service_address object
console.log('\n=== PUT /api/estimates/best with service_address object ===');
try {
  const r4 = await hcpPut(`/api/estimates/${BEST_UUID}`, {
    service_address: {
      id: NEW_ADDR_ID,
      uuid: NEW_ADDR_UUID,
    },
  });
  console.log('address_id:', r4.address_id, 'address_uuid:', r4.address_uuid);
} catch (e) {
  console.log('FAILED:', e.message.slice(0, 200));
}
