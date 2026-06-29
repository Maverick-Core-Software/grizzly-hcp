# Maverick One Brain, Two Front Doors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCC dashboard ASK button run on the same Maverick brain as Slack/AGENT, specialized as a read-only `advisory` channel (RAG tools only, no live HCP), while preserving the ESTIMATE_READY scope→execute handoff.

**Architecture:** Add an `advisory` channel to grizzly's Mastra agent — a positive tool allow-list (RAG-only) plus an advisory instruction suffix — and add one general `search_knowledge` RAG tool so ASK can answer schedule/jobs/code questions from the indexed weekly snapshot. Then reroute MCC's `mode:'ask'` from its bespoke RAG-fetch path to `spawnMaverickAgent({channel:'advisory'})`, deleting the now-dead local estimate-extraction code. The frontend already detects `[ESTIMATE_READY]`, so no UI change is needed.

**Tech Stack:** TypeScript + Mastra (`@mastra/core`) in `grizzly-hcp`; plain Node ESM (`.mjs`) in `MCC`. Verification via standalone `tsx` assertion scripts (grizzly's existing convention — no test framework) and a live dashboard smoke test.

**Repos & branches:** Two repos. In `C:\Workspace\Active\grizzly-hcp` and `C:\Workspace\Active\MCC`, do NOT commit on `main` — create/checkout a working branch `feat/maverick-advisory-channel` in each before editing. Commit per-repo as tasks complete.

**Reference docs:** Spec at `grizzly-hcp/docs/superpowers/specs/2026-06-29-maverick-one-brain-two-doors-design.md`.

---

## File Structure

**grizzly-hcp (the brain):**
- `src/agent/tools/reads/rag.ts` — MODIFY: add `search_knowledge` tool + register in `ragReadTools`.
- `src/agent/resolver.ts` — MODIFY: add `'advisory'` to `Channel`, an `ADVISORY_INCLUDED` allow-list branch in `resolveTools`, and an `ADVISORY_SUFFIX` branch in `resolveInstructions`.
- `scripts/check-advisory-channel.ts` — CREATE: assertion script proving the advisory tool boundary + handoff.

**MCC (the dashboard front door):**
- `lib/chat.mjs` — MODIFY: reroute `mode==='ask'` text path to `spawnMaverickAgent({channel:'advisory'})` (keep the vision sub-branch); delete dead `handleEstimateFromAsk`, `handleEstimateEdit`, `buildEstimateSummary`; drop unused `ESTIMATE_EXTRACT_SYSTEM` / `ESTIMATE_EDIT_SYSTEM` imports.

---

## Task 1: Add the `search_knowledge` RAG tool

**Files:**
- Modify: `C:\Workspace\Active\grizzly-hcp\src\agent\tools\reads\rag.ts`

`search_knowledge` is the general RAG lookup ASK uses for schedule / open jobs / recent estimates / NEC-Oncor code — anything the entity-specific tools don't cover. It wraps `ragAsk` (which hits the same `/ask` endpoint the dashboard uses today, querying all collections) and returns the synthesized `answer` plus `sources`.

- [ ] **Step 1: Add `ragAsk` to the imports**

In `rag.ts`, change line 3 from:

```ts
import { lookupCustomer, lookupPricing, ragDocs, searchPriceBook } from '../../../rag/client.js';
```

to:

```ts
import { lookupCustomer, lookupPricing, ragAsk, ragDocs, searchPriceBook } from '../../../rag/client.js';
```

- [ ] **Step 2: Add the `searchKnowledgeTool` definition**

In `rag.ts`, immediately after the `getPriorEstimatesTool` definition (after its closing `});`, before `export const ragReadTools`), add:

```ts
export const searchKnowledgeTool = createTool({
  id: 'search_knowledge',
  description:
    'General knowledge search over the Maverick RAG (indexed weekly from HCP plus NEC/Oncor reference docs). ' +
    'Use this for questions the entity-specific tools do not cover: upcoming schedule, open jobs, recent ' +
    'estimates, NEC/Oncor/code questions, and general company knowledge. Returns a synthesized answer plus ' +
    'the source snippets it came from. Note: HCP data here is a weekly snapshot and may be up to a week stale.',
  inputSchema: z.object({
    query: z.string().describe('The question or topic to look up, e.g. "what jobs are scheduled this week?"'),
    topK: z.number().optional().describe('Number of source documents to retrieve (default 15)'),
  }),
  execute: async ({ query, topK }) => {
    const { answer, sources } = await ragAsk(query, topK ?? 15);
    return { answer, sources };
  },
});
```

- [ ] **Step 3: Register it in `ragReadTools`**

Change the `ragReadTools` export (currently lines 69-74) to include the new tool:

```ts
export const ragReadTools = {
  lookup_customer:     lookupCustomerTool,
  search_pricebook:    searchPricebookTool,
  lookup_pricing:      lookupPricingTool,
  get_prior_estimates: getPriorEstimatesTool,
  search_knowledge:    searchKnowledgeTool,
};
```

This auto-registers `search_knowledge` into `allTools` (index.ts spreads `...ragReadTools`), so it is available to AGENT (text/slack) immediately; Task 2 adds it to the advisory allow-list.

- [ ] **Step 4: Typecheck the file compiles**

Run: `cd "C:\Workspace\Active\grizzly-hcp" && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (no new errors referencing `rag.ts`). If the project has no `--noEmit` tsconfig path, run `npx tsc --noEmit` from the repo root.

- [ ] **Step 5: Commit**

```bash
cd "C:\Workspace\Active\grizzly-hcp"
git add src/agent/tools/reads/rag.ts
git commit -m "feat(agent): add search_knowledge general RAG tool"
```

---

## Task 2: Add the `advisory` channel to the resolver

**Files:**
- Modify: `C:\Workspace\Active\grizzly-hcp\src\agent\resolver.ts`
- Create: `C:\Workspace\Active\grizzly-hcp\scripts\check-advisory-channel.ts`

This is the safety-critical change: advisory MUST be structurally unable to touch live HCP. We enforce that with a positive allow-list (not an exclude list), so any future tool is locked out of advisory by default. We write the assertion check FIRST (it will fail), then implement until it passes.

- [ ] **Step 1: Write the failing check script**

Create `C:\Workspace\Active\grizzly-hcp\scripts\check-advisory-channel.ts`:

```ts
/**
 * Self-check: the advisory (ASK Maverick) channel must be RAG-only — it can never
 * touch live HCP or messaging tools, and must keep the ESTIMATE_READY handoff.
 * Run: npx tsx scripts/check-advisory-channel.ts
 */
import assert from 'node:assert';
import { ragReadTools } from '../src/agent/tools/reads/rag.js';
import { hcpReadTools } from '../src/agent/tools/reads/hcp.js';
import { messagingReadTools } from '../src/agent/tools/reads/messaging.js';
import { homeDepotTools } from '../src/agent/tools/reads/home-depot.js';
import { memoryWriteTools } from '../src/agent/tools/writes/memory.js';
import { resolveTools, resolveInstructions } from '../src/agent/resolver.js';

// The REAL tool registry (same composition as index.ts), so this check also
// proves search_knowledge is actually wired into ragReadTools.
const allTools = {
  ...ragReadTools,
  ...hcpReadTools,
  ...messagingReadTools,
  ...homeDepotTools,
  ...memoryWriteTools,
};

const advisoryNames = Object.keys(resolveTools('advisory', allTools));

const MUST_INCLUDE = [
  'lookup_customer', 'search_pricebook', 'lookup_pricing', 'get_prior_estimates',
  'search_knowledge', 'lookup_home_depot_price', 'save_rule', 'save_alias',
];
const MUST_EXCLUDE = [
  'check_hcp_messages', 'check_schedule', 'get_job', 'list_open_jobs',
  'get_customer_estimates', 'check_thumbtack_messages', 'draft_reply',
];

for (const t of MUST_INCLUDE) {
  assert.ok(advisoryNames.includes(t), `advisory MUST include RAG/read tool: ${t}`);
}
for (const t of MUST_EXCLUDE) {
  assert.ok(!advisoryNames.includes(t), `advisory must NOT include live-HCP/messaging tool: ${t}`);
}

const instr = resolveInstructions('advisory', 'BASE_INSTRUCTIONS_PLACEHOLDER');
assert.ok(instr.includes('ADVISORY mode'), 'advisory instructions must carry the advisory framing');
assert.ok(instr.includes('ESTIMATE_READY'), 'advisory instructions must preserve the ESTIMATE_READY handoff');
assert.ok(instr.includes('BASE_INSTRUCTIONS_PLACEHOLDER'), 'advisory instructions must build on the base prompt');

console.log(`advisory channel OK — ${advisoryNames.length} tools, RAG-only boundary + handoff verified`);
```

- [ ] **Step 2: Run the check to verify it fails**

Run: `cd "C:\Workspace\Active\grizzly-hcp" && npx tsx scripts/check-advisory-channel.ts`
Expected: FAIL — `resolveTools('advisory', …)` currently returns ALL tools (no advisory branch), so the `MUST_EXCLUDE` assertion throws (e.g. `advisory must NOT include live-HCP/messaging tool: check_schedule`).

- [ ] **Step 3: Add `'advisory'` to the `Channel` type**

In `resolver.ts`, change line 1:

```ts
export type Channel = 'text' | 'voice' | 'cli' | 'employee' | 'slack' | 'advisory';
```

- [ ] **Step 4: Add the `ADVISORY_INCLUDED` allow-list and `resolveTools` branch**

In `resolver.ts`, after the `EMPLOYEE_EXCLUDED` set (after its closing `]);` near line 10), add:

```ts
// Advisory = "Ask Maverick", the read-only chat companion. It MUST be structurally
// unable to touch live HCP, so it ALLOW-LISTS its tools (positive list) rather than
// excluding. Any future tool is locked out of advisory by default — add here to opt in.
const ADVISORY_INCLUDED = new Set([
  // RAG-backed reads (indexed weekly snapshot — no live HCP connection)
  'lookup_customer', 'search_pricebook', 'lookup_pricing', 'get_prior_estimates', 'search_knowledge',
  // read-only material pricing
  'lookup_home_depot_price',
  // Maverick's OWN memory (not HCP writes) — lets ASK capture a preference mid-chat
  'save_rule', 'save_alias',
]);
```

Then, inside `resolveTools`, before the final `return allTools;` (currently line 26), add:

```ts
  if (channel === 'advisory') {
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => ADVISORY_INCLUDED.has(name))
    ) as Partial<T>;
  }
