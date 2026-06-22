/**
 * Creates an HCP estimate from an email-watcher payload.
 * Called by: email-watcher via `npx tsx src/automations/estimates/from-email.ts`
 *
 * stdin:  JSON { from, subject, body, scope, attachmentContext? }
 * stdout: JSON { success: true, estimateUrl, estimateUuid }
 *         JSON { success: false, error }
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  searchCustomer,
  createCustomer,
  createEstimate,
  addLineItem,
  assignTechnician,
} from '../../hcp/estimates.js';
import { matchLineItems } from '../../rag/price-book.js';
import { buildLineItem } from '../../hcp/build-line-item.js';

// Emails from us — use body content for customer info instead of sender
const INTERNAL_EMAILS = new Set([
  'carterbarns@grizzlyelectrical.net',
  'jaime@grizzlyelectrical.net',
  'contactus@grizzlyelectrical.net',
]);

async function readStdin(): Promise<string> {
  let out = '';
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

function parseSender(from: string): { name: string; email: string } {
  const m = from.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { name: m[1].trim() || m[2].split('@')[0], email: m[2].trim() };
  const atIdx = from.indexOf('@');
  return { name: atIdx > 0 ? from.slice(0, atIdx) : from, email: from };
}

async function extractCustomerFromBody(body: string): Promise<{ name: string; email?: string; phone?: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'Extract the CUSTOMER\'s contact info from this field note written by an electrician. Return JSON only: {"name":"Full Name","email":"their email if present","phone":"their phone if present"}. Omit fields that are absent. name is required — use "Unknown" if truly missing.',
      messages: [{ role: 'user', content: body.slice(0, 2000) }],
    }),
  });
  if (!res.ok) throw new Error(`Haiku customer extract → ${res.status}`);
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : { name: 'Unknown' };
}

/**
 * Extract distinct billable work items from a job scope (or email body) as SHORT service names.
 * Produces 2-5 word names that match pricebook naming conventions for better semantic search.
 * The RAG-generated scope is far richer than a raw email body (often a 10+ item breakdown),
 * so token/char limits match from-chat.ts to avoid truncating it.
 */
async function extractServiceItems(text: string): Promise<Array<{ description: string; quantity: number; unitPrice: number }>> {
  try {
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
          'You are an electrical service dispatcher. Extract distinct electrical work items from this job scope or customer email.',
          'Write each as a SHORT service name (2-6 words) using the same naming style as an electrician\'s price book.',
          'Examples of good short service names:',
          '  "my GFCI stopped working" → "Replace GFCI Receptacle"',
          '  "add a switch and ceiling light where there is none" → "Add New Switch and Fixture"',
          '  "EV charger install in garage next to panel" → "EV Car Charger Install Next to Panel"',
          '  "panel upgrade to 200 amps" → "200A Panel Upgrade"',
          '  "ceiling fan install" → "Ceiling Fan Installation"',
          '  "outlet not working" → "Troubleshoot Level 1"',
          'Return JSON only — no prose: [{"description":"short name","quantity":1,"unitPrice":0}]',
          'One item per distinct task. If work involves both labor steps that are part of the same service, keep it as ONE item.',
        ].join('\n'),
        messages: [{ role: 'user', content: text.slice(0, 3000) }],
      }),
    });
    if (!res.ok) throw new Error(`Haiku extract → ${res.status}`);
    const data = await res.json();
    const responseText = (data.content?.[0]?.text || '').trim();
    const m = responseText.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('no JSON array');
    const items = JSON.parse(m[0]) as Array<{ description: string; quantity: number; unitPrice: number }>;
    if (Array.isArray(items) && items.length > 0) return items;
    throw new Error('empty result');
  } catch (e) {
    console.error(`[from-email] service extraction failed: ${e instanceof Error ? e.message : e}`);
    return [{ description: 'Electrical Service', quantity: 1, unitPrice: 0 }];
  }
}

/**
 * Choose the text to extract service items from. The RAG-generated `scope` is a detailed
 * multi-item breakdown and is strongly preferred; the raw email `body` is only a fallback
 * for when scope is empty/whitespace. Exported for the self-check below.
 */
