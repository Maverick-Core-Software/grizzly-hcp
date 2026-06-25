# Mav Memory System — Design Spec

**Date:** 2026-06-25  
**Status:** Draft — pending implementation

---

## Workflow Context

Mav operates in two phases during any real job conversation:

**Phase 1 — Planning (RAG-backed, already works well)**
Carter and Mav talk through the job like field techs: routing decisions, code requirements, panel brand, circuit counts, site conditions. The RAG returns NEC 2026, Oncor rules, and Grizzly job history. This is where the job gets figured out. Memory rules also apply here — if Carter corrects a technical assumption ("no, that attic is finished, we're going through the wall"), that becomes a rule.

**Phase 2 — Build (pricebook-matching, needs improvement)**
After the scope is nailed down ("read it back" → "build it"), Mav maps every decision to specific line items. This is where the wrong footage bracket gets chosen, where "drop a wall" becomes five separate materials, where "Tesla charger" finds nothing. Rules and aliases fix this.

The memory system serves both phases: rules improve build-mode accuracy; aliases improve planning-mode vocabulary understanding. But the trigger to save a rule can happen in either phase.

---

## Problem

Mav doesn't learn from Carter across sessions. Two distinct failure modes:

1. **Parametric selection failures** — given "80 feet, 20 amp circuit," Mav picks the wrong footage-range bracket, or decomposes a bundled item into individual materials that already have a single line item covering them.

2. **Vocabulary mismatches** — Carter says "Tesla Level 2 in the garage, 5 feet from the panel" and Mav can't connect that to "EV Charger Install (Level 2, NEMA 14-50)" because none of Carter's words appear in the pricebook text.

Both are solvable without growing the prompt indefinitely and without degrading search quality.

---

## Solution: Two Mechanisms

### 1. Rules — behavioral logic, injected at startup

Short, deterministic instructions that live in `data/mav-rules.md`. Loaded by `createMaverickAgent()` and prepended to `BASE_INSTRUCTIONS` as a compact `## Carter's Rules` block.

**What belongs here:**
- Footage-range selection: "pick the bracket that covers the stated run, not the shortest bracket"
- Amperage selection: "20A vs 30A is determined by what Carter states, not inferred"
- Bundle rules: "dropping a wall (outlet) is included in the circuit line item — do not add a separate device"
- Pairing rules: "conduit always pairs with a matching install-labor item of the same type and size"
- Correction rules: "when Carter says 'that's one item,' collapse the decomposition into the single closest match"

**Constraints — hard limits:**
- Maximum 20 rules total. When at cap, Mav consolidates or rewrites rather than appending.
- Each rule is 1–2 sentences. No prose, no examples inline — pure instruction.
- No pricing data, no customer data, no job-specific facts.

### 2. Aliases — vocabulary augmentation in Qdrant

Carter's field language attached directly to pricebook items in the RAG. When Mav and Carter agree on a line item, Mav extracts the phrases Carter used and appends them to that item's Qdrant entry. The item is then re-embedded with the augmented text, so future searches match Carter's words naturally.

**What belongs here:**
- Product synonyms: "Tesla", "EV", "NEMA 14-50", "Level 2", "Level 1" → correct EV charger item
- Brand names: "Square D", "Cutler Hammer", "CH", "QO" → panel items
- Field shorthand: "roll some EMT", "tap off the panel", "drop a fourplex" → specific items
- Regional/trade terminology Carter uses that doesn't appear in standard pricebook descriptions

**What doesn't belong here:**
- Parametric selection logic (footage ranges, amperage brackets) — that's a rule
- Pairing logic (conduit + labor) — that's a rule

---

## Agent Tools

### `save_rule`

```ts
{
  rule: string,        // 1-2 sentence instruction
  category:            // 'selection' | 'pairing' | 'bundling' | 'general'
    | 'selection'      // which item to pick (range, amperage, type)
    | 'pairing'        // items that always come together
    | 'bundling'       // what's included vs itemized separately
    | 'general',       // catch-all for other behavioral corrections
  replaces?: string    // id of existing rule this supersedes (for updates)
}
```

Writes to `data/mav-rules.md`. Before writing, Mav checks for a near-duplicate rule and updates rather than appending if one exists.

### `save_alias`

```ts
{
  item_id: string,     // pricebook uuid — e.g. "olit_abc123"
  item_name: string,   // human-readable name for confirmation
  phrases: string[]    // Carter's words to attach to this item
}
```

Calls `POST http://192.168.1.12:8181/pricebook/learn`.

---

## Auto-Trigger Logic

Mav watches every message for signals to call either tool. It should do this proactively — the goal is that after 6 months of use, Carter's natural way of talking is fully reflected in the rules and alias store.

**Rule triggers — call `save_rule`:**
- Carter corrects a footage bracket: "no, 80 feet goes in the 0-150 item"
- Carter corrects a decomposition: "that's one line item, not five"
- Carter corrects amperage or type selection
- Carter explicitly states a behavioral rule: "when I say X, always Y"
- Mav notices it made the same selection mistake more than once in a session

**Alias triggers — call `save_alias`:**
- After Carter says "build it" and confirms the estimate: Mav extracts phrases from Carter's messages that described each confirmed item, saves them as aliases on those items
- Carter uses a term that produced no match or a wrong match (Mav had to ask for clarification)
- Carter explicitly says "remember, when I say X I mean Y"

**Before saving either tool, Mav should:**
1. State what it's about to save: "Saving rule: conduit always pairs with labor — let me know if that's wrong."
2. Allow Carter to say no: "Actually don't save that" cancels the write.

---

## Load Mechanism

