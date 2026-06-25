import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { learnPricebookAlias } from '../../../rag/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../../data');
const RULES_PATH = path.join(DATA_DIR, 'mav-rules.md');
const ALIASES_PATH = path.join(DATA_DIR, 'pricebook-aliases.json');
const LEARNED_HEADING = '### Learned Rules';

export const saveRuleTool = createTool({
  id: 'save_rule',
  description:
    "Save a behavioral rule about how Carter talks and how it maps to pricebook line items. " +
    "Call when Carter corrects a bracket selection, corrects a decomposition, or states an explicit rule. " +
    "Announce the rule to Carter before saving so he can veto it.",
  inputSchema: z.object({
    rule: z.string().describe('The rule in 1-2 sentences'),
    category: z.enum(['selection', 'pairing', 'bundling', 'general']).describe(
      'selection=which item to pick, pairing=items that go together, bundling=what is included vs itemized, general=other'
    ),
    replaces: z.string().optional().describe(
      'Exact text of an existing learned rule this supersedes — omit to append a new one'
    ),
  }),
  execute: async ({ rule, category, replaces }) => {
    let content = await fs.readFile(RULES_PATH, 'utf-8').catch(
      () => `## Carter's Rules\n\n${LEARNED_HEADING}\n`
    );

    // Replace an existing rule in-place
    if (replaces && content.includes(replaces)) {
      content = content.replace(replaces, rule);
      await fs.writeFile(RULES_PATH, content, 'utf-8');
      return { saved: true, action: 'replaced', rule, category };
    }

    // Count current learned rules against the cap
    const learnedBlock = content.split(LEARNED_HEADING)[1] ?? '';
    const learnedCount = learnedBlock.split('\n').filter(l => l.startsWith('- ')).length;
    if (learnedCount >= 20) {
      return {
        saved: false,
        error: 'At 20-rule cap — use `replaces` to update an existing rule instead of appending.',
      };
    }

    // Prepend under the Learned Rules heading (newest first)
    if (content.includes(LEARNED_HEADING)) {
      content = content.replace(
        LEARNED_HEADING,
        `${LEARNED_HEADING}\n- **[${category}]** ${rule}`
      );
    } else {
      content += `\n\n${LEARNED_HEADING}\n- **[${category}]** ${rule}\n`;
    }

    await fs.writeFile(RULES_PATH, content, 'utf-8');
    return { saved: true, action: 'appended', rule, category, totalLearned: learnedCount + 1 };
  },
});

export const saveAliasTool = createTool({
  id: 'save_alias',
  description:
    "Attach Carter's natural language phrases to a pricebook item so future searches match his vocabulary. " +
    "Call after Carter confirms 'build it' — extract phrases he used to describe each item and attach them. " +
    "Announce before saving.",
  inputSchema: z.object({
    item_id: z.string().describe("Pricebook item UUID, e.g. 'olit_abc123'"),
    item_name: z.string().describe('Human-readable item name — for the confirmation message only'),
    phrases: z.array(z.string()).describe(
      "Carter's phrases to attach, e.g. ['Tesla', 'Level 2', '14-50R', 'EV charger in garage']"
    ),
  }),
  execute: async ({ item_id, item_name, phrases }) => {
    // 1. Merge into local JSON (source of truth)
    let aliases: Record<string, string[]> = {};
    try {
      aliases = JSON.parse(await fs.readFile(ALIASES_PATH, 'utf-8'));
    } catch { /* file doesn't exist yet */ }

    const existing = aliases[item_id] ?? [];
    const cleaned = phrases.map(p => p.toLowerCase().trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...cleaned])];
    aliases[item_id] = merged;
    await fs.writeFile(ALIASES_PATH, JSON.stringify(aliases, null, 2), 'utf-8');

    // 2. Sync to Qdrant (best-effort — if RAG is offline, sync-aliases script recovers)
    const ragResult = await learnPricebookAlias({ item_id, phrases: merged });

    return {
      saved: true,
      item_id,
      item_name,
      added: cleaned.length,
      total: merged.length,
      rag: ragResult,
    };
  },
});

export const memoryWriteTools = {
  save_rule: saveRuleTool,
  save_alias: saveAliasTool,
};
