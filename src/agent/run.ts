/**
 * Maverick Agent — stdio entry point.
 *
 * stdin:  JSON { prompt, history?, channel?, stream? }
 *   - stream: true → emit "data: <chunk>" lines + "[DONE] {...}\n" (opt-in)
 *   - stream: false/omitted → emit single JSON { success, response } (default, unchanged)
 *
 * stdout (non-stream): JSON { success: true, response: string }
 * stdout (stream):     "data: <chunk>\n" per token, then "[DONE] {...}\n"
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
    stream?: boolean;
  };

  const { prompt, history = [], channel = 'text', stream = false } = payload;

  if (!prompt?.trim()) {
    process.stdout.write(JSON.stringify({ success: false, error: 'No prompt provided.' }));
    return;
  }

  const agent = createMaverickAgent(channel);
  const turnId = randomUUID();
  const toolsUsed: string[] = [];

  const contextMessages = history
    .map(m => `${m.role === 'user' ? 'Carter' : 'Maverick'}: ${m.content}`)
    .join('\n');
  const fullPrompt = contextMessages ? `${contextMessages}\nCarter: ${prompt}` : prompt;

  progress('Maverick thinking...');

  try {
    if (stream) {
      // ponytail: textStream is ReadableStream<string> (Node 24+ supports for-await natively)
      // toolResults is Promise<ToolResultChunk[]> — awaited after iteration completes
      const streamResult = await agent.stream(fullPrompt);

      let fullText = '';
      for await (const chunk of streamResult.textStream) {
        process.stdout.write(`data: ${chunk}`);
        fullText += chunk;
      }

      // toolResults is a Promise — await it after the stream closes
      const toolResults = await streamResult.toolResults;
      const tools = Array.isArray(toolResults)
        ? toolResults.map(t => t.payload?.toolName).filter(Boolean)
        : [];
      toolsUsed.push(...tools);

      logAudit({
        turnId,
        userRequest: prompt.slice(0, 120),
        intent: '',
        modelUsed: 'reasoning',
        toolsInvoked: toolsUsed,
        workflowsTriggered: [],
        hcpIdsChanged: [],
        approvedBy: 'carter',
        result: 'success',
        sensitiveRefs: [],
      });

      if (tools.length) progress(`Used tools: ${tools.join(', ')}`);
      process.stdout.write(`\n[DONE] ${JSON.stringify({ success: true, toolsUsed })}\n`);
      process.exit(0);

    } else {
      // Non-streaming path — unchanged from original
      const result = await agent.generate(fullPrompt);
      const response = typeof result.text === 'string' ? result.text : JSON.stringify(result);

      if (result.toolResults?.length) {
        const tools = (result.toolResults as unknown as Array<{ toolName: string }>)
          .map(t => t.toolName).filter(Boolean);
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
    }
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

    if (stream) {
      process.stdout.write(`\n[ERROR] ${JSON.stringify({ success: false, error })}\n`);
    } else {
      process.stdout.write(JSON.stringify({ success: false, error }));
    }
    process.exit(1);
  }
}

run().catch(err => {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
