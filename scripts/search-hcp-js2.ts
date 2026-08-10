/**
 * The HCP app loads lazily — the estimate editor code isn't in the initial bundles.
 * The app is Ember-based with lazy chunk loading. Let me look at the actual app
 * page HTML more carefully for the estimate detail endpoint patterns.
 */
import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();
const BASE = 'https://app.housecallpro.com';

// The Ember app uses /alpha/ endpoints. Let me look at what the estimate page 
// loads when it opens. The address selector dropdown likely triggers a PATCH.
// Let me try a broader search approach - check the HCP API for the request structure.

// Try the JSONAPI-style endpoint: PATCH /alpha/requests/{csr_id}
const csrId = '467166953';
console.log('=== PATCH /alpha/requests/' + csrId + ' ===');
const res = await fetch(`${BASE}/alpha/requests/${csrId}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    Cookie: cookie,
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: JSON.stringify({
    service_address_uuid: 'adr_88e41bd33e924b94bf930be428c89444',
  }),
});
console.log('Status:', res.status);
const text = await res.text();
console.log('Response:', text.slice(0, 500));

// Also try the estimate-specific endpoint
console.log('\n=== PATCH /alpha/estimates/' + csrId + ' ===');
const res2 = await fetch(`${BASE}/alpha/estimates/${csrId}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    Cookie: cookie,
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: JSON.stringify({
    service_address_uuid: 'adr_88e41bd33e924b94bf930be428c89444',
  }),
});
console.log('Status:', res2.status);
const text2 = await res2.text();
console.log('Response:', text2.slice(0, 500));
