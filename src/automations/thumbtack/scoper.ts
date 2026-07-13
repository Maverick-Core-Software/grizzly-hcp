/**
 * Thumbtack Scoper — RAG-driven job scoping + price estimation.
 *
 * Takes a raw lead message (customer description of work needed), sends it
 * to the Maverick RAG for structured scoping questions and a rough price
 * range from the Grizzly price book.
 */

const RAG_URL = process.env.RAG_URL || "http://192.168.1.12:8181";

export interface ScopingResult {
  /** Natural-language scoping questions to ask the customer */
  questions: string[];
  /** Rough price range from price book matching */
  estimateRange: string;
  /** Specific services identified from the message */
  servicesIdentified: string[];
  /** Raw RAG response for debugging */
  raw: string;
}

export async function scopeLead(message: string): Promise<ScopingResult> {
  const res = await fetch(`${RAG_URL}/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: message,
      context: "Thumbtack lead — customer is requesting electrical work. Provide scoping questions and a rough price estimate from the Grizzly Electrical price book. Be conservative in estimates.",
    }),
  });

  if (!res.ok) {
    throw new Error(`RAG /estimate failed: ${res.status} ${res.statusText}`);
  }

  const raw = await res.text();

  // Parse the RAG response — it returns structured text with sections
  const questions = extractSection(raw, "Questions", "questions")
    .filter((q) => q.trim().length > 0);

  const estimateRange = extractSection(raw, "Estimate", "price")
    .join(" ")
    .trim();

  const servicesIdentified = extractSection(raw, "Services", "services")
    .filter((s) => s.trim().length > 0);

  return {
    questions: questions.length > 0 ? questions : ["Could you provide more details about the work needed?"],
    estimateRange: estimateRange || "Rough estimate unavailable — needs more details",
    servicesIdentified,
    raw,
  };
}

/**
 * Crude section extractor from RAG text output.
 * RAG returns markdown-like text with section headers.
 */
function extractSection(text: string, ...keywords: string[]): string[] {
  const lines = text.split("\n");
  const results: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (keywords.some((kw) => lower.includes(kw))) {
      inSection = true;
      continue;
    }
    if (inSection && line.trim().startsWith("#")) {
      inSection = false;
      continue;
    }
    if (inSection && line.trim()) {
      // Strip bullet points and numbers
      const cleaned = line.replace(/^[\s\-*\d.]*\s*/, "").trim();
      if (cleaned) results.push(cleaned);
    }
  }
  return results;
}
