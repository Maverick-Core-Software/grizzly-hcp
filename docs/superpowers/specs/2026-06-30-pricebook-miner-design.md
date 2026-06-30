# Pricebook Candidate Miner

**Date:** 2026-06-30  
**Status:** Approved

## Goal

Mine historical HCP job line items to find custom (non-pricebook) items used on 2+ jobs and add them to the pricebook. Run monthly to keep the pricebook growing from real work history.

## New files

| Path | Purpose |
|------|---------|
| `src/hcp/mine-pricebook-candidates.ts` | The script |
| `data/promoted-items.json` | State file: tracks already-promoted items so re-runs skip them |

## New npm script

```
npm run mine-pricebook
```

Added to `package.json`.

## Pipeline

### 1. Load current pricebook

Call `listAllServices()` from `src/hcp/price-book.ts`. Normalize all names (lowercase, strip punctuation, collapse whitespace) into a `Set<string>` for dedup matching.

### 2. Load state file

Read `data/promoted-items.json` if it exists. Collect the `promoted[].name` values, normalize each, into a second `Set<string>`. First run: file doesn't exist → empty set.

### 3. Fetch all jobs + line items

- Paginate `GET /alpha/jobs?page=N&page_size=100&expand[]=customer` (same pattern as `sync-estimates.ts`)
- For each job, fetch `GET /alpha/jobs/{id}/line_items` with 5 concurrent workers

### 4. Aggregate custom items

A line item is **custom** if `service_item_id` is null or empty string.

For each job, deduplicate by normalized name before counting (so a job with qty 3 of the same item counts as 1 use). Across all jobs, track:

```
normalizedName → {
  displayName: string       // first-seen raw name
  uses: number              // distinct jobs this appeared on
  prices: number[]          // all unit_price values seen (cents)
  kind: string              // most common kind across occurrences; ties → 'labor'
}
```

### 5. Filter candidates

Exclude if any of:
- `uses < 2`
- normalized name is in the state file set (already promoted)
- normalized name matches any current pricebook item name (already there under a slightly different spelling)

### 6. Compute modal price

For each candidate, find the most frequently occurring value in `prices[]`. Ties: pick the lowest. Convert from cents to dollars for display and API call.

### 7. Print ranked table

Sort candidates by `uses` descending. Print:

```
Mining complete. Found N candidate(s):

 #  Name                          Uses  Modal $   Kind
 1  Ground Rod Installation          8  $185.00   labor
 2  Service Call - After Hours       5  $150.00   labor
 3  Breaker - 20A Single Pole        4   $45.00   materials
...

Add all N items to pricebook? [y/N]
```

If no candidates: print a "nothing new to add" message and exit 0.

### 8. Add to pricebook (on `y`)

For each candidate call `createPriceBookItem()` from `src/hcp/price-book.ts`:
- `name`: raw display name
- `unitPrice`: modal price in dollars
- `unitCost`: 0 (Carter prices cost separately)
- `unitOfMeasure`: `'Each'`
- `category`: `'Custom'` (default electrical category UUID is resolved inside `createPriceBookItem`)

`createPriceBookItem` already handles RAG sync and bookkeeping (`recordNewPricebookItem`).

Print each result as it's added:
```
  ✓ Ground Rod Installation  →  olit_abc123
  ✓ Service Call - After Hours  →  olit_def456
  ...
Done. 11 items added.
```

### 9. Update state file

Append all newly promoted items to `data/promoted-items.json`:

```json
{
  "promoted": [
    { "name": "Ground Rod Installation", "uuid": "olit_abc123", "addedAt": "2026-06-30" }
  ]
}
```

Create the file if it doesn't exist.

## Dedup / normalization

```ts
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
```

Used consistently for: pricebook name matching, state file matching, and grouping line item names during aggregation.

## Error handling

- HCP auth failure: propagate the error (same behavior as other scripts — tells user to run `npm run login`)
- Individual job line item fetch failure: skip that job, log a warning, continue
- `createPriceBookItem` failure on one item: log the error, continue with remaining items, note failures at the end

## Dependencies

No new packages. Uses existing:
- `src/hcp/client.ts` — `hcpGet`
- `src/hcp/price-book.ts` — `listAllServices`, `createPriceBookItem`
- `dotenv/config`
- Node `fs/promises`, `readline`

## Out of scope

- Scheduling (run manually first, wire to a scheduled task after first run validates output)
- Materials category assignment (uses default via `createPriceBookItem`)
- Per-item approval (all-or-nothing on `y`)
- Fuzzy/Levenshtein matching (normalize-then-exact is sufficient)