```

- [ ] **Step 5: Add the `ADVISORY_SUFFIX` and `resolveInstructions` branch**

In `resolver.ts`, after the `SLACK_SUFFIX` definition (after its closing backtick + `;` near line 47), add:

```ts
const ADVISORY_SUFFIX = `

You are in ADVISORY mode — "Ask Maverick", a knowledgeable electrical-trade companion for Carter.

This is a chat and troubleshooting surface, NOT the action agent:
- Answer questions, troubleshoot on-site electrical problems, do conversions and load calcs, reason about NEC/Oncor and local code, and talk through job scope.
- You do NOT take action and you have NO live HCP connection or write tools. Your HCP knowledge — customers, pricebook, schedule, recent estimates — comes from an indexed weekly snapshot and may be up to a week stale. Say so when freshness matters.
- Unlike planning mode, you SHOULD use your lookup tools freely here. Call \`search_knowledge\` for schedule, open jobs, recent estimates, and code questions; use the other RAG tools for customer and pricing lookups. That is exactly what this surface is for.
- When you and Carter agree on a concrete job scope and he wants it built, emit the [ESTIMATE_READY]...[/ESTIMATE_READY] block exactly as specified in the base instructions. That hands the scope to the action agent — you propose, the agent executes.`;
```

Then change `resolveInstructions` (currently lines 69-75) to add the advisory branch before the final `return base;`:

```ts
export function resolveInstructions(channel: Channel, base: string): string {
  if (channel === 'voice') return base + VOICE_SUFFIX;
  if (channel === 'cli') return base + CLI_SUFFIX;
  if (channel === 'employee') return EMPLOYEE_INSTRUCTIONS;
  if (channel === 'slack') return base + SLACK_SUFFIX;
  if (channel === 'advisory') return base + ADVISORY_SUFFIX;
  return base;
}
```

- [ ] **Step 6: Run the check to verify it passes**

Run: `cd "C:\Workspace\Active\grizzly-hcp" && npx tsx scripts/check-advisory-channel.ts`
Expected: PASS — prints `advisory channel OK — 8 tools, RAG-only boundary + handoff verified`.

- [ ] **Step 7: Typecheck**

Run: `cd "C:\Workspace\Active\grizzly-hcp" && npx tsc --noEmit`
Expected: PASS — no new type errors. (The `Channel` union is now exhaustively handled in both resolver functions.)

- [ ] **Step 8: Commit**

```bash
cd "C:\Workspace\Active\grizzly-hcp"
git add src/agent/resolver.ts scripts/check-advisory-channel.ts
git commit -m "feat(agent): add advisory channel (RAG-only ASK brain) + boundary check"
```

---

## Task 3: Reroute MCC `mode:'ask'` to the advisory brain

**Files:**
- Modify: `C:\Workspace\Active\MCC\lib\chat.mjs`

Replace the bespoke RAG-fetch + Claude-fallback text path with the unified Maverick brain in advisory mode. Keep the vision sub-branch (the Maverick brain is text-only). Delete the dead extraction helpers. The frontend (`MCC/src/main.jsx`) already detects and re-posts `[ESTIMATE_READY]`, so the scope→execute handoff keeps working with no UI change.

- [ ] **Step 1: Replace the `mode === 'ask'` branch body**

In `chat.mjs`, replace the entire `if (mode === 'ask') { … }` block (currently lines 1098-1146, from `if (mode === 'ask') {` through its closing `}` before the `// REVIEW →` comment) with:

