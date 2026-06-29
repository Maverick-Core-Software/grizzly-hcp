// scripts/check-advisory-channel.ts
// Verifies the advisory channel exposes exactly the allow-listed RAG/memory tools
// and zero live-HCP or messaging tools.
// Run: npx tsx scripts/check-advisory-channel.ts

import { ragReadTools } from '../src/agent/tools/reads/rag.js';
import { hcpReadTools } from '../src/agent/tools/reads/hcp.js';
import { messagingReadTools } from '../src/agent/tools/reads/messaging.js';
import { homeDepotTools } from '../src/agent/tools/reads/home-depot.js';
import { memoryWriteTools } from '../src/agent/tools/writes/memory.js';
import { resolveTools } from '../src/agent/resolver.js';

const allTools = {
  ...ragReadTools,
  ...hcpReadTools,
  ...messagingReadTools,
  ...homeDepotTools,
  ...memoryWriteTools,
};

const MUST_INCLUDE = [
  'lookup_customer',
  'search_pricebook',
  'lookup_pricing',
  'get_prior_estimates',
  'search_knowledge',
  'lookup_home_depot_price',
  'save_rule',
  'save_alias',
];

const MUST_EXCLUDE = [
  'check_hcp_messages',
  'check_schedule',
  'get_job',
  'list_open_jobs',
  'get_customer_estimates',
  'check_thumbtack_messages',
  'draft_reply',
];

const resolved = resolveTools('advisory', allTools);
const resolvedKeys = new Set(Object.keys(resolved));

let failed = false;

for (const name of MUST_INCLUDE) {
  if (!resolvedKeys.has(name)) {
    console.error(`✗ MISSING required tool: ${name}`);
    failed = true;
  }
}

for (const name of MUST_EXCLUDE) {
  if (resolvedKeys.has(name)) {
    console.error(`✗ FORBIDDEN tool present: ${name}`);
    failed = true;
  }
}

const EXPECTED_SIZE = 8;
if (resolvedKeys.size !== EXPECTED_SIZE) {
  console.error(`✗ Expected exactly ${EXPECTED_SIZE} tools but got ${resolvedKeys.size}: [${[...resolvedKeys].join(', ')}]`);
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`✓ advisory channel exposes exactly 8 RAG/memory tools, zero live-HCP tools`);
