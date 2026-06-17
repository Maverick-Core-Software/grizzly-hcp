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
  const res = await fetch(`${RAG_BASE}/pi-docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (!res.ok) throw new Error(`RAG /pi-docs failed: ${res.status} ${await res.text()}`);
  const data: { results: DocsResult[] } = await res.json();
  return data.results;
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
