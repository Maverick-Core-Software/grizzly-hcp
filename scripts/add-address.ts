/**
 * Add a service address to an existing HCP customer using grizzly-hcp's
 * cookie-based client (no browser needed at runtime).
 * 
 * Usage: npx tsx scripts/add-address.ts <customer_uuid> "<street>" "<city>" "<state>" "<zip>"
 */
import { hcpPatch, hcpPost } from '../src/hcp/client.js';

const [,, customerUuid, street, city, state, zip] = process.argv;

if (!customerUuid || !street || !city || !state || !zip) {
  console.error('Usage: npx tsx scripts/add-address.ts <customer_uuid> <street> <city> <state> <zip>');
  process.exit(1);
}

console.log(`Adding address: ${street}, ${city}, ${state} ${zip} to customer ${customerUuid}`);

// Try PATCH on customer with nested addresses_attributes (Rails accepts_nested_attributes)
// Also try the dedicated addresses endpoint
try {
  // First attempt: PATCH /api/v2/pro/customers/{uuid} with addresses_attributes
  // Using v2 endpoint since that's what get_customer_v2 uses
  const result = await hcpPatch(`/api/v2/pro/customers/${customerUuid}`, {
    addresses_attributes: [{
      street,
      street_line_2: '',
      city,
      state,
      zip,
      country: 'US',
    }],
  });
  
  console.log('PATCH succeeded!');
  console.log(JSON.stringify(result, null, 2));
  
  // Find the new address in the response
  const addresses = (result as any)?.addresses || [];
  const newAddr = addresses.find((a: any) => 
    (a.street || '').includes(street) || (a.printable_address || '').includes(street)
  );
  
  if (newAddr) {
    console.log(`\n✅ NEW_ADDRESS_UUID=${newAddr.uuid || newAddr.id}`);
  }
} catch (err: any) {
  console.error('PATCH /api/v2/pro/customers failed:', err.message);
  
  // Fallback: try POST to /alpha/customers/{uuid}/addresses
  try {
    console.log('\nTrying POST /alpha/customers/{uuid}/addresses ...');
    const result2 = await hcpPost(`/alpha/customers/${customerUuid}/addresses`, {
      street,
      street_line_2: '',
      city,
      state,
      zip,
      country: 'US',
    });
    console.log('POST succeeded!');
    console.log(JSON.stringify(result2, null, 2));
    if ((result2 as any)?.id || (result2 as any)?.uuid) {
      console.log(`\n✅ NEW_ADDRESS_UUID=${(result2 as any).id || (result2 as any).uuid}`);
    }
  } catch (err2: any) {
    console.error('POST /alpha/customers/{uuid}/addresses also failed:', err2.message);
    process.exit(1);
  }
}
