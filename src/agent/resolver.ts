export type Channel = 'text' | 'voice' | 'cli' | 'employee' | 'slack' | 'advisory';

// Excluded from voice (not meaningful over phone)
const VOICE_EXCLUDED = new Set(['upload_photo', 'draft_reply']);

// Advisory is an allow-list (not an exclude-list) so any future tool added to the registry
// is locked OUT of the read-only advisory surface by default. Getting this wrong could let
// a future HCP write tool silently leak into the advisory channel.
const ADVISORY_INCLUDED = new Set([
  'lookup_customer',
  'search_pricebook',
  'lookup_pricing',
  'get_prior_estimates',
  'search_knowledge',
  'lookup_home_depot_price',
  'save_rule',
  'save_alias',
]);

// Employees get full read tools — pricing + estimates included, just no owner-level tools
// They cannot use build/superpowers/ops modes in the MCA frontend (blocked at server.mjs)
const EMPLOYEE_EXCLUDED = new Set([
  'check_thumbtack_messages', // owner inbox only
]);

export function resolveTools<T extends Record<string, unknown>>(
  channel: Channel,
  allTools: T
): Partial<T> {
  if (channel === 'advisory') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => ADVISORY_INCLUDED.has(name))
    ) as Partial<T>;
  }
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

const SLACK_SUFFIX = `

You are responding via Slack.

**Format rules:**
- Use Slack markdown: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`.
- Keep responses concise — Carter is reading on desktop or phone. Bullet points are fine.
- Ask ONE question per message. Get the most important thing first.
- State assumptions in one short phrase ("assuming attic routing") — don't ask about them.
- For estimates: keep the spec compact, one line per item.
- If a job is simple, move through planning in 1-2 exchanges and get to the spec.`;

const ADVISORY_SUFFIX = `

You are in advisory mode — a read-only electrical trade companion for the dashboard.

## What you can do
- Answer NEC/code questions, troubleshoot electrical problems, do unit and load conversions, and help scope jobs.
- Look up customers, prior estimates, and pricebook pricing from the RAG index (weekly HCP snapshots).
- Save rules and pricebook aliases to Maverick's own memory when Carter confirms a correction.

## What you cannot do
- You have no live HCP tools. All HCP knowledge comes from indexed weekly snapshots and may be up to a week stale — say so when recency matters (e.g. current schedule, recent messages).
- You do not take action: no scheduling, no messaging, no estimate submission.

## Handing off to Build mode
When you and Carter agree on a concrete job scope, emit the \`[ESTIMATE_READY]…[/ESTIMATE_READY]\` block exactly as specified in the base instructions so the dashboard can hand it to the execution agent.`;

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
  if (channel === 'advisory') return base + ADVISORY_SUFFIX;
  if (channel === 'voice') return base + VOICE_SUFFIX;
  if (channel === 'cli') return base + CLI_SUFFIX;
  if (channel === 'employee') return EMPLOYEE_INSTRUCTIONS;
  if (channel === 'slack') return base + SLACK_SUFFIX;
  return base;
}
