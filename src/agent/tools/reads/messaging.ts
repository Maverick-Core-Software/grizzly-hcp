import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const checkThumbTackMessagesTool = createTool({
  id: 'check_thumbtack_messages',
  description: 'Check unread messages from Thumbtack leads. Returns lead name, message preview, and timestamp.',
  inputSchema: z.object({}),
  execute: async () => {
    // ponytail: Thumbtack API requires THUMBTACK_API_KEY + intercepted endpoints — stub until configured
    return {
      messages: [],
      note: 'Thumbtack API not yet configured. Use check_hcp_messages for HCP inbox.',
    };
  },
});

export const draftReplyTool = createTool({
  id: 'draft_reply',
  description:
    'Draft a professional reply to a customer message based on context. Returns draft text for Carter to review before sending. Does NOT send — use only for drafting.',
  inputSchema: z.object({
    customerName:    z.string().describe('Customer name'),
    originalMessage: z.string().describe('The message to reply to'),
    context:         z.string().optional().describe('Additional context: job scope, pricing, etc.'),
    tone:            z.enum(['professional', 'friendly', 'brief']).optional(),
  }),
  execute: async ({ customerName }) => {
    return {
      draft: `[The agent will compose a reply to ${customerName} inline based on conversation context]`,
      instructions: 'Review draft before sending. Use reply_to_customer workflow after approval.',
    };
  },
});

export const messagingReadTools = {
  check_thumbtack_messages: checkThumbTackMessagesTool,
  draft_reply:              draftReplyTool,
};
