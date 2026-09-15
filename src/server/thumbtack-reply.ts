import { createMaverickAgent } from '../agent/index.js';

export type ThumbtackHistoryItem = { role: 'customer' | 'business'; text: string };

export type ThumbtackReplyInput = {
  negotiationID?: string;
  customerName?: string;
  category?: string;
  text?: string;
  history?: ThumbtackHistoryItem[];
};

export type ThumbtackReplyResult = {
  success: boolean;
  reply?: string;
  error?: string;
};

type Generator = (prompt: string) => Promise<{ text?: string }>;

function transcript(input: ThumbtackReplyInput): string {
  const history = Array.isArray(input.history) ? input.history.slice(-20) : [];
  const lines = history
    .filter(item => item && typeof item.text === 'string' && item.text.trim())
    .map(item => `${item.role === 'customer' ? 'Customer' : 'Grizzly'}: ${item.text.trim()}`);
  const latest = String(input.text || '').trim();
  if (latest && !lines.some(line => line.endsWith(latest))) {
    lines.push(`Customer: ${latest}`);
  }
  return lines.join('\n');
}

export function createThumbtackReplyHandler(generate?: Generator) {
  let agent: ReturnType<typeof createMaverickAgent> | null = null;
  const run: Generator = generate || (async prompt => {
    agent ??= createMaverickAgent('thumbtack');
    return agent.generate(prompt);
  });

  return async function handleThumbtackReply(input: ThumbtackReplyInput): Promise<ThumbtackReplyResult> {
    const body = transcript(input);
    if (!body) return { success: false, error: 'Empty conversation.' };
    const name = String(input.customerName || 'the customer').trim() || 'the customer';
    const category = String(input.category || '').trim();
    const prompt = [
      `Thumbtack conversation with ${name}${category ? ` (${category})` : ''}:`,
      body,
      'Reply as Maverick on Thumbtack. One question at a time. Plain text only.',
    ].join('\n');
    try {
      const result = await run(prompt);
      const reply = typeof result?.text === 'string' ? result.text.trim() : '';
      if (!reply) return { success: false, error: 'Empty agent reply.' };
      return { success: true, reply };
    } catch {
      return { success: false, error: 'Agent unavailable.' };
    }
  };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const ip = String(address || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
