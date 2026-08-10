/**
 * Use the HCP-MCP Playwright browser to intercept the actual XHR call.
 * The MCP server has a live authenticated Chrome session.
 * We'll inject a fetch interceptor that logs all PATCH/POST requests,
 * then navigate to the estimate and change the address.
 * 
 * Actually - simpler approach: use the HCP web app's own JavaScript.
 * The Ember app stores models. Let me check what the app already loaded.
 */
import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();

// Let me try the "pro" endpoints with the numeric estimate ID
// HCP's web app uses numeric IDs for many internal routes

const estNumericId = '494624336';  // from the job data, basic_info.id

// Try PATCH /pro/jobs/{numeric_id} with form-encoded body
const BASE = 'https://pro.housecallpro.com';
console.log('=== PATCH /pro/jobs/' + estNumericId + ' (form) ===');
const formData = new URLSearchParams({
  service_address_uuid: 'adr_88e41bd33e924b94bf930be428c89444',
}).toString();

const res = await fetch(`${BASE}/pro/jobs/${estNumericId}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    Cookie: cookie,
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: formData,
});
console.log('Status:', res.status);
const text = await res.text();
console.log('Response:', text.slice(0, 500));

// Try PATCH /pro/estimates/{numeric_id} 
console.log('\n=== PATCH /pro/estimates/' + estNumericId + ' (form) ===');
const res2 = await fetch(`${BASE}/pro/estimates/${estNumericId}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    Cookie: cookie,
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: formData,
});
console.log('Status:', res2.status);
const text2 = await res2.text();
console.log('Response:', text2.slice(0, 500));

// Try the service request endpoint with form encoding  
console.log('\n=== PATCH /pro/service_requests/467166953 (form) ===');
const res3 = await fetch(`${BASE}/pro/service_requests/467166953`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    Cookie: cookie,
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: formData,
});
console.log('Status:', res3.status);
const text3 = await res3.text();
console.log('Response:', text3.slice(0, 500));