```js
    // ASK → Maverick advisory brain: same brain as AGENT, RAG-only tools, read-only.
    // It can propose scope via [ESTIMATE_READY]; the frontend re-posts that as estimate-ready.
    if (mode === 'ask') {
      // The Maverick brain is text-only, so image questions stay on the direct vision path.
      if (imageAttachments.length > 0) {
        await handleVisionQuery(res, controller, imageAttachments,
          prompt.trim() + (attachBlock ? '\n\n' + attachBlock : ''),
          histMsgs, CLAUDE_ESTIMATE_FALLBACK_SYSTEM);
        if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
        return;
      }

      await spawnMaverickAgent(
        { prompt: prompt.trim() + (attachBlock ? '\n\n' + attachBlock : ''), history: histMsgs, channel: 'advisory' },
        res, controller
      );
      if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
      return;
    }
```

- [ ] **Step 2: Delete the dead `buildEstimateSummary` function**

In `chat.mjs`, delete the entire `function buildEstimateSummary(extracted) { … }` definition (currently starting at line 788, through its closing `}` at line 821 — the function that returns `md`). It is referenced only by the two handlers deleted in the next step.

- [ ] **Step 3: Delete the dead `handleEstimateFromAsk` and `handleEstimateEdit` functions**

In `chat.mjs`, delete both function definitions in full:
- `async function handleEstimateFromAsk(histMsgs, prompt, res, controller) { … }` (currently lines 911-952)
- `async function handleEstimateEdit(pendingItems, pendingCustomer, editRequest, res, controller) { … }` (currently lines 954-990)