export function pickExtractionSource(scope: string | undefined, body: string): string {
  return scope?.trim() ? scope : body;
}

async function run() {
  const payload = JSON.parse(await readStdin()) as {
    from: string;
    subject: string;
    body: string;
    scope: string;
  };

  const { from, subject, body, scope } = payload;
  const parsed = parseSender(from);

  let customerName: string;
  let customerEmail: string;
  let customerPhone: string | undefined;

  if (INTERNAL_EMAILS.has(parsed.email.toLowerCase())) {
    console.error(`[from-email] Internal sender (${parsed.email}) — extracting customer from body`);
    try {
      const extracted = await extractCustomerFromBody(body);
      customerName  = extracted.name;
      customerEmail = extracted.email || '';
      customerPhone = extracted.phone;
      console.error(`[from-email] Extracted customer: ${customerName} ${customerEmail}`);
    } catch (e) {
      console.error(`[from-email] Customer extraction failed: ${e instanceof Error ? e.message : e}`);
      customerName  = 'Unknown';
      customerEmail = '';
    }
  } else {
    customerName  = parsed.name;
    customerEmail = parsed.email;
  }

  // Find or create customer
  let customer = await searchCustomer(customerName);
  if (!customer && customerEmail) {
    customer = await searchCustomer(customerEmail.split('@')[0].replace(/[._-]/g, ' '));
  }
  if (!customer) {
    try {
      console.error(`[from-email] Customer "${customerName}" not found — creating...`);
      customer = await createCustomer({ name: customerName, email: customerEmail, phone: customerPhone });
      console.error(`[from-email] Created customer: ${customer.id}`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      process.stdout.write(JSON.stringify({ success: false, error: `Could not find or create customer "${customerName}": ${err}` }));
      return;
    }
  }

  // Create estimate
  const estimate = await createEstimate(customer.id, customer.addressId);

  // Extract work items as short pricebook-style service names. Prefer the RAG-generated
  // `scope` (a detailed multi-item breakdown) over the raw email `body`, falling back to
  // body only when scope is empty. Short names (2-5 words) match pricebook naming far
  // better than verbose customer descriptions. (Mirrors from-chat.ts, which uses scope.)
  const workItems = await extractServiceItems(pickExtractionSource(scope, body));
  console.error(`[from-email] Extracted ${workItems.length} service item(s): ${workItems.map(i => i.description).join(', ')}`);

  const matched = await matchLineItems(workItems);

  // Items with no price book match are added at $0 with a NEEDS-PRICING flag
  // (so the estimate stays complete) and reported back for manual pricing.
  // They are deliberately NOT written to the live HCP price book.
  const unmatched: string[] = [];

  for (let i = 0; i < matched.length; i++) {
    const m = matched[i];
    const { item, matched: didMatch } = buildLineItem(m, i);

    await addLineItem(estimate.uuid, item, i);

    const label = didMatch
      ? `PB ${Math.round(m.match!.score * 100)}%: "${m.match!.item.name}" @ $${m.match!.item.price}`
      : `no match: "${m.description}" @ $0 (needs manual pricing)`;
    console.error(`[from-email] Item ${i + 1}: ${label}`);

    if (!didMatch) unmatched.push(m.description);
  }

  if (unmatched.length) {
    console.error(`[from-email] ${unmatched.length} item(s) need manual pricing: ${unmatched.join(', ')}`);
  }

  // Assign techs
  const techId = process.env.CARTER_TECH_ID;
  if (techId) {
    try {
      const uuids = [techId, process.env.JAIME_TECH_ID].filter(Boolean) as string[];
      await assignTechnician(estimate.uuid, uuids);
    } catch (e) {
      console.error(`[from-email] assignment failed — ${e instanceof Error ? e.message : e}`);
    }
  }

  const estimateUrl = `https://pro.housecallpro.com/app/estimates/${estimate.uuid}`;
  process.stdout.write(JSON.stringify({ success: true, estimateUrl, estimateUuid: estimate.uuid, unmatched }));
}

// Only run the pipeline when executed directly (not when imported by the self-check).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(err => {
    process.stdout.write(JSON.stringify({ success: false, error: err.message }));
  });
}