**Rules:**
- `src/agent/index.ts` calls `loadMavRules()` on `createMaverickAgent()`
- `loadMavRules()` reads `data/mav-rules.md`, returns the rules block
- Appended to `BASE_INSTRUCTIONS` as `\n\n## Carter's Rules\n{rules}`
- If file doesn't exist or is empty, no block is added (graceful degradation)

**Aliases:**
- No explicit load step needed — aliases are embedded in the Qdrant vectors
- `search_pricebook` naturally returns better results once aliases are attached
- Zero latency overhead, zero prompt growth

---

## Storage

```
Grizzly-HCP/
  data/
    mav-rules.md              ← compact rules block, loaded into system prompt (new)
    pricebook-aliases.json    ← already exists; keyed by olit_uuid → string[]
```

`pricebook-aliases.json` format (existing, preserved):
```json
{
  "olit_7fc3bc8c...": ["Tesla Level 2", "EV charger", "NEMA 14-50", "50 amp car charger"]
}
```

Qdrant pricebook points get a new payload field (currently absent):
```json
"carter_aliases": ["Tesla", "Level 2", "14-50R", "EV charger in garage"]
```

The embedded text for each augmented item becomes:
```
{name} {description} {carter_aliases.join(' ')}
```

---

## RAG Server Changes (Proxmox)

### Existing infrastructure
- `POST /pricebook/search` — vector search, no changes needed
- `POST /pricebook/index` — upserts a single item into Qdrant (already in `src/rag/client.ts`)

### New endpoint: `POST /pricebook/learn`

**Input:**
```json
{
  "item_id": "olit_abc123",
  "phrases": ["Tesla", "Level 2", "EV", "NEMA 14-50"]
}
```

**Logic:**
1. Fetch existing Qdrant point by `item_id`
2. Merge new phrases into `carter_aliases[]`: lowercase, deduplicate, ignore empty strings
3. Re-embed: `f"{name} {description} {' '.join(carter_aliases)}"`
4. Upsert point — new vector + updated payload
5. Return `{ "success": true, "item_name": "...", "alias_count": N }`

**Input validation:**
- Unknown `item_id` → 404
- Empty `phrases` after dedup → 400
- No re-embed if nothing new added → 200 with `"unchanged": true`

### Alias sync utility (one-time + on-demand)

`data/pricebook-aliases.json` already contains ~100 aliased items that are **not yet in Qdrant**. A sync script on Proxmox reads the JSON and calls `/pricebook/learn` for each entry to bootstrap the existing aliases into the vector index. Run once after deploy; also callable when the file is updated outside the tool.

**No changes required to `POST /pricebook/search`** — it already uses vector similarity. Once the vector includes Carter's words, search improves automatically.

---

## Pre-Seeded Rules (ship on day one)

`mav-rules.md` does not start empty. It ships with a core set of deterministic rules that Mav follows every time. These are not learned — they are programmed in and correct from the first conversation. Mav adds to them via `save_rule`; these never get removed or overwritten by learning.

### Complexity detection
> If Carter provides amperage, footage, routing method (attic / wall / conduit / underground), and end device, the job is fully specified. Skip planning mode entirely. Present the confirmation card immediately. Do not ask questions that aren't necessary.
>
> If any of those are missing AND the job is non-trivial (e.g., "2-story, no attic access, circuit to the other side of the house"), enter planning mode first.

### Footage brackets for circuit items
Each bracket corresponds to a specific pricebook item. Always pick the item whose range covers the stated footage:
- 0–50 ft → flat-rate circuit item (quantity = 1)
- 51–150 ft → per-foot circuit item (quantity = stated footage)
- 151–250 ft → long-run per-foot circuit item (quantity = stated footage)

Never pick a shorter-range item when footage exceeds its ceiling.

### Wire gauge from amperage
- 15A or 20A → #12 AWG
- 30A → #10 AWG
- 40A → #8 AWG
- 50–60A → #6 AWG

### Conduit wire type
- Wire inside conduit outdoors or in wet/damp locations → THHN, not Romex
- Wire in conduit in a dry interior wall → THHN still preferred; Romex is not rated for conduit
- Open attic, no conduit → Romex (NM-B) acceptable in dry attic

### Conductor count in conduit
A standard circuit in conduit = 3 conductors: hot + neutral + ground.
Wire material quantity = conduit footage × 3.

Example: 30' of ½" PVC conduit for a 20A circuit → add THHN #12 at quantity 90.

### Conduit pairing rule
Every conduit run always produces two line items: one labor (install conduit, type + size, qty = footage) and one material (conduit, type + size, qty = footage). They always match in type, size, and quantity. Never one without the other.

### Device inclusion
- "Drop a wall" / "drop an outlet" / "terminate at device" → the outlet/device is included in the circuit line item. Do not add a separate device item.
- "Dedicated GFCI" → add a separate GFCI device line item in addition to the circuit.
- "GFCI at the end" → same as dedicated GFCI — separate item.

---

## What This Does Not Cover

- Customer-specific facts ("John Smith's house is slab") — belongs in HCP customer notes or a future customer-memory system
- Pricing corrections — pricing lives in the pricebook; `save_alias` does not touch prices
- Job history — that's the existing `grizzly_hcp` RAG collection

---

## Success Criteria

After implementation:
- "80 feet, 20 amp circuit through the attic" → Mav selects `Install New 20A Circuit (Attic Access, 0-150ft)` without being told to
- "Tesla Level 2, 5 feet from the panel" → Mav finds the EV charger install item, not nothing
- "Run ¾" EMT" → Mav adds the material item AND the matching labor item, footage quantity on both
- "Drop a wall" → NOT added as a separate device item; Mav knows it's bundled in the circuit
- Mav announces what it's saving and Carter can veto before it writes