Both are dead code (no call sites anywhere in the repo). Leave `spawnEstimatePipeline` and `spawnMaverickAgent` untouched.

- [ ] **Step 4: Drop the now-unused prompt imports**

In `chat.mjs` line 18, change:

```js
import { CLAUDE_ASK_SYSTEM, CLAUDE_ESTIMATE_FALLBACK_SYSTEM, CLAUDE_OPS_SYSTEM, ESTIMATE_EXTRACT_SYSTEM, ESTIMATE_EDIT_SYSTEM } from './prompts.mjs';
```

to:

```js
import { CLAUDE_ASK_SYSTEM, CLAUDE_ESTIMATE_FALLBACK_SYSTEM, CLAUDE_OPS_SYSTEM } from './prompts.mjs';
```

(Keep `CLAUDE_ASK_SYSTEM` — it is still the default system fallback at the trailing generic path. Keep `CLAUDE_ESTIMATE_FALLBACK_SYSTEM` — still used by the vision sub-branch.)

- [ ] **Step 5: Verify the file parses and has no dangling references**

Run: `cd "C:\Workspace\Active\MCC" && node --check lib/chat.mjs`
Expected: PASS (no syntax error).

Run: `cd "C:\Workspace\Active\MCC" && grep -n "buildEstimateSummary\|handleEstimateFromAsk\|handleEstimateEdit\|ESTIMATE_EXTRACT_SYSTEM\|ESTIMATE_EDIT_SYSTEM" lib/chat.mjs`
Expected: NO output (every reference removed).

- [ ] **Step 6: Commit**

```bash
cd "C:\Workspace\Active\MCC"
git add lib/chat.mjs
git commit -m "feat(chat): route ASK to Maverick advisory brain; remove dead estimate-extraction path"
```

---

## Task 4: Verify the RAG corpus reaches schedule/jobs, then live smoke test

**Files:** none modified — verification only.

This task confirms the §5 data dependency (ASK can actually see schedule/jobs through `search_knowledge`) and that the end-to-end dashboard ASK flow works. If the snapshot does not contain jobs/schedule, REPORT it — fixing the export pipeline is a separate follow-up, not part of this plan.

