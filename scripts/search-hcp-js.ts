/**
 * Download HCP JS bundles and search for service_address mutation endpoints
 */
const BUNDLES = [
  'https://frontend-cdn.housecallpro.com/runtime-fb980c7b4f0fe0f5.js',
  'https://frontend-cdn.housecallpro.com/39078-e61347eb3a4f81b4.js',
  'https://frontend-cdn.housecallpro.com/client-bf6307cac148f826.js',
];

for (const url of BUNDLES) {
  console.log(`\n=== ${url.split('/').pop()} ===`);
  const res = await fetch(url);
  const js = await res.text();
  console.log(`Size: ${(js.length / 1024).toFixed(0)}KB`);

  // Search for service_address mutation patterns
  const patterns = [
    /["']service_address[^"']{0,40}["']/g,
    /["'][^"']*change_address[^"']*["']/gi,
    /["'][^"']*update_address[^"']*["']/gi,
    /["'][^"']*\/alpha\/[^"']*address[^"']*["']/gi,
    /PATCH.*?service_address/g,
    /service_address_uuid/g,
  ];

  for (const p of patterns) {
    const matches = [...js.matchAll(p)];
    if (matches.length > 0) {
      console.log(`  Pattern ${p}: ${matches.length} matches`);
      for (const m of matches.slice(0, 5)) {
        const start = Math.max(0, m.index - 40);
        const end = Math.min(js.length, m.index + m[0].length + 40);
        console.log(`    ...${js.slice(start, end)}...`);
      }
    }
  }
}
