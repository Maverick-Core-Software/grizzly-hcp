/**
 * Enrich the RAG pricebook index with natural language aliases.
 * For each service item, Claude Haiku generates phrases customers/dispatchers
 * actually use — "bad outlet", "breaker won't reset", etc. — then re-indexes
 * the item in RAG with the enriched description for better semantic search.
 *
 * Aliases are cached in data/pricebook-aliases.json so subsequent runs only
 * process new items. Pass --force to regenerate everything.
 *
 * Run:  npm run enrich-rag
 * After pricebook changes:  npm run push-pricebook && npm run enrich-rag
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { loadPriceBook } from '../rag/price-book.js';
import { indexPriceBookItem } from '../rag/client.js';
import { drainReindexPending } from './pricebook-bookkeeping.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIASES_PATH = path.resolve(__dirname, '../../data/pricebook-aliases.json');

const FORCE   = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH   = 5; // concurrent Haiku calls

const claude = new Anthropic();

async function generateAliases(name: string, category: string, description: string): Promise<string[]> {
  const msg = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 250,
    system: [
      'Generate 6-8 natural language phrases a homeowner, dispatcher, or customer would use to describe this electrical service.',
      'Mix casual and technical phrasing. Each phrase: 3-10 words.',
      'Return a JSON array of strings only. No explanation, no markdown.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: `Service: "${name}"\nCategory: "${category}"\nDescription: "${description.slice(0, 300)}"`,
      },
    ],
  });

  const text = ((msg.content[0] as { text: string }).text ?? '').trim();
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return (JSON.parse(m[0]) as unknown[]).filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

async function run() {
  console.log(`\nPricebook RAG Enrichment — ${DRY_RUN ? 'DRY RUN' : FORCE ? 'FORCE (regenerate all)' : 'incremental'}\n`);

  if (!DRY_RUN) {
    // Recover any items whose RAG index failed at creation time (RAG was down).
    const { drained, remaining } = await drainReindexPending();
    if (drained || remaining) {
      console.log(`Reindex queue: recovered ${drained}, ${remaining} still pending\n`);
    }
  }

  const catalog = await loadPriceBook();
  const services = catalog.filter(i => i.uuid.startsWith('olit_'));
  console.log(`Loaded ${services.length} service items`);

  let aliasMap: Record<string, string[]> = {};
  try {
    const raw = await fs.readFile(ALIASES_PATH, 'utf-8');
    aliasMap = JSON.parse(raw);
  } catch { /* first run — no cache yet */ }

  const toProcess = FORCE
    ? services
    : services.filter(i => !aliasMap[i.uuid]?.length);

  console.log(`To enrich: ${toProcess.length}  (${services.length - toProcess.length} already cached)\n`);

  if (DRY_RUN) {
    console.log('First 5 items that would be enriched:');
    for (const item of toProcess.slice(0, 5)) {
      console.log(`  ${item.name} (${item.category})`);
    }
    return;
  }

  for (let i = 0; i < toProcess.length; i += BATCH) {
    const batch = toProcess.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async item => {
        try {
          const aliases = await generateAliases(item.name, item.category, item.description);
          aliasMap[item.uuid] = aliases;

          const enrichedDesc = aliases.length
            ? `${item.description} | Customers may say: ${aliases.join('; ')}`
            : item.description;

          await indexPriceBookItem({
            uuid: item.uuid,
            name: item.name,
            description: enrichedDesc,
            price: item.price,
            category: item.category,
            unitOfMeasure: item.unitOfMeasure,
          });

          process.stdout.write(`  [ok] ${item.name}\n`);
          if (aliases.length) {
            process.stdout.write(`       ${aliases.slice(0, 3).join(' | ')}...\n`);
          }
        } catch (e) {
          process.stderr.write(`  [err] ${item.name}: ${e instanceof Error ? e.message : e}\n`);
        }
      })
    );

    // Persist after each batch — if interrupted, progress is not lost
    await fs.writeFile(ALIASES_PATH, JSON.stringify(aliasMap, null, 2), 'utf-8');
    const batchNum = Math.ceil((i + BATCH) / BATCH);
    const totalBatches = Math.ceil(toProcess.length / BATCH);
    process.stdout.write(`\n  [batch ${batchNum}/${totalBatches} saved]\n\n`);
  }

  const total = Object.keys(aliasMap).length;
  console.log(`Done. ${total} total items enriched in RAG.`);
  console.log(`Aliases cached at: data/pricebook-aliases.json`);
}

run().catch(e => { console.error(e); process.exit(1); });
