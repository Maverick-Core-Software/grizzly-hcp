/**
 * Intercept the HCP web app's network call when changing service address.
 * 
 * Instead of guessing endpoints, let's navigate the HCP app with the 
 * cookie client and inspect the JS bundle to find the actual mutation endpoint.
 */
import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();

// Fetch the HCP app JS bundle and search for service address mutation patterns
const BASE = 'https://app.housecallpro.com';

// First, let's load the estimate page HTML to find script bundles
const res = await fetch(`${BASE}/app/estimates/467166953`, {
  headers: {
    Cookie: cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
});

const html = await res.text();
console.log('Page status:', res.status);

// Find all JS bundle URLs
const scriptMatches = html.match(/src="([^"]*\.js[^"]*)"/g) || [];
console.log(`\nFound ${scriptMatches.length} script tags`);
for (const m of scriptMatches.slice(0, 20)) {
  console.log(m.replace('src="', '').replace('"', ''));
}
