# Maverick — Pricebook & Estimate Workflow Redesign

**Date:** 2026-06-24  
**Status:** Design approved, pending implementation plan

---

## Problem

The Maverick agent estimate flow is unreliable because:
1. The pricebook has inconsistent naming (mixed capitalization, abbreviations, no format standard) accumulated from multiple contributors
2. There is no explicit two-mode workflow — Mav tries to do planning and estimate building in the same undifferentiated conversation
3. Unmatched materials surface as `⚠ NEEDS PRICING` flags that require manual intervention every time
4. The live chat experience is slow — tool calls happen mid-conversation during the planning phase when they shouldn't

---

## Design Overview

Three sequential phases. Each phase delivers standalone value.

```
Phase 1: Pricebook Restructure        ← foundation; everything else depends on this
Phase 2: Auto-Pricing Intelligence    ← kills the NEEDS PRICING flag for materials
Phase 3: Agent Workflow Redesign      ← foreman conversation + fast chat + spec sheet
```

---

## Phase 1 — Pricebook Restructure

### Goal
Every item in the pricebook has a consistent, LLM-matchable name that also looks professional on a customer-facing estimate.

### Naming Convention

**Format:** `[Spec/Size] [Type] [Qualifier if needed]`

```
200A Panel Upgrade
Dedicated 20A Circuit
GFCI Outlet Install
2" PVC Sch 40 Conduit, per ft
#12 THHN Copper Wire, per ft
Whole Home Surge Protector
8 ft Ground Rod
```

**Rules — non-negotiable:**
- Amperage: always `200A` — never "200 amp", "200-amp", "200 AMP"
- Wire gauge: always `#12 THHN` or `12/2 Romex` — no mixing formats
- Per-foot items: always end with `, per ft`
- No abbreviations in the type word — "Upgrade" not "Upg", "Install" not "Inst"
- Labor is implied — no "(labor)" tag needed
- Materials that sell by unit: no suffix needed
- Title Case throughout — every word capitalized

**Why this format for LLM matching:**  
Spec-first puts the most distinctive token at the start of the string. When Mav hears "200 amp panel upgrade" in conversation, the semantic vector aligns with `200A Panel Upgrade` far more reliably than with `Panel Upgrade — 200 Amp` or `Panel Enclosure 200 amp` (current). The dash-separator (Option A) was rejected because it adds punctuation noise with no matching benefit.

### Category Structure

| Category | Scope |
|---|---|
| Service Calls & Diagnostics | Diagnostic fees, trip charges, emergency rates |
| Panel Upgrades | 100/200/400A panel labor, all residential |
| Service Entrance | Riser, mast, SEU cable runs, weatherhead |
| New Circuits & Wiring | Dedicated circuits (20/30/50A), branch circuits, home runs |
| EV Charger | Level 2 installs, NEMA 14-50, trenched runs |
| Generator | Interlock, transfer switch, inlet box, standby installs |
| Ceiling Fans & Fixtures | Fan install, fixture install, fan/light combo |
| Switches, Outlets & Devices | GFCI, AFCI, dimmer, standard receptacle, USB outlet |
| Surge Protection | Whole-home surge, panel-mounted surge |
| Grounding & Bonding | Ground rods, bonding clamps, electrode conductor |
| Low Voltage | CAT5/6 runs, doorbell, landscape lighting transformer |
| Underground & Trenching | Trenching labor per foot, boring |
| Remodel — Rough-In | Wire runs and boxes while walls are open; faster labor rate |
| Remodel — Trim-Out | Devices and fixtures after drywall; standard device rates |
| Commercial | Commercial-specific items (handful, not full mirror of residential) |
| Conduit — Materials | EMT, PVC Sch 40, rigid — per foot by size |
| Wire & Cable — Materials | Romex, THHN, SER, URD — per foot by gauge |
| Permits & Inspections | Permit fees, inspection fees, AHJ-specific |
| Fees & Adjustments | Credit card fee, job walk, deposit placeholder, discounts |

### Implementation Steps

1. **Validation script** — scan every item in `data/pricebook.csv` and flag any that don't conform to the naming convention. Output: list of items to fix with suggested rename.
2. **Rename pass** — go through the flagged list and update names in the CSV.
3. **Category reassignment** — move items currently in loose categories ("Install", "Miscellaneous Material") into the new job-type categories.
4. **Gap fill** — add items that appear 3+ times in `data/estimates-enriched.csv` (real jobs) but have no matching pricebook entry. *(Specific list: see Appendix A — Audit Results when available.)*
5. **Sync** — push updated pricebook to HCP and re-index RAG collection.

---

## Phase 2 — Auto-Pricing Intelligence

### Goal
Eliminate the `⚠ NEEDS PRICING` flag for materials. When Mav encounters an unmatched material during estimate building, it prices and creates the pricebook entry automatically.

