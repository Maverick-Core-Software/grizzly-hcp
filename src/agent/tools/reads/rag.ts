import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { lookupCustomer, lookupPricing, ragAsk, ragDocs, searchPriceBook } from '../../../rag/client.js';

export const lookupCustomerTool = createTool({
  id: 'lookup_customer',
  description:
    'Look up a customer in the Maverick RAG (indexed from HCP). Returns name, address, phone, email, and service history. Use before creating a new customer or building an estimate.',
  inputSchema: z.object({
    name: z.string().describe('Customer name to search for'),
  }),
  execute: async ({ name }) => {
    const result = await lookupCustomer(name);
    return { result };
  },
});

export const searchPricebookTool = createTool({
  id: 'search_pricebook',
  description:
    'Search the Grizzly price book for service items matching a description. Returns top matches with name, price, category, and match score. Use before building estimates or proposing new pricebook items.',
  inputSchema: z.object({
    description: z.string().describe('Short service name or description to search for, e.g. "200A Panel Upgrade"'),
    topK: z.number().optional().describe('Number of results to return (default 5)'),
  }),
  execute: async ({ description, topK }) => {
    const raw = await searchPriceBook(description, topK ?? 5);
    // Rename uuid → serviceItemId so agent knows what to put in ESTIMATE_READY
    const matches = raw.map(m => ({
      serviceItemId: m.uuid,
      name: m.name,
      description: m.description,
      price: m.price,
      category: m.category,
      unitOfMeasure: m.unitOfMeasure,
      score: m.score,
    }));
    return { matches };
  },
});

export const lookupPricingTool = createTool({
  id: 'lookup_pricing',
  description:
    'Look up typical pricing ranges for a scope of work from Grizzly price book and past proposals. More conversational than search_pricebook — use when you need a price estimate for something not in the book.',
  inputSchema: z.object({
    scope: z.string().describe('Describe the work, e.g. "200A panel upgrade with new breakers"'),
  }),
  execute: async ({ scope }) => {
    const result = await lookupPricing(scope);
    return { result };
  },
});

export const getPriorEstimatesTool = createTool({
  id: 'get_prior_estimates',
  description:
    'Search Maverick RAG for prior estimates and proposals for a customer or scope. Useful for understanding what was quoted before.',
  inputSchema: z.object({
    query: z.string().describe('Customer name, job type, or other search terms'),
    topK: z.number().optional().describe('Number of documents to return (default 5)'),
  }),
  execute: async ({ query, topK }) => {
    const docs = await ragDocs(query, topK ?? 5);
    return { docs };
  },
});

export const searchKnowledgeTool = createTool({
  id: 'search_knowledge',
  description:
    'General knowledge search over the Maverick RAG (indexed weekly from HCP plus NEC/Oncor reference docs). ' +
    'Use this for questions the entity-specific tools do not cover: upcoming schedule, open jobs, recent ' +
    'estimates, NEC/Oncor/code questions, and general company knowledge. Returns a synthesized answer plus ' +
    'the source snippets it came from. Note: HCP data here is a weekly snapshot and may be up to a week stale.',
  inputSchema: z.object({
    query: z.string().describe('The question or topic to look up, e.g. "what jobs are scheduled this week?"'),
    topK: z.number().optional().describe('Number of source documents to retrieve (default 15)'),
  }),
  execute: async ({ query, topK }) => {
    const { answer, sources } = await ragAsk(query, topK ?? 15);
    return { answer, sources };
  },
});

export const ragReadTools = {
  lookup_customer:     lookupCustomerTool,
  search_pricebook:    searchPricebookTool,
  lookup_pricing:      lookupPricingTool,
  get_prior_estimates: getPriorEstimatesTool,
  search_knowledge:    searchKnowledgeTool,
};
