# Pricebook Candidate Miner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI script that mines historical HCP job line items for custom (non-pricebook) items used on 2+ jobs and adds them to the pricebook after an interactive review.

**Architecture:** Single script `mine-pricebook-candidates.ts` — fetches all jobs + line items, aggregates custom items by normalized name, deduplicates against the live pricebook and a `promoted-items.json` state file, prints a ranked table, adds all on `y`. Pure utility functions (`normalize`, `modalValue`, `aggregateCandidates`) are exported so the `.check.ts` self-check can import and test them without network calls.

**Tech Stack:** TypeScript/tsx, `node:assert/strict` (self-check), `node:readline/promises` (interactive prompt), existing `hcpGet` / `listAllServices` / `createPriceBookItem` from `src/hcp/`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/hcp/mine-pricebook-candidates.ts` | Main script — all logic |
| Create | `src/hcp/mine-pricebook-candidates.check.ts` | Self-check for pure functions |
| Modify | `package.json` | Add `mine-pricebook` script |

---

### Task 1: Write the check file first (failing)

**Files:**
- Create: `src/hcp/mine-pricebook-candidates.check.ts`

- [ ] **Step 1: Create the check file**

```typescript
/**
 * Self-check for pure utilities in mine-pricebook-candidates.
 * No framework — run with: npx tsx src/hcp/mine-pricebook-candidates.check.ts
 */
import assert from 'node:assert/strict';
import { normalize, modalValue, aggregateCandidates } from './mine-pricebook-candidates.js';

// ── normalize ──────────────────────────────────────────────────────────────
assert.equal(normalize('Ground Rod Installation'), 'ground rod installation');
assert.equal(normalize('Outlet - 20A (GFCI)'), 'outlet 20a gfci');
assert.equal(normalize('  Panel   Upgrade  '), 'panel upgrade');

// ── modalValue ─────────────────────────────────────────────────────────────
assert.equal(modalValue([100, 200, 100, 300]), 100, '100 appears twice — wins');
assert.equal(modalValue([200, 100]), 100, 'tie → lowest value wins');
assert.equal(modalValue([150]), 150, 'single element');

// ── aggregateCandidates ────────────────────────────────────────────────────
const jobs = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }];
const lineItemsByJob = new Map([
  ['j1', [
    { name: 'Ground Rod', unit_price: 18500, kind: 'labor', service_item_id: null },
    { name: 'Ground Rod', unit_price: 18500, kind: 'labor', service_item_id: null }, // duplicate in same job
  ]],
  ['j2', [
    { name: 'Ground Rod', unit_price: 20000, kind: 'labor', service_item_id: null },
    { name: 'Panel Upgrade', unit_price: 150000, kind: 'labor', service_item_id: 'olit_existing' }, // pricebook item — skip
  ]],
  ['j3', [
    { name: 'Ground Rod', unit_price: 18500, kind: 'labor', service_item_id: null },
  ]],
]);

const agg = aggregateCandidates(jobs, lineItemsByJob);

const gr = agg.get('ground rod');
assert.ok(gr, 'Ground Rod should be aggregated');
assert.equal(gr.uses, 3, '3 distinct jobs — duplicate within j1 does not count twice');
assert.deepEqual(gr.prices, [18500, 20000, 18500], 'prices collected from each job occurrence');

assert.ok(!agg.has('panel upgrade'), 'pricebook-linked items (service_item_id set) must be skipped');

