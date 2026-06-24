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
import { applyHdAutoPricing } from './hd-auto-price.js';
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
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Pull historical estimates + pricebook matches before extraction so Haiku
  // can use exact item names and see how Grizzly structures similar jobs.
  const { ragAsk, searchPriceBook } = await import('../../rag/client.js');
  const [historyResult, pricebookResult] = await Promise.allSettled([
    ragAsk(`Grizzly Electrical line items and estimates for: ${scope}`, 8),
    searchPriceBook(scope, 15),
  ]);

  const historyText = historyResult.status === 'fulfilled'
    ? (historyResult.value.sources as Array<{ text: string }>)
        .map(s => s.text).filter(Boolean).slice(0, 5).join('\n---\n')
    : '';

  const pricebookText = pricebookResult.status === 'fulfilled'
    ? pricebookResult.value
        .map(p => `"${p.name}" — $${p.price} (${p.category})`)
        .join('\n')
    : '';

  const systemLines = [
    'You are an electrical estimating dispatcher for Grizzly Electrical Solutions.',
    'Extract the exact line items needed for this job scope.',
    '',
    'RULES:',
    '- Use EXACT pricebook item names from the list below wherever they match.',
    '- Match amperage and size exactly — never substitute 400A for 200A, 20A for 15A, etc.',
    '- Overhead/underground service upgrades are multiple items: main panel PLUS meter base PLUS the service entrance (overhead: riser+weatherhead as one "Overhead Service" item; underground: conduit+wire). List each separately.',
    '- A conduit run = 3 items: (1) conduit material (type + size), (2) wire material (gauge × footage), (3) install labor (conduit type + size). List all three with footage as quantity.',
    '- "Install new slim downlight with new switch" = FIRST light on a new circuit (includes switch box + switchleg wire). Additional lights on same circuit = "Install new slim downlight" (no switch). Use quantity for multiples of the add-on.',
    '- SER cable / service entrance wire → list as a material item with footage as quantity.',
    '- For ALL footage-based items (wire, conduit, cable, trench), quantity = linear footage, not 1.',
    '- Brand/model names (Square D QO, Eaton BR, Leviton, etc.) are SPECS — never a separate line item. "Eaton BR 200A 40-space" → one item (the panel enclosure), not two.',
    '- Default panel brand: Eaton BR — use amperage in description, not brand name.',
    '- unitPrice = 0 always (system fills from pricebook). quantity = count or footage.',
  ];

  if (pricebookText) {
    systemLines.push('', 'AVAILABLE PRICEBOOK ITEMS (use these exact names):');
    systemLines.push(pricebookText);
  }

  if (historyText) {
    systemLines.push('', 'SIMILAR PAST GRIZZLY ESTIMATES (follow these patterns):');
    systemLines.push(historyText);
  }

  systemLines.push('', 'Return JSON only — no prose: [{"description":"exact item name","quantity":1,"unitPrice":0}]');

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: systemLines.join('\n'),
    messages: [{ role: 'user', content: scope.slice(0, 3000) }],
  });

  const text = (msg.content[0].type === 'text' ? msg.content[0].text : '').trim();
  const stripped = text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '');
  const m = stripped.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`no JSON array in response: ${text.slice(0, 200)}`);
  const items = JSON.parse(m[0]) as Array<{ description: string; quantity: number; unitPrice: number }>;
  if (Array.isArray(items) && items.length > 0) return items;
  throw new Error('empty result');
}

const DRY_RUN = process.argv.includes('--dry-run');

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

  // ── Find or create customer (skipped in dry-run) ─────────────────────────

  let customerId: string;
  let addressId: string;

  if (DRY_RUN) {
    customerId = 'dry-run';
    addressId  = 'dry-run';
  } else if (customerName) {
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

    // ── HD auto-pricing pass for unmatched materials ──────────────────────────
    await applyHdAutoPricing(matched, progress, DRY_RUN);
    // ─────────────────────────────────────────────────────────────────────────

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

  // ── Dry run: print confirmation card and stop ─────────────────────────────

  if (DRY_RUN) {
    const total = commitLineItems.reduce((sum, li) => sum + li.unitPrice * li.quantity, 0);
    const card = {
      dryRun: true,
      customer: customerName ?? '(unknown — would create placeholder)',
      lineItems: commitLineItems.map(li => ({
        name: li.name,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        total: +(li.unitPrice * li.quantity).toFixed(2),
        kind: li.kind,
        matched: !!li.serviceItemId,
        flagged: !li.serviceItemId,
      })),
      estimateTotal: +total.toFixed(2),
      deposit: total > 5000 ? +(total * 0.5).toFixed(2) : null,
      unmatched: commitLineItems.filter(li => !li.serviceItemId).map(li => li.name),
    };
    process.stdout.write(JSON.stringify(card, null, 2));
    return;
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
