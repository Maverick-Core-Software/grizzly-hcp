/**
 * Try the address change on app.housecallpro.com domain (same as HCP-MCP client).
 * The grizzly-hcp cookie client defaults to pro.housecallpro.com.
 */
import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();
const APP_BASE = 'https://app.housecallpro.com';
const NEW_ADDR_UUID = 'adr_88e41bd33e924b94bf930be428c89444';
const EST_UUID = 'est_24765cfd939c40d78e466330c123ae99';

// First, try GET on the job via app. domain (we know this works per the reference doc)
console.log('=== GET /alpha/jobs/' + EST_UUID + ' (app. domain) ===');
const getRes = await fetch(`${APP_BASE}/alpha/jobs/${EST_UUID}`, {
  headers: {
    'Accept': 'application/json',
    Cookie: cookie,
    'X-Requested-With': 'XMLHttpRequest',
  },
});
console.log('Status:', getRes.status);
if (getRes.ok) {
  const data = await getRes.json();
  console.log('address_id:', data.address_id);
  console.log('printable_address:', data.printable_address);
}

// Now try PATCH on app. domain
console.log('\n=== PATCH /alpha/jobs/' + EST_UUID + ' (app. domain) ===');

// Extract CSRF from cookie
const csrfMatch = cookie.split('; ').find(c => c.startsWith('csrf_token='));
const csrf = csrfMatch ? decodeURIComponent(csrfMatch.split('=').slice(1).join('=')) : '';

const patchRes = await fetch(`${APP_BASE}/alpha/jobs/${EST_UUID}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    Cookie: cookie,
    'X-Requested-With': 'XMLHttpRequest',
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  },
  body: JSON.stringify({
    service_address_uuid: NEW_ADDR_UUID,
  }),
});
console.log('Status:', patchRes.status);
const patchText = await patchRes.text();
try {
  const patchData = JSON.parse(patchText);
  console.log('address_id:', patchData.address_id);
  console.log('printable_address:', patchData.printable_address);
} catch {
  console.log('Response:', patchText.slice(0, 300));
}

// Also try PATCH on app. with numeric service_address_id
console.log('\n=== PATCH /alpha/jobs/' + EST_UUID + ' with service_address_id=247943456 (app.) ===');
const patchRes2 = await fetch(`${APP_BASE}/alpha/jobs/${EST_UUID}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    Cookie: cookie,
    'X-Requested-With': 'XMLHttpRequest',
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  },
  body: JSON.stringify({
    service_address_id: 247943456,
  }),
});
console.log('Status:', patchRes2.status);
const patchText2 = await patchRes2.text();
try {
  const patchData2 = JSON.parse(patchText2);
  console.log('address_id:', patchData2.address_id);
  console.log('printable_address:', patchData2.printable_address);
} catch {
  console.log('Response:', patchText2.slice(0, 300));
}
