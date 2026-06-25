# Mav Memory System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Maverick persistent memory so it learns how Carter talks and maps that vocabulary to correct HCP pricebook line items, improving automatically every session.

**Architecture:** Two mechanisms: (1) a compact rules file (`data/mav-rules.md`) loaded into the agent system prompt at startup, containing both pre-seeded electrical logic and rules learned via `save_rule`; (2) Carter's natural language phrases attached to Qdrant pricebook vectors via `save_alias`, so semantic search matches his vocabulary without growing the prompt. Both tools are wired into the Mastra agent as write tools Mav calls proactively.

**Tech Stack:** TypeScript/Mastra agent tools, Node.js `fs` for rules file I/O, existing `src/rag/client.ts` RAG client, Python FastAPI + Qdrant on Proxmox for the new `/pricebook/learn` endpoint.

---

## Spec

`docs/superpowers/specs/2026-06-25-mav-memory-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `data/mav-rules.md` | Pre-seeded rules; grows via `save_rule` |
| Create | `src/agent/tools/writes/memory.ts` | `save_rule` and `save_alias` Mastra tools |
| Create | `scripts/sync-aliases.ts` | One-time alias bootstrap into Qdrant |
| Modify | `src/agent/index.ts` | `loadMavRules()`, wire rules + write tools into agent |
| Modify | `src/rag/client.ts` | Add `learnPricebookAlias()` |
| Modify | `/opt/mav-rag/app.py` (Proxmox) | Add `POST /pricebook/learn` endpoint |
| Modify | `package.json` | Add `sync-aliases` script entry |

---

## Task 1: Pre-seeded rules file

This ships the core electrical logic as deterministic rules Mav follows from day one. No code — just content.

**Files:**
- Create: `data/mav-rules.md`

- [ ] **Step 1: Create `data/mav-rules.md`**

```markdown
## Carter's Rules

### Complexity Detection
When Carter describes a job with all required parameters (amperage, footage, routing method, end device), present the confirmation card immediately without entering planning mode. Only enter planning mode if key parameters are missing AND the job is non-trivial (e.g., 2-story no attic access, underground run, service entrance work).

### Footage Brackets — Circuit Items
Always pick the circuit line item whose footage range covers what Carter stated: 0–50 ft → flat-rate item (qty = 1), 51–150 ft → per-foot item (qty = stated footage), 151–250 ft → long-run per-foot item (qty = stated footage). Never pick a shorter-range bracket when footage exceeds its ceiling.

### Wire Gauge from Amperage
15A or 20A → #12 AWG. 30A → #10 AWG. 40A → #8 AWG. 50–60A → #6 AWG.

### Conduit Wire Type
Wire inside conduit (any location) → THHN, not Romex. Romex is not rated for conduit. Open attic with no conduit → Romex (NM-B) is acceptable in dry locations.

### Conductor Count in Conduit
A standard single circuit in conduit = 3 conductors: hot + neutral + ground. THHN wire material quantity = conduit footage × 3. Example: 30' of ½" PVC for a 20A circuit → THHN #12 at qty 90.

### Conduit Pairing
Every conduit run produces two line items: (1) install-labor item (conduit type + size, qty = footage) AND (2) material-conduit item (same type + size, qty = footage). Always paired, never one without the other.

### Device Inclusion in Circuit Items
"Drop a wall" / "drop an outlet" / "terminate at device" → outlet is included in the circuit line item; do NOT add a separate device item. "Dedicated GFCI" or "GFCI at the end" → add a separate GFCI device line item in addition to the circuit.

### Memory Tools — When to Save
Call save_rule when Carter corrects a bracket selection, corrects a decomposition ("that's one item not five"), or states an explicit rule. Call save_alias after Carter says "build it" and the estimate is confirmed: extract phrases Carter used to describe each confirmed item and attach them to that item's UUID. Always announce what you're about to save and give Carter the chance to say "don't save that" before writing.
```

- [ ] **Step 2: Verify file created**

```bash
type data\mav-rules.md
```

Expected: file contents display with all 8 rule sections.

- [ ] **Step 3: Commit**

```bash
git add data/mav-rules.md
git commit -m "feat: add pre-seeded mav-rules.md with electrical logic and memory tool instructions"
```

---

## Task 2: `loadMavRules()` wired into the agent

Loads `data/mav-rules.md` at startup and appends it to `BASE_INSTRUCTIONS`. Sync file read so `createMaverickAgent()` stays synchronous.

**Files:**
- Modify: `src/agent/index.ts`

- [ ] **Step 1: Add fs/path imports and `loadMavRules()` near the top of `src/agent/index.ts`**

Add after the existing `import` block (before `const BASE_INSTRUCTIONS`):

```typescript
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMavRules(): string {
  try {
    return fs.readFileSync(path.resolve(__dirname, '../../data/mav-rules.md'), 'utf-8');
  } catch {
    return '';
  }
}