- [ ] **Step 1: Confirm the RAG service is reachable**

Run: `cd "C:\Workspace\Active\grizzly-hcp" && npx tsx -e "import('./src/rag/client.js').then(async m => console.log('RAG healthy:', await m.checkHealth()))"`
Expected: `RAG healthy: true`. If `false`, the RAG service on `192.168.1.12:8181` is down — start it before continuing (out of scope to fix here; report and stop).

- [ ] **Step 2: Probe `search_knowledge` for schedule/jobs content**

Run:
```bash
cd "C:\Workspace\Active\grizzly-hcp" && npx tsx -e "import('./src/rag/client.js').then(async m => { const r = await m.ragAsk('What jobs or appointments are on the upcoming schedule?', 15); console.log('ANSWER:', r.answer?.slice(0,400)); console.log('SOURCE TYPES:', [...new Set((r.sources||[]).map(s => s.type))]); })"
```
Expected: a non-empty `ANSWER` and `SOURCE TYPES` that include a jobs/schedule-flavored collection. **If the answer says it has no schedule data or `SOURCE TYPES` shows only pricebook/customers** — record this verbatim in the final report as: "search_knowledge wired correctly, but the weekly RAG export does not yet index jobs/schedule — follow-up needed on export-jobs → Drive → watcher indexing." Do not attempt to fix it here.

- [ ] **Step 3: Restart the MCC dashboard process**

Run: `pm2 list`
Identify the PM2 process serving the MCC dashboard (the one whose script/cwd is `C:\Workspace\Active\MCC` — likely `mav-console`; confirm via `pm2 describe <name>` showing the MCC path). Then:

Run: `pm2 restart <mcc-dashboard-process>`
Expected: process restarts, status `online`. Confirm with `pm2 list`.

- [ ] **Step 2 fallback note:** if `pm2 describe` shows no process rooted at `C:\Workspace\Active\MCC`, the dashboard may be started another way — check `pm2 list` output and ask before guessing.

- [ ] **Step 4: Live smoke test — advisory answer with no write tools**

In the MCC dashboard UI, select the **ASK MAVERICK** button and send a pure-knowledge prompt, e.g. "What's the voltage drop on a 100ft run of 12 AWG copper at 16A, 120V?" plus "What's on my schedule this week?".
Expected: a streamed answer. The schedule question should pull from `search_knowledge` (watch grizzly/agent stderr `[progress]` or PM2 logs for the advisory brain spawning `tsx src/agent/run.ts`). No HCP write occurs.

- [ ] **Step 5: Live smoke test — scope → handoff**

In the same ASK session, talk through a small job and drive it to a spec ("read it back" → "build it"). When the brain emits `[ESTIMATE_READY]`, the dashboard should strip it, show the confirm bar, and on confirm re-post as `estimate-ready` → `spawnEstimatePipeline` creates the estimate in HCP (via the MCP write spine).
Expected: `✅ Estimate created!` with an HCP link. Use an obviously-fake throwaway customer name so the test estimate is easy to delete afterward.

- [ ] **Step 6: Final report**

Summarize: advisory boundary check result, `search_knowledge` corpus probe result (and any follow-up flagged), and both smoke tests. Note any throwaway test estimate created so Carter can delete it.

---

## Self-Review (completed by plan author)

- **Spec §3.1 advisory channel** → Task 2 (type + allow-list + instructions). ✅
- **Spec §3.2 search_knowledge** → Task 1. ✅
- **Spec §3.3 reroute ASK** → Task 3 Step 1. ✅
- **Spec §3.4 retire MCC-local ASK brain** → Task 3 Steps 2-4 (dead `handleEstimateFromAsk`/`handleEstimateEdit`/`buildEstimateSummary` + imports). ✅
- **Spec §5 data dependency (verify only)** → Task 4 Steps 1-2. ✅
- **Spec §6 testing** → Task 2 check script (boundary), Task 4 (corpus + e2e). ✅
- **Type consistency:** `search_knowledge` id/name used identically in rag.ts, the allow-list, and the check script. `Channel` union extended once and handled in both resolver functions. `channel:'advisory'` string matches across MCC call and grizzly resolver. ✅
- **Vision preserved** (Task 3 Step 1 keeps the image sub-branch) — not in the original spec but required to avoid regressing ASK image support. Noted explicitly.
