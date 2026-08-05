// One-shot, read-only Thumbtack conversation agent. MCC owns webhook delivery;
// this runner only returns a proposed reply on stdout.
import 'dotenv/config';
import { createMaverickAgent } from '../../agent/index.js';

type HistoryItem = { role: 'customer' | 'business'; text: string };
type Input = { customerName?: string; history: HistoryItem[] };

async function run(): Promise<void> {
  let input: Input;
  try { input = JSON.parse(await new Promise<string>(resolve => { let raw = ''; process.stdin.on('data', d => { raw += d; }); process.stdin.on('end', () => resolve(raw)); })); }
  catch { process.stdout.write(JSON.stringify({ success: false, error: 'Invalid input.' })); return; }

  const history = Array.isArray(input.history) ? input.history.slice(-20) : [];
  const transcript = history
    .filter(item => item && typeof item.text === 'string')
    .map(item => `${item.role === 'customer' ? 'Customer' : 'Grizzly'}: ${item.text}`)
    .join('\n');
  if (!transcript) { process.stdout.write(JSON.stringify({ success: false, error: 'Empty conversation.' })); return; }

  try {
    const agent = createMaverickAgent('thumbtack');
    const result = await agent.generate(`Thumbtack conversation with ${input.customerName || 'the customer'}:\n${transcript}`);
    const reply = typeof result.text === 'string' ? result.text.trim() : '';
    process.stdout.write(JSON.stringify(reply ? { success: true, reply } : { success: false, error: 'Empty agent reply.' }));
  } catch {
    process.stdout.write(JSON.stringify({ success: false, error: 'Agent unavailable.' }));
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/customer-reply.ts')) void run();