### Pricing Rules

**Material pricing:**
- Source: Home Depot (Grizzly's primary supplier)
- Markup: 45% on top of HD price
- Formula: `grizzly_price = hd_price × 1.45`
- Mav writes the entry with: name (per naming convention), description, category, unit, price

**Labor pricing:**
- NOT auto-priced — labor stays manual
- Mav knows the labor benchmarks and can suggest a price, but Carter sets it
- Labor items still surface as `⚠ NEEDS PRICING` if unmatched
- Reason: labor pricing is relationship/job-specific; materials are commodity

**Labor benchmarks Mav knows:**
- Crew rate: 2 guys × $45/hr = $90/hr total
- Service upgrade (panel + meter + disconnect + ground rods + riser): ~$900 cost, ~$7,500 price
- Fan replacement (customer supplies): $199/fan, 1 hr minimum
- Fixture replacement (customer supplies): $179/fixture, 1 hr minimum

### HD Lookup Tool

New Mav tool: `lookup_home_depot_price(item_description)`
- Searches Home Depot for the item
- Returns: HD price, product name, SKU, unit (each / per ft / etc.)
- Mav applies 45% markup, generates a professional item name (per naming convention), writes to pricebook
- Logs the auto-creation for Carter's review (not silent)

### Policy Change

This replaces the existing "never auto-write to pricebook" policy for **materials only**.  
Labor items: policy unchanged — never auto-priced, always flagged.

---

## Phase 3 — Agent Workflow Redesign

### Goal
Mav behaves like a knowledgeable journeyman in the planning phase — fast, natural, conversational. Heavy work only happens when building the estimate.

### Two Modes

**Planning Mode (default)**
- Fast, streaming responses — tokens appear immediately
- No pricebook searches, no RAG calls mid-sentence
- Mav tracks the job spec internally as the conversation progresses
- Discusses conduit routing, wire sizing, code compliance, material choices
- No tool calls during this phase (except customer lookup at job start)

**Build Mode (triggered by "read it back" → confirm → "build it")**
- Mav reads back the full spec sheet (see format below)
- Carter confirms or corrects
- Carter says "build it" (or equivalent)
- Mav does all the heavy work: pricebook matching, HD lookups for gaps, estimate creation
- Returns HCP estimate URL

### Transition — "Read It Back"

The transition from Planning → Build is natural, not a keyword. Either side initiates:
- Carter: *"alright read it back"* / *"let's see what we got"* / *"that's everything"*
- Mav: *"I think I've got everything — want me to read it back?"*

Mav recognizes this transition from conversational context, not a hardcoded trigger word.

### Spec Sheet Format

When Mav reads back, it outputs a structured spec sheet organized by job component. The same format is shown in chat and spoken aloud in voice mode.

```
Scope — 200A Panel Upgrade | 123 Oak St

Job Type:         Panel Upgrade — Residential, 200A

Panel
  Brand / Model:  Square D QO 200A, 40-space
  Location:       Garage, interior wall
  Meter enclosure: Replace, 200A

Service Entrance
  Wire:           2/0 AL SER, ~50 ft
  Conduit:        2" PVC Sch 40, ~45 ft

Circuits
  New dedicated:  3 × 20A (kitchen)
  AFCI breakers:  All bedroom circuits
  GFCI:           Kitchen + bathrooms

Grounding
  Ground rods:    2 × 8 ft copper
  Bonding:        Water main + gas line
```

Carter reviews, corrects any field, then says "build it."

### Live Chat Performance

The current chat is slow because tool calls happen during the planning conversation. Fix:
- Planning mode: zero tool calls mid-response. Mav reasons from context only.
- Streaming: all responses stream token-by-token. No waiting for full response before display.
- Tool calls batch at build time only — pricebook matching, HD lookup, HCP writes all happen after "build it", not during conversation.
- Voice mode: same two-mode design. Sub-second response in planning mode is achievable when there are no blocking tool calls.

---

## Data & Pricing Reference

| Benchmark | Cost | Price | Notes |
|---|---|---|---|
| Service upgrade (panel + meter + disconnect + grounds + riser) | ~$900 | ~$7,500 | 2 guys, 8 hrs |
| Fan replacement (customer supplies) | ~$45 | $199 | 1 guy, 1 hr min |
| Fixture replacement (customer supplies) | ~$45 | $179 | 1 guy, 1 hr min |
| Crew rate | $90/hr | — | 2 guys × $45/hr |
| Material markup | HD price | × 1.45 | 45% markup floor |

---

## Appendix A — Pricebook Audit Results

*To be populated once `data/estimates-enriched.csv` audit completes. Will contain:*
- Top 50 line items used in real jobs with pricebook match status
- Top 20 gaps (used 3+ times, not in pricebook)
- Items to rename for naming convention compliance
- Category reassignment list
