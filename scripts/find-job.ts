import { getCookieHeader } from '../src/hcp/auth.js';

const cookie = await getCookieHeader();
const csrfMatch = cookie.split('; ').find(c => c.startsWith('csrf_token='));
const csrf = csrfMatch ? decodeURIComponent(csrfMatch.split('=').slice(1).join('=')) : '';

const headers = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Cookie': cookie,
  'X-CSRF-Token': csrf,
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// Search for the estimate on app.housecallpro.com (alpha search API)
try {
  const res = await fetch('https://app.housecallpro.com/alpha/search?query=Layin+Style+Remodeling+Remodel&types=Job', { headers });
  const text = await res.text();
  console.log(`Search (${res.status}):`, text.substring(0, 3000));
} catch (e: any) {
  console.log('Search error:', e.message);
}

// Also try the open estimates report
try {
  const res = await fetch('https://app.housecallpro.com/alpha/reports/open_estimates', { headers });
  const text = await res.text();
  console.log(`\nOpen estimates (${res.status}):`, text.substring(0, 3000));
} catch (e: any) {
  console.log('Open estimates error:', e.message);
}
