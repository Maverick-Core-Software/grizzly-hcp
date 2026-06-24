// src/agent/tools/reads/home-depot.check.ts
// Run: npx tsx src/agent/tools/reads/home-depot.check.ts
import { fetchHomeDepotPrice } from './home-depot.js';

const result = await fetchHomeDepotPrice('1 inch EMT conduit');
console.log('HD lookup result:', result);
if (result) {
  const markup = +(result.price * 1.45).toFixed(2);
  console.log(`Grizzly price (45% markup): $${markup}`);
  console.log('✅ HD lookup working');
} else {
  console.log('⚠️  HD lookup returned null — check network or HD API change');
  console.log('This is acceptable — null is graceful degradation, not a crash');
}