console.log('✓ mine-pricebook-candidates self-check passed');
```

- [ ] **Step 2: Run the check — expect a module-not-found error (confirms it's wired correctly)**

```
npx tsx src/hcp/mine-pricebook-candidates.check.ts
```

Expected: Error like `Cannot find module './mine-pricebook-candidates.js'` — correct, the implementation doesn't exist yet.

---

### Task 2: Pure utility functions + types (make the check pass up to `aggregateCandidates`)

**Files:**
- Create: `src/hcp/mine-pricebook-candidates.ts` (initial skeleton — utilities only)

- [ ] **Step 1: Create the script with the exported pure functions**

```typescript
/**
 * Mine historical HCP job line items for pricebook candidates.
 * Custom items (service_item_id null) used on 2+ distinct jobs that aren't
 * already in the pricebook or previously promoted are surfaced for review.
 *
 * Run: npm run mine-pricebook
 * State: data/promoted-items.json tracks already-promoted items so re-runs skip them.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { hcpGet } from './client.js';
import { listAllServices, createPriceBookItem } from './price-book.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '../../data/promoted-items.json');
const CONCURRENCY = 5;
const MIN_USES = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export interface RawLineItem {
  name: string;
  unit_price: number;        // cents
  kind: string;
  service_item_id?: string | null;
}

export interface Candidate {
  displayName: string;
  uses: number;
  modalPrice: number;        // dollars
  kind: string;
}

interface StateFile {
  promoted: Array<{ name: string; uuid: string; addedAt: string }>;
}

// ── Pure utilities (exported for check file) ───────────────────────────────

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function modalValue(arr: number[]): number {
  const counts = new Map<number, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = arr[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v < best)) { best = v; bestCount = c; }
  }
  return best;
}

export function aggregateCandidates(
  jobs: Array<{ id: string }>,
  lineItemsByJob: Map<string, RawLineItem[]>,
): Map<string, { displayName: string; uses: number; prices: number[]; kinds: string[] }> {
  const agg = new Map<string, { displayName: string; uses: number; prices: number[]; kinds: string[] }>();

  for (const job of jobs) {
    const items = lineItemsByJob.get(job.id) ?? [];
    const seenThisJob = new Set<string>();

    for (const item of items) {
      if (!item.name?.trim()) continue;
      if (item.service_item_id) continue;          // already a pricebook item
      const key = normalize(item.name);
      if (seenThisJob.has(key)) continue;           // deduplicate within this job
      seenThisJob.add(key);

      const existing = agg.get(key) ?? { displayName: item.name, uses: 0, prices: [], kinds: [] };
      existing.uses++;
      if (item.unit_price > 0) existing.prices.push(item.unit_price);
      if (item.kind) existing.kinds.push(item.kind);
      agg.set(key, existing);
    }
  }

  return agg;
}

// ── Placeholder main (will be replaced in Task 4) ─────────────────────────

async function run() {
  throw new Error('Not implemented yet');
}

run().catch(err => { console.error(err.message); process.exit(1); });
```

- [ ] **Step 2: Run the check — expect all assertions to pass**

```
npx tsx src/hcp/mine-pricebook-candidates.check.ts
```

Expected output:
```
✓ mine-pricebook-candidates self-check passed
```

- [ ] **Step 3: Commit**

```
git add src/hcp/mine-pricebook-candidates.ts src/hcp/mine-pricebook-candidates.check.ts
git commit -m "feat(pricebook): add mine-pricebook-candidates utilities + self-check"
```

---

### Task 3: Data loading — pricebook names, state file, HCP fetching

**Files:**
- Modify: `src/hcp/mine-pricebook-candidates.ts` — add `loadPricebookNames`, `loadStateNames`, `appendToState`, `fetchAllJobs`, `fetchLineItems`, `pMap`

- [ ] **Step 1: Add data loading functions**

Replace the placeholder `run()` stub (and everything after the pure utilities) with these functions. Keep all the `import` statements and everything above `// ── Placeholder main` from Task 2 — only replace the placeholder section:

```typescript
// ── State file ─────────────────────────────────────────────────────────────

async function loadPricebookNames(): Promise<Set<string>> {
  const services = await listAllServices();
  return new Set(services.map(s => normalize(s.name)));
}

async function loadStateNames(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf-8');
    const state: StateFile = JSON.parse(raw);
    return new Set((state.promoted ?? []).map(p => normalize(p.name)));
  } catch {
    return new Set();   // file doesn't exist yet on first run
  }
}

async function appendToState(items: Array<{ name: string; uuid: string }>): Promise<void> {
  let state: StateFile = { promoted: [] };
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf-8');
    state = JSON.parse(raw);
  } catch { /* new file */ }

  const today = new Date().toISOString().slice(0, 10);
  state.promoted.push(...items.map(i => ({ name: i.name, uuid: i.uuid, addedAt: today })));
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

// ── HCP fetching ───────────────────────────────────────────────────────────

interface HcpJob { id: string; invoice_number: string; }

async function fetchAllJobs(): Promise<HcpJob[]> {
  const all: HcpJob[] = [];
  let page = 1;
  while (true) {
    const res = await hcpGet<{ data: { data: HcpJob[] }; total_page_count: number }>(
      `/alpha/jobs?page=${page}&page_size=100`,
    );
    const batch = res.data?.data ?? [];
    all.push(...batch);
    process.stdout.write(`\r  Fetched ${all.length} jobs (page ${page}/${res.total_page_count})`);
    if (page >= res.total_page_count) break;
    page++;
  }
  console.log();
  return all;
}