const _mavRules = loadMavRules();
```

- [ ] **Step 2: Build `FULL_INSTRUCTIONS` after the `BASE_INSTRUCTIONS` const**

Add this immediately after the closing backtick of `BASE_INSTRUCTIONS`:

```typescript
const FULL_INSTRUCTIONS = _mavRules
  ? BASE_INSTRUCTIONS + '\n\n' + _mavRules
  : BASE_INSTRUCTIONS;
```

- [ ] **Step 3: Use `FULL_INSTRUCTIONS` in `createMaverickAgent()`**

In the `createMaverickAgent` function, change:
```typescript
instructions: resolveInstructions(channel, BASE_INSTRUCTIONS),
```
to:
```typescript
instructions: resolveInstructions(channel, FULL_INSTRUCTIONS),
```

- [ ] **Step 4: Smoke-check rules are loading**

```bash
npx tsx --input-type=module <<'EOF'
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(path.resolve(__dirname, 'data/mav-rules.md'), 'utf-8');
console.log(rules.includes('Footage Brackets') ? 'PASS: rules file readable' : 'FAIL: missing expected content');
EOF
```

Expected: `PASS: rules file readable`

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/index.ts
git commit -m "feat: load mav-rules.md into Maverick system prompt at startup"
```

---

## Task 3: `learnPricebookAlias()` in RAG client

New export in `src/rag/client.ts` that calls the (not-yet-built) `POST /pricebook/learn` endpoint. Returns gracefully if the RAG is offline — the local JSON write in `save_alias` already happened, so Qdrant sync can be retried later via `npm run sync-aliases`.

**Files:**
- Modify: `src/rag/client.ts`

- [ ] **Step 1: Add `learnPricebookAlias()` at the bottom of `src/rag/client.ts`**

```typescript
export async function learnPricebookAlias(input: {
  item_id: string;
  phrases: string[];
}): Promise<{ success: boolean; item_name?: string; alias_count?: number; unchanged?: boolean; error?: string }> {
  try {
    const res = await fetch(`${RAG_BASE}/pricebook/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, error: `RAG ${res.status}: ${text}` };
    }
    return res.json() as Promise<{ success: boolean; item_name?: string; alias_count?: number; unchanged?: boolean }>;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
```

Note: `RAG_BASE` is already defined at line 6 of `client.ts` as `process.env.RAG_URL ?? 'http://192.168.1.12:8181'`.

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/rag/client.ts
git commit -m "feat: add learnPricebookAlias() to RAG client for alias Qdrant sync"
```

---

## Task 4: `save_rule` and `save_alias` write tools

New Mastra tools that Mav calls to persist what it learns. `save_rule` appends to `data/mav-rules.md`. `save_alias` writes to `data/pricebook-aliases.json` and syncs to Qdrant. Both are wired into the agent alongside the existing read tools.

**Files:**
- Create: `src/agent/tools/writes/memory.ts`
- Modify: `src/agent/index.ts`

- [ ] **Step 1: Create `src/agent/tools/writes/memory.ts`**

```typescript
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
```

- [ ] **Step 2: Wire write tools into `src/agent/index.ts`**

Add import after the existing tool imports:
```typescript
import { memoryWriteTools } from './tools/writes/memory.js';
```

Replace `allReadTools` with `allTools` that includes write tools:
```typescript
const allTools = {
  ...ragReadTools,
  ...hcpReadTools,
  ...messagingReadTools,
  ...homeDepotTools,
  ...memoryWriteTools,
};
```

In `createMaverickAgent()`, change `resolveTools(channel, allReadTools)` to `resolveTools(channel, allTools)`.

