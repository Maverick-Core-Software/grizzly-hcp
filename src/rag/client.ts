/**
 * Client for the Maverick RAG API running on Proxmox at 192.168.1.12:8181
 * Endpoints: /ask, /estimate (with history), /pi-docs (raw doc retrieval)
 */

const RAG_BASE = process.env.RAG_URL ?? 'http://192.168.1.12:8181';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface DocsResult {
  library: string;
  source: string;
  text: string;
  score: number;
}

export async function ragAsk(question: string, topK = 8): Promise<{ answer: string; sources: object[] }> {
  const res = await fetch(`${RAG_BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, top_k: topK }),
  });
  if (!res.ok) throw new Error(`RAG /ask failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function ragEstimate(
  message: string,
  history: Message[] = [],
  topK = 12
): Promise<{ reply: string; sources: object[] }> {
  const res = await fetch(`${RAG_BASE}/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, top_k: topK }),
  });
  if (!res.ok) throw new Error(`RAG /estimate failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function ragDocs(query: string, topK = 5): Promise<DocsResult[]> {
  const { answer, sources } = await ragAsk(query, topK);
  return (sources as Array<{ score: number; type: string; source: string; text: string }>).map(s => ({
    library: s.type ?? '',
    source: s.source ?? '',
    text: s.text ?? answer,
    score: s.score ?? 0,
  }));
}

export async function lookupCustomer(name: string): Promise<string> {
  const { answer } = await ragAsk(
    `Look up the customer named "${name}" in the Grizzly Electrical Solutions customer export. ` +
    `Return their full name, billing address, phone number, email, and any service addresses on file. ` +
    `If no match is found, say "NOT FOUND".`,
    5
  );
  return answer;
}

export async function lookupPricing(scope: string): Promise<string> {
  const { answer } = await ragAsk(
    `From the Grizzly price book and past proposals, what are typical pricing ranges for: ${scope}? ` +
    `Include labor, materials, and common line items. Be specific with dollar amounts when available.`,
    10
  );
  return answer;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${RAG_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface PriceBookMatch {
  uuid: string;
  name: string;
  description: string;
  price: number;
  category: string;
  unitOfMeasure: string;
  score: number;
}

export async function searchPriceBook(description: string, topK = 5): Promise<PriceBookMatch[]> {
  const res = await fetch(`${RAG_BASE}/pricebook/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: description, top_k: topK }),
  });
  if (!res.ok) throw new Error(`RAG /pricebook/search failed: ${res.status} ${await res.text()}`);
  const data: {
    results: Array<{
      uuid: string; name: string; description: string; price: number;
      category: string; unit_of_measure: string; score: number;
    }>;
  } = await res.json();
  return data.results.map(r => ({
    uuid: r.uuid,
    name: r.name,
    description: r.description,
    price: r.price,
    category: r.category,
    unitOfMeasure: r.unit_of_measure,
    score: r.score,
  }));
}

export async function indexPriceBookItem(item: {
  uuid: string;
  name: string;
  description?: string;
  price?: number;
  category?: string;
  unitOfMeasure?: string;
}): Promise<void> {
  const res = await fetch(`${RAG_BASE}/pricebook/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uuid: item.uuid,
      name: item.name,
      description: item.description ?? '',
      price: item.price ?? 0,
      category: item.category ?? 'Custom',
      unit_of_measure: item.unitOfMeasure ?? 'Each',
    }),
  });
  if (!res.ok) throw new Error(`RAG /pricebook/index failed: ${res.status} ${await res.text()}`);
}

export async function learnPricebookAlias(input: {
  item_id: string;
  phrases: string[];
}): Promise<{ success: boolean; item_name?: string; alias_count?: number; unchanged?: boolean; error?: string }> {
  try {
    const res = await fetch(`${RAG_BASE}/pricebook/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, error: `RAG ${res.status}: ${text}` };
    }
    return res.json() as Promise<{ success: boolean; item_name?: string; alias_count?: number; unchanged?: boolean }>;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
