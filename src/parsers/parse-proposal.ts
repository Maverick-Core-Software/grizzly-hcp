import Anthropic from '@anthropic-ai/sdk';
import type { ProposalData } from '../types.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a data extraction assistant for an electrical contracting company.
Extract structured estimate/proposal data from the provided document text.
Return ONLY valid JSON matching the schema — no markdown, no explanation.`;

const SCHEMA_DESCRIPTION = `{
  "customer": {
    "name": "string",
    "phone": "string or null",
    "email": "string or null",
    "address": "string (street only)",
    "city": "string or null",
    "state": "string or null",
    "zip": "string or null"
  },
  "jobType": "string or null — e.g. Panel Upgrade, Service Call, Rough-In, EV Charger Install",
  "tags": ["array of relevant tags"],
  "scopeOfWork": "string — full description/scope of the electrical work",
  "lineItems": [
    {
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "unit": "string or null — each, hr, ft, etc."
    }
  ],
  "estimateNumber": "string or null",
  "validUntil": "ISO date string or null"
}`;

export async function parseProposal(rawText: string): Promise<ProposalData> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Extract the estimate data from this proposal document and return JSON matching this schema:\n${SCHEMA_DESCRIPTION}\n\nDOCUMENT:\n${rawText}`,
      },
    ],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '';

  try {
    return JSON.parse(text) as ProposalData;
  } catch {
    // Try to pull JSON out if there's surrounding text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as ProposalData;
    throw new Error(`Failed to parse Claude response as JSON:\n${text}`);
  }
}
