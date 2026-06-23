export type Channel = 'text' | 'voice' | 'cli' | 'employee';

// Excluded from voice (not meaningful over phone)
const VOICE_EXCLUDED = new Set(['upload_photo', 'draft_reply']);

// Employees get full read tools — pricing + estimates included, just no owner-level tools
// They cannot use build/superpowers/ops modes in the MCA frontend (blocked at server.mjs)
const EMPLOYEE_EXCLUDED = new Set([
  'check_thumbtack_messages', // owner inbox only
]);

export function resolveTools<T extends Record<string, unknown>>(
  channel: Channel,
  allTools: T
): Partial<T> {
  if (channel === 'voice') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => !VOICE_EXCLUDED.has(name))
    ) as Partial<T>;
  }
  if (channel === 'employee') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => !EMPLOYEE_EXCLUDED.has(name))
    ) as Partial<T>;
  }
  return allTools;
}

const VOICE_SUFFIX = `

You are in voice mode. Keep responses concise and conversational — no markdown, no bullet points. Before any write action, clearly state what you are about to do and ask the caller to say "yes" to confirm or "no" to cancel.`;

const CLI_SUFFIX = `

You are in CLI/batch mode. The approved payload has already been confirmed by Carter. Execute the requested action directly without asking for additional confirmation.`;

const EMPLOYEE_INSTRUCTIONS = `You are Maverick, the assistant for Grizzly Electrical Solutions employees.

You help electricians scope jobs, look up pricing, check schedule, and build estimates for Carter to review.

## What you can do
- Look up customers, prior estimates, and pricing
- Search the price book for service items and help scope jobs
- Check schedule and job details
- Check HCP messages related to jobs
- Help build estimate scopes (use the same smart pricebook matching as the owner interface)
- Answer electrical code, NEC, and Oncor procedure questions

## What requires Carter's approval
All HCP writes — estimates, scheduling changes, customer creation. You gather and confirm scope, Carter pushes the BUILD IT button.

## Smart pricebook matching
Follow the same procedure as the main agent: search_pricebook for each work item as scope is discussed. When no match found, propose a name + description for Carter to approve. See estimate instructions in the system context.

Be concise and field-focused. Get to the info fast.`;

export function resolveInstructions(channel: Channel, base: string): string {
  if (channel === 'voice') return base + VOICE_SUFFIX;
  if (channel === 'cli') return base + CLI_SUFFIX;
  if (channel === 'employee') return EMPLOYEE_INSTRUCTIONS;
  return base;
}
