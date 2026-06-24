import 'dotenv/config';
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';
import { createMaverickAgent } from '../../agent/index.js';

// Per-sender conversation history (resets on restart)
const histories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
const MAX_HISTORY = 20; // 10 exchanges

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

const agent = createMaverickAgent('text');
console.log('[imessage] Maverick iMessage listener ready');

for await (const [space, message] of app.messages) {
  if (message.direction !== 'inbound') continue;
  if (message.content.type !== 'text') continue;

  const prompt = (message.content as { type: 'text'; text: string }).text.trim();
  const senderId = message.sender?.id ?? 'unknown';
  if (!prompt) continue;

  const history = histories.get(senderId) ?? [];

  try {
    const contextLines = history
      .map(m => `${m.role === 'user' ? 'Carter' : 'Maverick'}: ${m.content}`)
      .join('\n');
    const fullPrompt = contextLines ? `${contextLines}\nCarter: ${prompt}` : prompt;

    const result = await agent.generate(fullPrompt);
    const response = typeof result.text === 'string' ? result.text : JSON.stringify(result);

    history.push({ role: 'user', content: prompt });
    history.push({ role: 'assistant', content: response });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    histories.set(senderId, history);

    await space.send(response);
    console.log(`[imessage] [${senderId}] replied (${response.length} chars)`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`[imessage] error for ${senderId}:`, err);
    await space.send('Sorry, something went wrong. Try again in a moment.');
  }
}