Also remove the old `const allReadTools = { ... }` block (it's being replaced by `allTools`).

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools/writes/memory.ts src/agent/index.ts
git commit -m "feat: add save_rule and save_alias write tools to Maverick agent"
```

---

## Task 5: `POST /pricebook/learn` on Proxmox

Adds the endpoint to the FastAPI RAG server so `save_alias` can push aliases into Qdrant and trigger re-embedding.

**Files:**
- Modify: `/opt/mav-rag/app.py` on `root@192.168.1.12`

- [ ] **Step 1: Inspect the RAG server to understand its structure**

```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12 "cat /opt/mav-rag/app.py | grep -n 'pricebook\|qdrant\|embed\|client\|QdrantClient' | head -40"
```

Identify: (a) the Qdrant client variable name, (b) the embed function/call used in `/pricebook/index`, (c) what model/library generates embeddings.

- [ ] **Step 2: View the full `/pricebook/index` handler**

```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12 "grep -n -A 30 '@app.post.*pricebook/index' /opt/mav-rag/app.py"
```

This shows exactly how items are embedded and upserted. The new `/pricebook/learn` endpoint must use the same pattern.

- [ ] **Step 3: Add `POST /pricebook/learn` to `/opt/mav-rag/app.py`**

SSH in and append the endpoint after the `/pricebook/index` handler. Use the client variable name and embed function found in steps 1–2.

The template below uses placeholder names `qdrant_client` and `get_embedding` — replace with the actual names you found:

```python
class LearnAliasRequest(BaseModel):
    item_id: str
    phrases: list[str]

@app.post("/pricebook/learn")
async def learn_pricebook_alias(req: LearnAliasRequest):
    # Fetch existing point
    results = qdrant_client.retrieve(
        collection_name="pricebook",
        ids=[req.item_id],
        with_payload=True,
        with_vectors=False,
    )
    if not results:
        raise HTTPException(status_code=404, detail=f"item_id {req.item_id!r} not found in pricebook collection")

    payload = results[0].payload
    name = payload.get("name", "")
    description = payload.get("description", "")

    # Merge aliases, dedupe, preserve order
    existing = payload.get("carter_aliases", [])
    new_phrases = [p.lower().strip() for p in req.phrases if p.strip()]
    merged = list(dict.fromkeys(existing + new_phrases))

    if merged == existing:
        return {"success": True, "item_name": name, "alias_count": len(merged), "unchanged": True}

    # Re-embed with aliases appended to the text
    embed_text = f"{name} {description} {' '.join(merged)}"
    vector = get_embedding(embed_text)   # replace with actual embed call from /pricebook/index

    qdrant_client.upsert(
        collection_name="pricebook",
        points=[PointStruct(
            id=req.item_id,
            vector=vector,
            payload={**payload, "carter_aliases": merged},
        )],
    )

    return {"success": True, "item_name": name, "alias_count": len(merged)}
```

Add the import `from pydantic import BaseModel` at the top if it's not already imported (it almost certainly is).

- [ ] **Step 4: Restart the RAG server**

```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12 "systemctl restart mav-rag 2>/dev/null || pm2 restart mav-rag 2>/dev/null || supervisorctl restart mav-rag"
```

If none of those work, check what process manager is used:
```bash
ssh -i C:/Users/carte/.ssh/id_ed25519_proxmox root@192.168.1.12 "pm2 list 2>/dev/null; systemctl status mav-rag 2>/dev/null | head -5"
```

- [ ] **Step 5: Get a real pricebook item ID to test with**

```bash
curl -s http://192.168.1.12:8181/pricebook/search \
  -H "Content-Type: application/json" \
  -d '{"query":"EV charger install","top_k":1}'
```

Copy the `uuid` field from the response (should look like `olit_7fc3bc8c...`).

- [ ] **Step 6: Test the new endpoint**

```bash
curl -s http://192.168.1.12:8181/pricebook/learn \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"item_id":"<paste uuid here>","phrases":["mav-learn smoke test phrase xyz"]}'
```

Expected: `{"success": true, "item_name": "...", "alias_count": N}`

- [ ] **Step 7: Verify alias is now searchable**

```bash
curl -s http://192.168.1.12:8181/pricebook/search \
  -H "Content-Type: application/json" \
  -d '{"query":"mav-learn smoke test phrase xyz","top_k":1}'
```

Expected: the same item comes back in top results with a reasonable score (>0.5).

---

## Task 6: Bootstrap alias sync script

Syncs all ~100 existing entries in `data/pricebook-aliases.json` into Qdrant. Run once after Task 5 is deployed. Also useful as a recovery tool if the RAG server loses its alias data.

**Files:**
- Create: `scripts/sync-aliases.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/sync-aliases.ts`**

```typescript
import 'dotenv/config';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { learnPricebookAlias } from '../src/rag/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIASES_PATH = path.resolve(__dirname, '../data/pricebook-aliases.json');

async function main() {
  const raw = JSON.parse(await readFile(ALIASES_PATH, 'utf-8')) as Record<string, string[]>;
  const entries = Object.entries(raw).filter(([, phrases]) => phrases.length > 0);
  console.log(`Syncing ${entries.length} aliased items to Qdrant...`);

  let ok = 0, unchanged = 0, failed = 0;
  const missing: string[] = [];

  for (const [item_id, phrases] of entries) {
    const result = await learnPricebookAlias({ item_id, phrases });
    if (result.success) {
      if (result.unchanged) { unchanged++; }
      else { ok++; console.log(`  ✓ ${item_id}  ${result.item_name} (${result.alias_count} aliases)`); }
    } else if (result.error?.includes('404')) {
      missing.push(item_id);
      console.warn(`  ? ${item_id}  not found in Qdrant (stale ID)`);
    } else {
      failed++;
      console.error(`  ✗ ${item_id}  ${result.error}`);
    }
  }

  console.log(`\nDone: ${ok} updated, ${unchanged} unchanged, ${missing.length} stale IDs, ${failed} errors`);

  if (missing.length > 0) {
    console.log('\nStale IDs (no longer in pricebook):');
    missing.forEach(id => console.log('  ' + id));
    console.log('\nRemove these from data/pricebook-aliases.json manually.');
  }

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add script to `package.json`**

In the `"scripts"` section, add:
```json
"sync-aliases": "tsx scripts/sync-aliases.ts"
```

- [ ] **Step 3: Run the bootstrap sync**

Make sure the RAG server is healthy first:
```bash
curl -s http://192.168.1.12:8181/health
```

Then run:
```bash
npm run sync-aliases
```

Expected: lines like `✓ olit_7fc3bc8c...  EV Charger Install (Level 2) (6 aliases)` for each entry. Final line: `Done: X updated, Y unchanged, 0 stale IDs, 0 errors`.

If you see stale IDs (items removed from the pricebook), remove those keys from `data/pricebook-aliases.json` and commit the cleanup.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-aliases.ts package.json data/pricebook-aliases.json
git commit -m "feat: add sync-aliases script and run bootstrap sync of existing aliases into Qdrant"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|-----------------|------|
| `save_rule` tool | Task 4 ✓ |
| `save_alias` tool | Task 4 ✓ |
| `loadMavRules()` + wire into agent | Task 2 ✓ |
| `POST /pricebook/learn` on Proxmox | Task 5 ✓ |
| Alias sync bootstrap | Task 6 ✓ |
| Pre-seeded `mav-rules.md` | Task 1 ✓ |
| `learnPricebookAlias()` in `client.ts` | Task 3 ✓ |
| When-to-save instructions in system prompt | Task 1 (Memory Tools section in rules file) ✓ |
| Complexity detection + parametric rules in prompt | Task 1 (rules file sections) ✓ |
| 20-rule cap enforcement | Task 4 (save_rule execute) ✓ |
| Announce before writing, allow veto | Task 4 (tool description) + Task 1 (rules) ✓ |

**Path check — `DATA_DIR` in `memory.ts`:**
File lives at `src/agent/tools/writes/memory.ts`. `__dirname` = `<root>/src/agent/tools/writes`. `../../../../data` resolves as: `writes` → `tools` → `agent` → `src` → root → `data`. ✓

**Constant name check:** `learnPricebookAlias` calls `RAG_BASE` (line 6 of `client.ts`). Used as `` `${RAG_BASE}/pricebook/learn` ``. ✓

**Type consistency:** `learnPricebookAlias` defined in Task 3, imported and called in Task 4 (`memory.ts`) and Task 6 (`sync-aliases.ts`). Same signature throughout. ✓

**No placeholders:** Task 5 step 3 notes the Qdrant client variable and embed function names must be substituted based on what's found in steps 1–2. This is intentional — the names cannot be known without inspecting the live server. The instructions are explicit about what to look for and what to replace. Not a TBD.
