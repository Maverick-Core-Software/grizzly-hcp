#!/usr/bin/env npx tsx
/**
 * RAG Evaluation Harness — measures recall@5 and recall@10 against 20 golden Q&A pairs.
 * Usage: npx tsx scripts/rag-eval.ts
 * Exit 0 if recall@10 >= 70%, else exit 1.
 */

const RAG_BASE = process.env.RAG_URL ?? 'http://192.168.1.12:8181';

interface RagSource {
  text: string;
  source: string;
  score: number;
}

interface RagResponse {
  answer: string;
  sources: RagSource[];
}

interface GoldenPair {
  question: string;
  keywords: string[];
}

const GOLDEN_PAIRS: GoldenPair[] = [
  // NEC / Code questions
  { question: 'What is the GFCI requirement for garage outlets?', keywords: ['GFCI', 'garage', 'ground fault'] },
  { question: 'What wire gauge is required for a 20-amp circuit?', keywords: ['12 AWG', '12-gauge', '20-amp'] },
  { question: 'When is AFCI protection required?', keywords: ['AFCI', 'arc fault', 'bedroom'] },
  { question: 'What is the minimum clearance for an electrical panel?', keywords: ['clearance', 'working space', 'panel'] },
  { question: 'How many circuits are allowed on a 200A residential service?', keywords: ['200', 'service', 'load calculation'] },

  // Pricing questions
  { question: 'How much does a 200A panel upgrade cost?', keywords: ['panel', 'upgrade', '200'] },
  { question: 'What is the price for installing a GFCI outlet?', keywords: ['GFCI', 'outlet', 'price'] },
  { question: 'How much for a 50-amp EV charger circuit?', keywords: ['EV', 'charger', '50'] },
  { question: 'What does a ceiling fan installation cost?', keywords: ['fan', 'installation', 'ceiling'] },
  { question: 'Price for running a new 20-amp kitchen circuit?', keywords: ['circuit', 'kitchen', '20'] },

  // Customer / HCP questions
  { question: "What is Grizzly's service area?", keywords: ['Grizzly', 'service', 'electrical'] },
  { question: 'What is a typical estimate for a panel upgrade?', keywords: ['estimate', 'panel'] },
  { question: 'What are prior jobs for residential panel upgrades?', keywords: ['panel', 'residential'] },
  { question: 'What services does Grizzly Electrical offer?', keywords: ['Grizzly', 'electrical', 'service'] },
  { question: 'What are common electrical issues in older homes?', keywords: ['older', 'home', 'electrical'] },

  // Scope / SOP questions
  { question: 'What steps are involved in a 200A service upgrade?', keywords: ['Oncor', 'permit', 'panel'] },
  { question: 'What wire gauge for EV charger Level 2 install?', keywords: ['6', 'gauge', '240'] },
  { question: 'What permit is required for panel upgrade in Dallas?', keywords: ['permit', 'Dallas', 'panel'] },
  { question: 'What is the process for adding a new circuit?', keywords: ['circuit', 'breaker', 'wire gauge'] },
  { question: 'How do you size a breaker for a new circuit?', keywords: ['125%', 'breaker', 'load'] },
];

function hitsKeywords(sources: RagSource[], keywords: string[]): boolean {
  const combined = sources.map(s => s.text).join(' ').toLowerCase();
  return keywords.some(kw => combined.includes(kw.toLowerCase()));
}

async function evalQuestion(pair: GoldenPair, n: number): Promise<{ hit5: boolean; hit10: boolean }> {
  const response = await fetch(`${RAG_BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: pair.question, top_k: 10 }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as RagResponse;
  const sources = data.sources ?? [];

  return {
    hit5: hitsKeywords(sources.slice(0, 5), pair.keywords),
    hit10: hitsKeywords(sources.slice(0, 10), pair.keywords),
  };
}

async function main(): Promise<void> {
  console.log(`RAG Evaluation Harness — ${new Date().toISOString()}`);
  console.log(`Target: ${RAG_BASE}\n`);

  let pass5 = 0;
  let pass10 = 0;

  for (let i = 0; i < GOLDEN_PAIRS.length; i++) {
    const pair = GOLDEN_PAIRS[i];
    const n = i + 1;
    const label = `Q${n}`;
    const truncated = pair.question.length > 60 ? pair.question.slice(0, 57) + '...' : pair.question;

    try {
      const { hit5, hit10 } = await evalQuestion(pair, n);

      if (hit5) pass5++;
      if (hit10) pass10++;

      const t5 = hit5 ? 'PASS@5 ' : 'FAIL@5 ';
      const t10 = hit10 ? 'PASS@10' : 'FAIL@10';
      console.log(`[${t5}] [${t10}] ${label}: ${truncated}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[ERROR] ${label}: ${msg}`);
    }
  }

  const total = GOLDEN_PAIRS.length;
  const pct5 = Math.round((pass5 / total) * 100);
  const pct10 = Math.round((pass10 / total) * 100);

  console.log('\n─────────────────────────────────────');
  console.log(`Recall@5:  ${pass5}/${total} (${pct5}%)`);
  console.log(`Recall@10: ${pass10}/${total} (${pct10}%)`);
  console.log('─────────────────────────────────────');

  process.exit(pct10 >= 70 ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