async function fetchLineItems(jobId: string): Promise<RawLineItem[]> {
  try {
    const res = await hcpGet<Record<string, unknown>>(`/alpha/jobs/${jobId}/line_items`);
    const items = (res['line_items'] ?? res['data'] ?? []) as RawLineItem[];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

// ponytail: 5-concurrent limit matches known HCP rate tolerance (see sync-estimates.ts)
async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Placeholder main (will be replaced in Task 4) ─────────────────────────

async function run() {
  throw new Error('Not implemented yet');
}

run().catch(err => { console.error(err.message); process.exit(1); });
```

- [ ] **Step 2: Verify the check still passes**

```
npx tsx src/hcp/mine-pricebook-candidates.check.ts
```

Expected: `✓ mine-pricebook-candidates self-check passed`

- [ ] **Step 3: Commit**

```
git add src/hcp/mine-pricebook-candidates.ts
git commit -m "feat(pricebook): add pricebook/state loading + HCP fetching"
```

---

### Task 4: Candidate filtering, table printing, interactive prompt, pricebook write

**Files:**
- Modify: `src/hcp/mine-pricebook-candidates.ts` — replace placeholder `run()` with the real implementation

- [ ] **Step 1: Replace the placeholder `run()` stub with the complete implementation**

Replace everything from `// ── Placeholder main` to the end of the file with:

```typescript
// ── Filtering + presentation ────────────────────────────────────────────────

function buildCandidates(
  agg: Map<string, { displayName: string; uses: number; prices: number[]; kinds: string[] }>,
  pricebookNames: Set<string>,
  stateNames: Set<string>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const [key, data] of agg) {
    if (data.uses < MIN_USES) continue;
    if (pricebookNames.has(key)) continue;
    if (stateNames.has(key)) continue;

    const modalPrice = data.prices.length > 0 ? modalValue(data.prices) / 100 : 0;

    // Modal kind: most common; ties → 'labor'
    const kindCounts = new Map<string, number>();
    for (const k of data.kinds) kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
    let kind = 'labor';
    let bestKindCount = 0;
    for (const [k, c] of kindCounts) {
      if (c > bestKindCount || (c === bestKindCount && k < kind)) { kind = k; bestKindCount = c; }
    }

    out.push({ displayName: data.displayName, uses: data.uses, modalPrice, kind });
  }
  return out.sort((a, b) => b.uses - a.uses);
}

function printTable(candidates: Candidate[]): void {
  const nameW = Math.max(4, ...candidates.map(c => c.displayName.length));
  const header = ` #  ${'Name'.padEnd(nameW)}  Uses  Modal $    Kind`;
  console.log('\n' + header);
  console.log('-'.repeat(header.length));
  candidates.forEach((c, i) => {
    const num = String(i + 1).padStart(2);
    const price = ('$' + c.modalPrice.toFixed(2)).padStart(9);
    console.log(` ${num}  ${c.displayName.padEnd(nameW)}  ${String(c.uses).padStart(4)}  ${price}  ${c.kind}`);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('Loading pricebook and state...');
  const [pricebookNames, stateNames] = await Promise.all([loadPricebookNames(), loadStateNames()]);
  console.log(`  Pricebook: ${pricebookNames.size} items | Already promoted: ${stateNames.size}`);

  console.log('\nFetching jobs...');
  const jobs = await fetchAllJobs();

  console.log('\nFetching line items...');
  let done = 0;
  const lineItemsList = await pMap(jobs, async job => {
    const items = await fetchLineItems(job.id);
    done++;
    process.stdout.write(`\r  ${done}/${jobs.length}`);
    return { id: job.id, items };
  }, CONCURRENCY);
  console.log();

  const lineItemsByJob = new Map(lineItemsList.map(e => [e.id, e.items]));
  const agg = aggregateCandidates(jobs, lineItemsByJob);
  const candidates = buildCandidates(agg, pricebookNames, stateNames);

  if (candidates.length === 0) {
    console.log('\nNothing new to add — all recurring custom items are already in the pricebook.');
    return;
  }

  console.log(`\nMining complete. Found ${candidates.length} candidate(s):`);
  printTable(candidates);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nAdd all ${candidates.length} items to pricebook? [y/N] `);
  rl.close();

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Aborted — nothing added.');
    return;
  }

  const promoted: Array<{ name: string; uuid: string }> = [];
  for (const c of candidates) {
    try {
      const item = await createPriceBookItem({
        name: c.displayName,
        unitPrice: c.modalPrice,
        unitCost: 0,
        unitOfMeasure: 'Each',
        category: 'Custom',
      });
      promoted.push({ name: c.displayName, uuid: item.uuid });
      console.log(`  ✓ ${c.displayName} → ${item.uuid}`);
    } catch (e) {
      console.error(`  ✗ ${c.displayName}: ${(e as Error).message}`);
    }
  }

  await appendToState(promoted);
  console.log(`\nDone. ${promoted.length}/${candidates.length} items added.`);
  if (promoted.length < candidates.length) {
    console.log(`${candidates.length - promoted.length} failed — see errors above.`);
  }
}

run().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the check still passes**

```
npx tsx src/hcp/mine-pricebook-candidates.check.ts
```

Expected: `✓ mine-pricebook-candidates self-check passed`

- [ ] **Step 3: Verify TypeScript compiles clean**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```
git add src/hcp/mine-pricebook-candidates.ts
git commit -m "feat(pricebook): complete mine-pricebook-candidates script"
```

---

### Task 5: Wire into package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the `mine-pricebook` script**

In `package.json`, in the `"scripts"` block, add after the `"add-item"` line:

```json
"mine-pricebook": "tsx src/hcp/mine-pricebook-candidates.ts",
```

The scripts block should now include:
```json
"add-item": "tsx src/hcp/add-item-cli.ts",
"mine-pricebook": "tsx src/hcp/mine-pricebook-candidates.ts",
```

- [ ] **Step 2: Verify the check still passes via the npm alias**

```
npx tsx src/hcp/mine-pricebook-candidates.check.ts
```

Expected: `✓ mine-pricebook-candidates self-check passed`

- [ ] **Step 3: Commit**

```
git add package.json
git commit -m "chore: add mine-pricebook npm script"
```

---

### Task 6: Live smoke test (manual verification)

> This task requires a valid HCP session. Run `npm run login` first if the session is expired.

- [ ] **Step 1: Run the script in dry-run mode (answer `n` at the prompt)**

```
npm run mine-pricebook
```

Expected flow:
1. Prints pricebook count and already-promoted count
2. Fetches jobs with page-by-page progress
3. Fetches line items with a counter
4. Prints a ranked table of candidates (or "nothing new" if everything is already covered)
5. Prompts `Add all N items to pricebook? [y/N]`
6. Type `n` — prints `Aborted — nothing added.` and exits 0

If the table looks right (names make sense as real line items, counts are plausible, prices are reasonable), proceed to Step 2. If something looks wrong (e.g. pricebook items leaking through, strange names), stop and investigate before adding anything to HCP.

- [ ] **Step 2: If table looks right, run again and answer `y`**

```
npm run mine-pricebook
```

Type `y` when prompted. Expected: each item prints `✓ <name> → olit_...` and `data/promoted-items.json` is created with the promoted items.

- [ ] **Step 3: Verify state file was created**

```
cat data/promoted-items.json
```

Expected: JSON with a `promoted` array containing one entry per added item, each with `name`, `uuid`, and `addedAt` (today's date).

- [ ] **Step 4: Run the script a second time — verify already-promoted items are skipped**

```
npm run mine-pricebook
```

Expected: the items just added no longer appear in the candidates table (they're in the state file now). Either "Nothing new to add" or a shorter list.

- [ ] **Step 5: Commit state file (add to .gitignore if preferred)**

The `data/promoted-items.json` file should be committed to track the promotion history. If `data/` is gitignored, add a specific exception:

Check `.gitignore` — if `data/` is listed, add this line:
```
!data/promoted-items.json
```

Then commit:
```
git add data/promoted-items.json .gitignore
git commit -m "chore(pricebook): initial promoted-items state after first mine run"
```

---

## Self-review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| Fetch all jobs + line items (5 concurrent) | Task 3 |
| Custom items = `service_item_id` null | Task 2 (`aggregateCandidates`) |
| Per-job dedup (qty 3 of same = 1 use) | Task 2 (`aggregateCandidates`) |
| Count ≥ 2 | Task 4 (`buildCandidates`, `MIN_USES`) |
| Normalize-match against pricebook | Task 4 (`buildCandidates`) |
| Normalize-match against state file | Task 4 (`buildCandidates`) |
| Modal price (ties → lowest) | Task 2 (`modalValue`) |
| Kind ties → 'labor' | Task 4 (`buildCandidates`) |
| Ranked table sorted by use count | Task 4 (`printTable`) |
| Interactive `[y/N]` prompt | Task 4 (`run`) |
| `createPriceBookItem` for each on `y` | Task 4 (`run`) |
| State file append on success | Task 3 (`appendToState`), Task 4 (`run`) |
| Error on one item → continue rest | Task 4 (`run` try/catch per item) |
| `npm run mine-pricebook` script | Task 5 |
| Re-run skips already-promoted | Task 3 (`loadStateNames`), Task 6 (verified) |

All requirements covered. No placeholders. Type names are consistent (`RawLineItem`, `Candidate`, `StateFile`) across all tasks.
