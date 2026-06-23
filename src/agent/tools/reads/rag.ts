import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { lookupCustomer, lookupPricing, ragDocs, searchPriceBook } from '../../../rag/client.js';

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
    const matches = await searchPriceBook(description, topK ?? 5);
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

export const ragReadTools = {
  lookup_customer:     lookupCustomerTool,
  search_pricebook:    searchPricebookTool,
  lookup_pricing:      lookupPricingTool,
  get_prior_estimates: getPriorEstimatesTool,
};
