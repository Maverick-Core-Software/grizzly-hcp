/**
 * Maverick Agent — stdio entry point for MCC chat.mjs.
 *
 * stdin:  JSON { prompt, history?, channel? }
 *   - prompt:  string
 *   - history: Array<{ role: 'user' | 'assistant', content: string }>
 *   - channel: 'text' | 'voice' | 'cli' (default: 'text')
 *
 * stdout: JSON { success: true, response: string }
 *         JSON { success: false, error: string }
 * stderr: [progress] <message> lines
 */
import 'dotenv/config';
import { createMaverickAgent } from './index.js';
import { logAudit } from './audit-log.js';
import { randomUUID } from 'crypto';
import type { Channel } from './resolver.js';

function progress(msg: string) {
  process.stderr.write(`[progress] ${msg}\n`);
}

async function readStdin(): Promise<string> {
  let out = '';
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

async function run() {
  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    prompt: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    channel?: Channel;
  };

  const { prompt, history = [], channel = 'text' } = payload;

  if (!prompt?.trim()) {
    process.stdout.write(JSON.stringify({ success: false, error: 'No prompt provided.' }));
    return;
  }

  const agent = createMaverickAgent(channel);
  const turnId = randomUUID();
  const toolsUsed: string[] = [];

  progress('Maverick thinking...');

  try {
    // Build messages: history + current prompt as plain strings the agent can handle.
    // Mastra agent.generate accepts a single string for the current turn; prior history
    // is passed as context. For voice/CLI the history is short so this is fine for Phase 1.
    const contextMessages = history.map(m => `${m.role === 'user' ? 'Carter' : 'Maverick'}: ${m.content}`).join('\n');
    const fullPrompt = contextMessages ? `${contextMessages}\nCarter: ${prompt}` : prompt;

    const result = await agent.generate(fullPrompt);

    const response = typeof result.text === 'string' ? result.text : JSON.stringify(result);

    // Log any tool uses from the response
    if (result.toolResults?.length) {
      const tools = (result.toolResults as unknown as Array<{ toolName: string }>)
        .map(t => t.toolName)
        .filter(Boolean);
      toolsUsed.push(...tools);
      if (tools.length) progress(`Used tools: ${tools.join(', ')}`);
    }

    logAudit({
      turnId,
      userRequest: prompt.slice(0, 120),
      ...(process.env.AUDIT_LOG_RESPONSES === 'true' ? { maverickResponse: response } : {}),
      intent: '',
      modelUsed: 'reasoning',
      toolsInvoked: toolsUsed,
      workflowsTriggered: [],
      hcpIdsChanged: [],
      approvedBy: 'carter',
      result: 'success',
      sensitiveRefs: [],
    });

    progress('Done.');
    process.stdout.write(JSON.stringify({ success: true, response }), () => process.exit(0));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logAudit({
      turnId,
      userRequest: prompt.slice(0, 120),
      intent: '',
      modelUsed: 'reasoning',
      toolsInvoked: toolsUsed,
      workflowsTriggered: [],
      hcpIdsChanged: [],
      approvedBy: 'carter',
      result: `error: ${error}`,
      sensitiveRefs: [],
    });
    process.stdout.write(JSON.stringify({ success: false, error }), () => process.exit(1));
  }
}

run().catch(err => {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }), () => process.exit(1));
});
