/**
 * Creates an HCP estimate from a chat-based job scope.
 * Called by MCC/MCA server via child_process.spawn.
 *
 * stdin:  JSON {
 *   scope?,          — free-text job description (either scope or lineItems required)
 *   lineItems?,      — pre-structured items from conversation (skips RAG matching)
 *   customerName?,
 *   customerEmail?,
 *   customerPhone?,
 *   techIds?,        — pro_... UUIDs to assign; defaults to Carter + Jaime if omitted
 *   depositPercent?, — 50 = 50% deposit; 0 or omitted = no deposit
 *   operationId?,    — for idempotency; generated here if not supplied
 * }
 * stdout: JSON { success: true, estimateUrl, estimateUuid, unmatched }
 *         JSON { success: false, error }
 * stderr: human-readable [progress] lines
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { searchCustomer, createCustomer } from '../../hcp/estimates.js';
import { matchLineItems } from '../../rag/price-book.js';
import { buildLineItem, itemKind } from '../../hcp/build-line-item.js';
import { commitEstimateWorkflow } from '../../agent/workflows/private-hcp-writes/commit-estimate.js';
import type { CommitLineItem } from '../../agent/workflows/private-hcp-writes/commit-estimate.js';

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
    scope?: string;
    lineItems?: Array<{ name: string; quantity: number; unitPrice: number; type: string; serviceItemId?: string }>;
    newPricebookItems?: Array<{ name: string; description: string; category?: string; unitPrice: number; quantity: number; saveToBook: boolean }>;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
    techIds?: string[];
    depositPercent?: number;
    operationId?: string;
  };

  const {
    scope,
    lineItems,
    newPricebookItems,
    customerName,
    customerEmail,
    customerPhone,
    techIds: incomingTechIds,
    depositPercent,
    operationId = randomUUID(),
  } = payload;

  if (!scope?.trim() && !lineItems?.length) {
    process.stdout.write(JSON.stringify({ success: false, error: 'No scope or line items provided.' }));
    return;
  }

  // Tech IDs: use provided list, or fall back to Carter + Jaime
  const techIds: string[] = incomingTechIds?.length
    ? incomingTechIds
    : [process.env.CARTER_TECH_ID, process.env.JAIME_TECH_ID].filter(Boolean) as string[];

  // ── Find or create customer ───────────────────────────────────────────────

  let customerId: string;
  let addressId: string;

  if (customerName) {
    progress(`Searching for customer: ${customerName}...`);
    let found = await searchCustomer(customerName);

    if (!found && customerEmail) {
      const emailPrefix = customerEmail.split('@')[0].replace(/[._-]/g, ' ');
      found = await searchCustomer(emailPrefix);
    }

    if (!found) {
      progress(`Customer not found — creating ${customerName}...`);
      try {
        const created = await createCustomer({
          name: customerName,
          email: customerEmail || '',
          phone: customerPhone,
        });
        progress(`Created customer: ${created.name}`);
        customerId = created.id;
        addressId = created.addressId;
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        process.stdout.write(JSON.stringify({ success: false, error: `Could not create customer "${customerName}": ${err}` }));
        return;
      }
    } else {
      progress(`Found customer: ${found.name}`);
      customerId = found.id;
      addressId = found.addressId;
    }
  } else {
    progress('No customer info provided — creating placeholder...');
    try {
      const placeholder = await createCustomer({ name: 'Unknown Customer', email: '' });
      progress('Placeholder customer created — update in HCP after.');
      customerId = placeholder.id;
      addressId = placeholder.addressId;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      process.stdout.write(JSON.stringify({ success: false, error: `Could not create placeholder customer: ${err}` }));
      return;
    }
  }

  // ── Build line items ──────────────────────────────────────────────────────

  let commitLineItems: CommitLineItem[];

  if (lineItems?.length) {
    // Pre-structured items from conversation — skip extraction + RAG matching
    progress(`Using ${lineItems.length} pre-structured item(s) from conversation`);
    commitLineItems = lineItems.map((li, i) => ({
      name: li.name,
      description: li.name,
      unitPrice: li.unitPrice,
      quantity: li.quantity,
      kind: itemKind(li.name, '') as CommitLineItem['kind'],
      serviceItemId: li.serviceItemId,
      orderIndex: i,
    }));
    // Append agent-proposed new items (not in pricebook)
    if (newPricebookItems?.length) {
      progress(`Adding ${newPricebookItems.length} new item(s) proposed by agent`);
      newPricebookItems.forEach((nb, j) => {
        commitLineItems.push({
          name: nb.name,
          description: nb.description,
          unitPrice: nb.unitPrice,
          quantity: nb.quantity,
          kind: itemKind(nb.name, nb.description) as CommitLineItem['kind'],
          orderIndex: commitLineItems.length + j,
          isNew: true,
        });
      });
    }
  } else {
    progress('Extracting service items from scope...');
    let workItems: Array<{ description: string; quantity: number; unitPrice: number }>;
    try {
      workItems = await extractServiceItems(scope!);
      progress(`Found ${workItems.length} service item(s): ${workItems.map(i => i.description).join(', ')}`);
    } catch (e) {
      progress(`Item extraction failed: ${e instanceof Error ? e.message : e} — using fallback`);
      workItems = [{ description: 'Electrical Service', quantity: 1, unitPrice: 0 }];
    }

    progress('Matching to pricebook...');
    const matched = await matchLineItems(workItems);
    commitLineItems = matched.map((m, i) => {
      const { item } = buildLineItem(m, i);
      return {
        name: item.name,
        description: item.description,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        kind: item.kind,
        serviceItemId: item.serviceItemId,
        orderIndex: i,
      };
    });
  }

  // Progress: how many matched
  const unmatchedCount = commitLineItems.filter(li => !li.serviceItemId).length;
  if (unmatchedCount) {
    progress(`${unmatchedCount} item(s) will need manual pricing in HCP`);
  }

  // ── Commit via workflow (idempotent, audited) ─────────────────────────────

  // Items the agent wants saved to the pricebook permanently
  const newPricebookCommit = (newPricebookItems ?? [])
    .filter(nb => nb.saveToBook)
    .map(nb => ({
      name: nb.name,
      description: nb.description,
      price: nb.unitPrice,
      category: nb.category,
    }));

  progress('Creating estimate in HCP...');
  const result = await commitEstimateWorkflow({
    operationId,
    customer: { id: customerId, addressId, name: customerName || 'Unknown Customer' },
    lineItems: commitLineItems,
    newPricebookItems: newPricebookCommit.length ? newPricebookCommit : undefined,
    techIds,
    depositPercent,
  });

  if (!result.success) {
    if (result.manualRecovery) progress(`Recovery: ${result.manualRecovery}`);
    process.stdout.write(JSON.stringify({ success: false, error: result.error }));
    return;
  }

  if (result.unmatched.length) {
    progress(`${result.unmatched.length} item(s) need manual pricing: ${result.unmatched.join(', ')}`);
  }

  const techLabel = techIds.length
    ? `Assigned ${techIds.length} tech(s)`
    : 'No techs assigned';
  progress(`${techLabel}. Done! ${result.estimateUrl}`);

  process.stdout.write(JSON.stringify({
    success: true,
    estimateUrl: result.estimateUrl,
    estimateUuid: result.estimateUuid,
    unmatched: result.unmatched,
  }));
}

run().catch(err => {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
});
