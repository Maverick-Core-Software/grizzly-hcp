/**
 * Creates an HCP estimate from an email-watcher payload.
 * Called by: email-watcher via `npx tsx src/automations/estimates/from-email.ts`
 *
 * stdin:  JSON { from, subject, body, scope, attachmentContext? }
 * stdout: JSON { success: true, estimateUrl, estimateUuid }
 *         JSON { success: false, error }
 */
import 'dotenv/config';
import {
  searchCustomer,
  createCustomer,
  createEstimate,
  addLineItem,
  assignTechnician,
  type HcpLineItem,
} from '../../hcp/estimates.js';
import { matchLineItems } from '../../rag/price-book.js';
import { createPriceBookItem } from '../../hcp/price-book.js';

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
 * Extract distinct billable work items from an email body as SHORT service names.
 * Produces 2-5 word names that match pricebook naming conventions for better semantic search.
 */
async function extractServiceItems(emailBody: string): Promise<Array<{ description: string; quantity: number; unitPrice: number }>> {
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
        max_tokens: 300,
        system: [
          'You are an electrical service dispatcher. Extract distinct electrical work items from this customer email.',
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
        messages: [{ role: 'user', content: emailBody.slice(0, 1500) }],
      }),
    });
    if (!res.ok) throw new Error(`Haiku extract → ${res.status}`);
    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('no JSON array');
    const items = JSON.parse(m[0]) as Array<{ description: string; quantity: number; unitPrice: number }>;
    if (Array.isArray(items) && items.length > 0) return items;
    throw new Error('empty result');
  } catch (e) {
    console.error(`[from-email] service extraction failed: ${e instanceof Error ? e.message : e}`);
    return [{ description: 'Electrical Service', quantity: 1, unitPrice: 0 }];
  }
}

function itemKind(description: string, category: string): HcpLineItem['kind'] {
  const d = description.toLowerCase();
  const c = category.toLowerCase();
  if (d.includes('discount') || c.includes('discount')) return 'fixed discount';
  if (c.includes('material') || d.includes('material') || d.includes('wire') ||
      d.includes('conduit') || d.includes('panel') || d.includes('breaker') ||
      d.includes('box') || d.includes('device') || d.includes('fixture')) {
    return 'materials';
  }
  return 'labor';
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

  // Extract work items from the email body as short pricebook-style service names.
  // Short names (2-5 words) match pricebook naming conventions far better than
  // verbose customer descriptions from parseProposal.
  const workItems = await extractServiceItems(body);
  console.error(`[from-email] Extracted ${workItems.length} service item(s): ${workItems.map(i => i.description).join(', ')}`);

  const matched = await matchLineItems(workItems);

  for (let i = 0; i < matched.length; i++) {
    const m = matched[i];
    const pb = m.match?.item;

    const item: HcpLineItem = {
      name:          pb?.name ?? m.description,
      description:   pb ? m.description : undefined,
      unitPrice:     (pb && pb.price > 0) ? pb.price : (m.unitPrice ?? 0),
      quantity:      m.quantity,
      kind:          itemKind(m.description, pb?.category ?? ''),
      taxable:       false,
      serviceItemId: pb?.uuid,
      orderIndex:    i,
    };

    await addLineItem(estimate.uuid, item, i);

    let label = pb
      ? `PB ${Math.round(m.match!.score * 100)}%: "${pb.name}" @ $${pb.price}`
      : `no match: "${m.description}" @ $0`;

    // Auto-save unmatched items to HCP pricebook + RAG so they appear next time
    if (!pb) {
      try {
        const saved = await createPriceBookItem({
          name:      m.description,
          unitPrice: 0,
          category:  itemKind(m.description, '') === 'materials' ? 'Materials' : 'Labor',
        });
        label += ` → saved to PB (${saved.uuid})`;
      } catch (e) {
        label += ` (PB save failed: ${e instanceof Error ? e.message.slice(0, 60) : e})`;
      }
    }

    console.error(`[from-email] Item ${i + 1}: ${label}`);
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
  process.stdout.write(JSON.stringify({ success: true, estimateUrl, estimateUuid: estimate.uuid }));
}

run().catch(err => {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
});
