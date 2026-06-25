/**
 * End-to-end test for the Mav memory system.
 * Runs 5 jobs through the agent (2-turn: describe → "build it"),
 * then creates real HCP estimates assigned to Carter only.
 * Customer: Madison Barns on every test.
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CARTER_ID = process.env.CARTER_TECH_ID!;
const CUSTOMER = 'Madison Barns';
const ESTIMATE_READY_RE = /\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/;

if (!CARTER_ID) throw new Error('CARTER_TECH_ID not set in .env');

function runAgent(prompt: string, history: Array<{ role: string; content: string }> = []) {
  const input = JSON.stringify({ prompt, history, channel: 'mcc' });
  const r = spawnSync('npx tsx src/agent/run.ts', [], {
    input,
    encoding: 'utf-8',
    cwd: ROOT,
    timeout: 120_000,
    shell: true,
    env: { ...process.env },
  });
  // stderr is progress lines — pass through for visibility
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) throw new Error(`run.ts spawn error: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`run.ts exited ${r.status} (signal=${r.signal}): ${r.stderr?.slice(0, 500)}`);
  const out = r.stdout?.trim();
  if (!out) throw new Error(`run.ts produced no stdout. stderr: ${r.stderr?.slice(0, 500)}`);
  // stdout may have progress lines mixed in — find the last JSON line
  const lines = out.split('\n').filter(l => l.trim().startsWith('{'));
  const jsonLine = lines[lines.length - 1];
  if (!jsonLine) throw new Error(`No JSON found in run.ts stdout: ${out.slice(0, 300)}`);
  const parsed = JSON.parse(jsonLine);
  if (!parsed.success) throw new Error(`Agent error: ${parsed.error ?? parsed.response}`);
  return parsed.response as string;
}

function runEstimate(lineItems: unknown[], newPricebookItems: unknown[] = []) {
  const input = JSON.stringify({
    lineItems,
    newPricebookItems,
    customerName: CUSTOMER,
    techIds: [CARTER_ID],
  });
  const r = spawnSync('npx tsx src/automations/estimates/from-chat.ts', [], {
    input,
    encoding: 'utf-8',
    cwd: ROOT,
    timeout: 300_000,
    shell: true,
    env: { ...process.env },
  });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) throw new Error(`from-chat.ts spawn error: ${r.error.message}`);
  const out = r.stdout?.trim();
  if (!out) throw new Error(`from-chat.ts produced no stdout. exit=${r.status} stderr=${r.stderr?.slice(0, 300)}`);
  const lines = out.split('\n').filter(l => l.trim().startsWith('{'));
  const jsonLine = lines[lines.length - 1];
  if (!jsonLine) throw new Error(`No JSON found in from-chat.ts stdout: ${out.slice(0, 300)}`);
  return JSON.parse(jsonLine) as { success: boolean; estimateUrl?: string; unmatched?: string[]; error?: string };
}

const TESTS: { name: string; job: string }[] = [
  {
    name: 'Test 1 — Simple flat-rate circuit (30′, attic, outlet)',
    job: 'Old work, finished walls. Need to add a 20 amp dedicated circuit from the panel, routing through the accessible attic, about 30 feet to a new dedicated outlet in the home office. Customer is Madison Barns. Assign to Carter only.',
  },
  {
    name: 'Test 2 — 40′ circuit + dedicated GFCI (separate device)',
    job: 'Old work, finished walls. Run a 20 amp circuit from the panel, accessible attic, 40 feet, drop down to a dedicated GFCI outlet in the kitchen. Customer is Madison Barns. Assign to Carter only.',
  },
  {
    name: 'Test 3 — 140′ per-foot bracket circuit',
    job: 'Old work, finished walls. Need a 20 amp circuit from the panel, through the attic, about 140 feet run to a dedicated outlet on the far side of the house. Customer is Madison Barns. Assign to Carter only.',
  },
  {
    name: 'Test 4 — EV charger alias (Tesla Level 2)',
    job: "Old work. Customer Madison Barns wants a Tesla Level 2 charger in the garage. Panel is about 5 feet away and there's an open slot. Customer is supplying the charger. Assign to Carter only.",
  },
  {
    name: 'Test 5 — Outdoor conduit run (conduit pairing + THHN + GFCI)',
    job: 'Old work, finished walls. New 20 amp circuit from the panel, runs 15 feet to the exterior wall, then 25 feet of half-inch PVC conduit outside to a weatherproof GFCI outlet on the back patio. Customer is Madison Barns. Assign to Carter only.',
  },
];

async function runTest(t: { name: string; job: string }) {
  const SEP = '═'.repeat(64);
  console.log(`\n${SEP}`);
  console.log(`  ${t.name}`);
  console.log(SEP);
  console.log(`  Job: "${t.job}"`);
  console.log('');

  // ── Turn 1: describe the job ──────────────────────────────────────────────
  console.log('▶ Turn 1 → Mav...');
  let response1: string;
  try {
    response1 = runAgent(t.job);
  } catch (e) {
    console.error(`✗ Turn 1 failed: ${e}`);
    return;
  }

  console.log('\n── Mav Turn 1 ──────────────────────────────────────────────');
  // Truncate to keep output readable — strip ESTIMATE_READY from display
  const display1 = response1.replace(ESTIMATE_READY_RE, '[ESTIMATE_READY block]').trim();
  console.log(display1.length > 1500 ? display1.slice(0, 1500) + '…' : display1);
  console.log('────────────────────────────────────────────────────────────\n');

  let estimatePayload: { lineItems: unknown[]; newPricebookItems?: unknown[] } | null = null;

  const match1 = response1.match(ESTIMATE_READY_RE);
  if (match1) {
    estimatePayload = JSON.parse(match1[1]);
    console.log('(ESTIMATE_READY in Turn 1 — skipping Turn 2)');
  } else {
    // ── Turn 2: "build it" ──────────────────────────────────────────────────
    console.log('▶ Turn 2 → "build it"...');
    const history2 = [
      { role: 'user', content: t.job },
      { role: 'assistant', content: response1 },
    ];
    let response2: string;
    try {
      response2 = runAgent('build it', history2);
    } catch (e) {
      console.error(`✗ Turn 2 failed: ${e}`);
      return;
    }

    console.log('\n── Mav Turn 2 ──────────────────────────────────────────────');
    const display2 = response2.replace(ESTIMATE_READY_RE, '[ESTIMATE_READY block]').trim();
    console.log(display2.length > 1500 ? display2.slice(0, 1500) + '…' : display2);
    console.log('────────────────────────────────────────────────────────────\n');

    const match2 = response2.match(ESTIMATE_READY_RE);
    if (match2) {
      estimatePayload = JSON.parse(match2[1]);
    } else {
      // ── Turn 3: confirm customer + tech and force emit ──────────────────
      console.log('▶ Turn 3 → confirming customer/tech and forcing emit...');
      const history3 = [
        ...history2,
        { role: 'assistant', content: response2 },
        { role: 'user', content: 'build it' },
      ];
      let response3: string;
      try {
        response3 = runAgent('Customer is Madison Barns. Assign to Carter only. Build it.', history3);
      } catch (e) {
        console.error(`✗ Turn 3 failed: ${e}`);
        return;
      }

      console.log('\n── Mav Turn 3 ──────────────────────────────────────────────');
      const display3 = response3.replace(ESTIMATE_READY_RE, '[ESTIMATE_READY block]').trim();
      console.log(display3.length > 1500 ? display3.slice(0, 1500) + '…' : display3);
      console.log('────────────────────────────────────────────────────────────\n');

      const match3 = response3.match(ESTIMATE_READY_RE);
      if (match3) {
        estimatePayload = JSON.parse(match3[1]);
      } else {
        // ── Turn 4: force emit with $0 flags for any unpriced items ──────────
        console.log('▶ Turn 4 → forcing emit with $0 flags for unpriced items...');
        const history4 = [
          ...history3,
          { role: 'user', content: 'Customer is Madison Barns. Assign to Carter only. Build it.' },
          { role: 'assistant', content: response3 },
        ];
        let response4: string;
        try {
          response4 = runAgent(
            'Emit the ESTIMATE_READY block now. Leave unpriced items at $0 with the NEEDS_PRICING flag — we will price them manually in HCP. Carter only.',
            history4
          );
        } catch (e) {
          console.error(`✗ Turn 4 failed: ${e}`);
          return;
        }

        console.log('\n── Mav Turn 4 ──────────────────────────────────────────────');
        const display4 = response4.replace(ESTIMATE_READY_RE, '[ESTIMATE_READY block]').trim();
        console.log(display4.length > 1500 ? display4.slice(0, 1500) + '…' : display4);
        console.log('────────────────────────────────────────────────────────────\n');

        const match4 = response4.match(ESTIMATE_READY_RE);
        if (!match4) {
          console.error('✗ No ESTIMATE_READY block found after Turn 4');
          return;
        }
        estimatePayload = JSON.parse(match4[1]);
      }
    }
  }

  // ── Log extracted line items ──────────────────────────────────────────────
  const items = estimatePayload!.lineItems as Array<{ name: string; quantity: number; unitPrice: number }>;
  console.log('Extracted line items:');
  items.forEach(it => console.log(`  • ${it.name} × ${it.quantity}  @$${it.unitPrice}`));
  if ((estimatePayload!.newPricebookItems as unknown[] | undefined)?.length) {
    console.log('New pricebook items:');
    (estimatePayload!.newPricebookItems as Array<{ name: string; unitPrice: number; quantity: number }>).forEach(
      it => console.log(`  + ${it.name} × ${it.quantity}  @$${it.unitPrice}`)
    );
  }

  // ── Create HCP estimate ───────────────────────────────────────────────────
  console.log(`\n▶ Creating HCP estimate → ${CUSTOMER}, Carter only...`);
  let result;
  try {
    result = runEstimate(
      estimatePayload!.lineItems as unknown[],
      (estimatePayload!.newPricebookItems as unknown[] | undefined) ?? []
    );
  } catch (e) {
    console.error(`✗ from-chat.ts threw: ${e}`);
    return;
  }

  if (result.success) {
    console.log(`\n✅  Estimate created: ${result.estimateUrl}`);
    if (result.unmatched?.length) {
      console.log(`⚠️  Unmatched: ${result.unmatched.join(', ')}`);
    }
  } else {
    console.error(`\n✗ Estimate failed: ${result.error}`);
  }
}

(async () => {
  console.log(`\nMav Memory System — End-to-End Tests`);
  console.log(`Customer: ${CUSTOMER}  |  Tech: Carter only`);
  console.log(`Running ${TESTS.length} tests...\n`);

  for (const test of TESTS) {
    await runTest(test);
    // Brief pause between tests to avoid rate-limiting HCP
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n\nAll tests complete.');
})();
