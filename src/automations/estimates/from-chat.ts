/**
 * Creates an HCP estimate from a chat-based job scope.
 * Called by MCC/MCA server via child_process.spawn.
 *
 * stdin:  JSON { scope, customerName?, customerEmail?, customerPhone? }
 * stdout: JSON { success: true, estimateUrl, estimateUuid }
 *         JSON { success: false, error }
 * stderr: human-readable progress lines prefixed with [progress]
 */
import 'dotenv/config';
import {
  searchCustomer,
  createCustomer,
  createEstimate,
  addLineItem,
  assignTechnician,
} from '../../hcp/estimates.js';
import { matchLineItems } from '../../rag/price-book.js';
import { buildLineItem } from '../../hcp/build-line-item.js';

function progress(msg: string) {
  process.stderr.write(`[progress] ${msg}\n`);
}

async function readStdin(): Promise<string> {
  let out = '';
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

async function extractServiceItems(scope: string): Promise<Array<{ description: string; quantity: number; unitPrice: number }>> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: [
        'You are an electrical service dispatcher. Extract distinct electrical work items from this job scope.',
        'Write each as a SHORT service name (2-6 words) using the same naming style as an electrician\'s price book.',
        'Examples of good short service names:',
        '  "replace GFCI" → "Replace GFCI Receptacle"',
        '  "add switch and ceiling light" → "Add New Switch and Fixture"',
        '  "EV charger install next to panel" → "EV Car Charger Install Next to Panel"',
        '  "200A panel upgrade" → "200A Panel Upgrade"',
        '  "ceiling fan install" → "Ceiling Fan Installation"',
        '  "outlet not working" → "Troubleshoot Level 1"',
        'Return JSON only — no prose: [{"description":"short name","quantity":1,"unitPrice":0}]',
        'One item per distinct task. Combine related steps of the same service into ONE item.',
      ].join('\n'),
      messages: [{ role: 'user', content: scope.slice(0, 3000) }],
    }),
  });

  if (!res.ok) throw new Error(`Haiku extract → ${res.status}`);
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in response');
  const items = JSON.parse(m[0]) as Array<{ description: string; quantity: number; unitPrice: number }>;
  if (Array.isArray(items) && items.length > 0) return items;
  throw new Error('empty result');
}

async function run() {
  const payload = JSON.parse(await readStdin()) as {
    scope: string;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
  };

  const { scope, customerName, customerEmail, customerPhone } = payload;

  if (!scope?.trim()) {
    process.stdout.write(JSON.stringify({ success: false, error: 'No scope provided.' }));
    return;
  }

  // ── Find or create customer ───────────────────────────────────────────────

  let customer: Awaited<ReturnType<typeof searchCustomer>>;

  if (customerName) {
    progress(`Searching for customer: ${customerName}...`);
    customer = await searchCustomer(customerName);

    if (!customer && customerEmail) {
      const emailPrefix = customerEmail.split('@')[0].replace(/[._-]/g, ' ');
      customer = await searchCustomer(emailPrefix);
    }

    if (!customer) {
      progress(`Customer not found — creating ${customerName}...`);
      try {
        customer = await createCustomer({
          name: customerName,
          email: customerEmail || '',
          phone: customerPhone,
        });
        progress(`Created customer: ${customer.name}`);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        process.stdout.write(JSON.stringify({ success: false, error: `Could not create customer "${customerName}": ${err}` }));
        return;
      }
    } else {
      progress(`Found customer: ${customer.name}`);
    }
  } else {
    // No customer info — create a placeholder so the estimate is created in HCP
    progress('No customer info provided — creating placeholder...');
    try {
      customer = await createCustomer({ name: 'Unknown Customer', email: '' });
      progress('Placeholder customer created — update in HCP after.');
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      process.stdout.write(JSON.stringify({ success: false, error: `Could not create placeholder customer: ${err}` }));
      return;
    }
  }

  // ── Create estimate ───────────────────────────────────────────────────────

  progress('Creating estimate in HCP...');
  const estimate = await createEstimate(customer.id, customer.addressId);
  progress(`Estimate created (${estimate.uuid.slice(0, 8)}...)`);

  // ── Extract and match line items ──────────────────────────────────────────

  progress('Extracting service items from scope...');
  let workItems: Array<{ description: string; quantity: number; unitPrice: number }>;
  try {
    workItems = await extractServiceItems(scope);
    progress(`Found ${workItems.length} service item(s): ${workItems.map(i => i.description).join(', ')}`);
  } catch (e) {
    progress(`Item extraction failed: ${e instanceof Error ? e.message : e} — using fallback`);
    workItems = [{ description: 'Electrical Service', quantity: 1, unitPrice: 0 }];
  }

  progress('Matching to pricebook...');
  const matched = await matchLineItems(workItems);

  // ── Add line items ────────────────────────────────────────────────────────

  // Items with no price book match are added at $0 with a NEEDS-PRICING flag
  // (so the estimate stays complete) and reported back for manual pricing.
  // They are deliberately NOT written to the live HCP price book.
  const unmatched: string[] = [];

  for (let i = 0; i < matched.length; i++) {
    const m = matched[i];
    const { item, matched: didMatch } = buildLineItem(m, i);

    await addLineItem(estimate.uuid, item, i);

    const label = didMatch
      ? `${Math.round(m.match!.score * 100)}% → "${m.match!.item.name}" @ $${m.match!.item.price}`
      : `no match — "${m.description}" @ $0 (needs manual pricing)`;
    progress(`Item ${i + 1}/${matched.length}: ${label}`);

    if (!didMatch) unmatched.push(m.description);
  }

  if (unmatched.length) {
    progress(`${unmatched.length} item(s) need manual pricing in HCP: ${unmatched.join(', ')}`);
  }

  // ── Assign techs ──────────────────────────────────────────────────────────

  const techId = process.env.CARTER_TECH_ID;
  if (techId) {
    try {
      const uuids = [techId, process.env.JAIME_TECH_ID].filter(Boolean) as string[];
      await assignTechnician(estimate.uuid, uuids);
      progress('Assigned Carter + Jaime');
    } catch (e) {
      progress(`Tech assignment failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const estimateUrl = `https://pro.housecallpro.com/app/estimates/${estimate.uuid}`;
  progress(`Done! ${estimateUrl}`);
  process.stdout.write(JSON.stringify({ success: true, estimateUrl, estimateUuid: estimate.uuid, unmatched }));
}

run().catch(err => {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
});
