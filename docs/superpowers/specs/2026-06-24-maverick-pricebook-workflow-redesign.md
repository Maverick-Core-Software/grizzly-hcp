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
- Crew cost: 2 guys × $45/hr = $90/hr — this is what Grizzly PAYS, NOT what is charged to the customer
- Service upgrade (panel + meter + disconnect + ground rods + riser): ~$900 total crew cost, charged at ~$7,500
- Fan replacement (customer supplies): charged $199/fan — 1 guy, 1 hr minimum crew cost
- Fixture replacement (customer supplies): charged $179/fixture — 1 guy, 1 hr minimum crew cost
- Mav uses these as cost-check references, never as the charge rate

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
| Crew cost (NOT charge rate) | $90/hr | varies by job | 2 guys × $45/hr — what Grizzly pays, not what customer is billed |
| Material markup | HD price | × 1.45 | 45% markup floor |

---

## Appendix A — Pricebook Audit Results

*Source: `data/pricebook.csv` (243 items) × `data/estimates-enriched.csv` (1,269 jobs). Audit run 2026-06-24.*

---

### A1. Pricebook Overview

**Total Items:** 243 items across 19 categories

**Category Breakdown:**
- Install: 87 items (35.8%) — CATCH-ALL
- New Build/Remodel: 26 items (10.7%)
- Devices: 21 items (8.6%)
- Google: 16 items (6.6%) — DUPLICATE/VARIANT PRICING
- Service Entrance and Panel: 14 items (5.8%)
- Fixtures: 10 items (4.1%)
- Generator Equipment: 10 items (4.1%)
- Service Call: 9 items (3.7%)
- Panel/Service: 9 items (3.7%) — DUPLICATE CATEGORY
- Outdoor Devices: 8 items (3.3%)
- Generator Install Items: 7 items (2.9%)
- Ethernet and Data: 7 items (2.9%)
- Security Camera Systems: 6 items (2.5%)
- Tools/Equipment: 4 items (1.6%)
- Disconnects: 2 items (0.8%)
- Permit and Licensing: 2 items (0.8%)
- Service Upgrades: 2 items (0.8%)
- Wire & Cable: 2 items (0.8%)
- Miscellaneous Material: 1 item (0.4%)

**Price Range:** Min $0.00 (14 placeholder items) · Median $150 · Max ~$9,143 · Mean ~$439

**Key Observations:**
- "Install" at 87 items (36%) is a catch-all spanning $50 assembly to $6,999 specialty systems
- "Google" (16 items) duplicates Install items at inconsistent prices — origin/purpose unclear
- "Panel/Service" (9) and "Service Entrance and Panel" (14) overlap significantly
- 14 items priced $0.00 are placeholders; one item named "test" ($65) remains

---

### A2. Top 50 Line Items by Job Frequency

| Rank | Description (from estimates) | Jobs | Match | Match Name | Category | Price |
|------|------------------------------|------|-------|------------|----------|-------|
| 1 | Service Fee | 408 | ✅ | Service Fee | Service Call | $79 |
| 2 | Troubleshoot Level 1 | 151 | ✅ | Troubleshoot Level 1 | Service Call | $189 |
| 3 | Add New Receptacle | 134 | ✅ | Add New Receptacle | Install | $209 |
| 4 | Replace Light Fixture (owner provided) | 101 | ✅ | Replace Light Fixture (owner provided fixture) | Install | $119 |
| 5 | Replace Switch / Receptacle | 90 | ✅ | Replace Switch / Receptacle | Install | $79 |
| 6 | Replace GFCI Receptacle | 87 | ⚠️ Fuzzy | Replace GFCI Receptacle | Install | $149 |
| 7 | Whole Home Surge Protector | 56 | ✅ | Whole Home Surge Protector | Install | $479 |
| 8 | Replace Breaker | 50 | ✅ | Replace Breaker | Install | $89 |
| 9 | Add New Switch and Fixture | 40 | ✅ | Add New Switch and Fixture | Install | $439 |
| 10 | Ceiling Fan (up to 12' ceiling) | 39 | ✅ | Ceiling Fan (up to 12' ceiling) | Install | $199 |
| 11 | Grounding and Bonding | 38 | ✅ | Grounding and Bonding | Service Entrance and Panel | $800 |
| 12 | Install New 15/20a Circuit (Up to 50') | 37 | ✅ | Install New 15/20a Circuit (Up to 50') | Install | $397 |
| 13 | 200A Meter Enclosure | 36 | ✅ | 200A Meter Enclosure | Service Entrance and Panel | $1,200 |
| 14 | Fixed Gratuity | 34 | ❌ Gap | — | — | — |
| 15 | Install EV Car Charger (Stud Cavity Next to Panel) | 32 | ✅ | Install EV Car Charger (Stud Cavity Next to Panel) | Install | $599 |
| 16 | 200A Panel Enclosure | 30 | ✅ | 200A Panel Enclosure | Service Entrance and Panel | $3,199 |
| 17 | Install Dimmer Switch (Decora or Toggle) | 28 | ✅ | Install Dimmer Switch (Decora or Toggle) | Install | $159 |
| 18 | Permits and Inspections | 26 | ✅ | Permits and Inspections | Permit and Licensing | $500 |
| 19 | GFCI/AFCI Breaker | 25 | ✅ | GFCI/AFCI Breaker | Install | $159 |
| 20 | Install New LED Slim Can Light (Open Access) | 25 | ✅ | Install New LED Slim Can Light (Open Access) | Install | $129 |
| 21 | Install Conduit (1/2"-1") | 23 | ✅ | Install Conduit (1/2"-1") | Install | $5.99/ft |
| 22 | Service Disconnect | 20 | ✅ | Service Disconnect | Service Entrance and Panel | $949 |
| 23 | Commercial Service Fee | 18 | ✅ | Commercial Service Fee | Service Call | $129 |
| 24 | Troubleshoot Level 2 | 17 | ✅ | Troubleshoot Level 2 | Service Call | $319 |
| 25 | Generator Inlet with Interlock | 17 | ✅ | Generator Inlet with Interlock | Generator Install Items | $1,199 |
| 26 | Replace 2-pole Breaker | 17 | ✅ | Replace 2-pole Breaker | Install | $139 |
| 27 | Install light fixtures | 15 | ⚠️ Case | Install light fixtures | Google | $119 |
| 28 | Replace Chandelier (10'-15') | 15 | ✅ | Replace Chandelier (10'-15') | Install | $279 |
| 29 | Replace Recessed Lighting with Slim Downlights | 14 | ⚠️ Fuzzy | Replace Recessed Lighting with Slim Downlights | Install | $109 |
| 30 | 3/4" EMT | 14 | ❌ Gap | — | — | — |
| 31 | Make Safe | 14 | ✅ | Make Safe | Install | $79 |
| 32 | Relocate outlets or switches | 13 | ⚠️ Case | Relocate outlets or switches | Google | $209 |
| 33 | Install Smart Switch | 12 | ⚠️ Fuzzy | Install Smart Switch | Install | $129 |
| 34 | Emergency Service Fee | 12 | ✅ | Emergency Service Fee | Service Call | $179 |
| 35 | Install electric car charger | 12 | ⚠️ Case | Install Electric Car Charger | Google | $499 |
| 36 | Install New Overhead Service Riser | 11 | ✅ | Install New Overhead Service Riser | Service Entrance and Panel | $800 |
| 37 | permits and inspections | 11 | ⚠️ Case | Permits and Inspections | Permit and Licensing | $500 |
| 38 | Install Ballast Bypass LED Tubes (Up to 4 Lamps) | 10 | ✅ | Install Ballast Bypass LED Tubes (Up to 4 Lamps) | Install | $179 |
| 39 | Replace Exhaust Fan | 10 | ⚠️ Fuzzy | Replace Exhaust Fan | Install | $319 |
| 40 | 3/4" PVC Schedule 40 | 10 | ❌ Gap | — | — | — |
| 41 | Indoor Scaffolding (Up to 15') | 10 | ✅ | Indoor Scaffolding (Up to 15') | Tools/Equipment | $125 |
| 42 | Install GFCI | 10 | ✅ | Install GFCI | New Build/Remodel | $56 |
| 43 | Install fan | 9 | ✅ | Install fan | Google | $199 |
| 44 | Friends & Family | 9 | ❌ Gap | — | — | — |
| 45 | Repair panel | 9 | ✅ | Repair panel | Google | $699 |
| 46 | Hang Flat Panel TV (in-wall wiring) | 9 | ✅ | Hang Flat Panel TV (in-wall wiring) | Install | $319 |
| 47 | Repair light fixtures | 9 | ✅ | Repair light fixtures | Google | $149 |
| 48 | Replace Chandelier (15'-19') | 8 | ✅ | Replace Chandelier (15'-19') | Install | $359 |
| 49 | Replace Smoke Detector (Up to 12') | 8 | ✅ | Replace Smoke Detector (Up to 12') | Install | $69 |
| 50 | 15/20a Home Runs (up to 150') | 8 | ✅ | 15/20a Home Runs (up to 150') | New Build/Remodel | $320 |

**Match Summary (Top 50):** ✅ Exact 40 (80%) · ⚠️ Case/Fuzzy 5 (10%) · ❌ Gap 5 (10%)

---

### A3. Top Gaps (used 3+ times, no pricebook match)

| Description | Jobs | Category Suggestion | Notes |
|-------------|------|---------------------|-------|
| Fixed Gratuity | 34 | Fees & Adjustments | Tip/gratuity line; 7 naming variants in use |
| 3/4" EMT | 14 | Conduit — Materials | Per-foot material; conduit range skips 3/4" |
| 3/4" PVC Schedule 40 | 10 | Conduit — Materials | Per-foot material; same size gap as EMT |
| Friends & Family | 9 | Fees & Adjustments | Discount line; also "Family & Friends," "Friends And Family" |
| #10 AWG THHN Stranded Wire | 7 | Wire & Cable — Materials | Missing gauge between #12 and #6 |
| 1" EMT Conduit | 7 | Conduit — Materials | Per-foot; not in current pricebook |
| New Customer / Repeat Customer | 7 | Fees & Adjustments | Customer segment discount; several naming variants |
| Discount | 7 | Fees & Adjustments | Generic discount; no unified structure in pricebook |
| State Sales Tax (material) | 6 | — | Should be system-managed, not a pricebook line |
| 1" PVC Schedule 40 | 6 | Conduit — Materials | Per-foot; not in current pricebook |
| Miscellaneous Material | 6 | — | Exists in pricebook but undefined/unpriced |
| 12 Gauge THHN Wire | 5 | Wire & Cable — Materials | Specific wire sold per-foot |
| 6/3 Stranded Romex | 4 | Wire & Cable — Materials | No Romex variants in pricebook |
| 2/0 AWG THHN CU | 4 | Wire & Cable — Materials | No #2/0 in pricebook |
| Return Customer | 4 | Fees & Adjustments | Duplicate of Repeat Customer concept |
| 12/2 Romex | 3 | Wire & Cable — Materials | Most common residential cable; missing |
| #4 AWG THHN CU | 3 | Wire & Cable — Materials | High-amperage circuit wire; missing |

**Gap themes:**
- **Conduit/Wire materials** — biggest gap; no per-foot pricing for common sizes (3/4" EMT, 3/4" PVC, 1" EMT, 1" PVC, #10 THHN, #4 THHN, 12/2 Romex, 6/3 Romex). These are billed individually on jobs today with ad-hoc descriptions.
- **Discounts/adjustments** — no unified structure; "Fixed Gratuity," "Friends & Family," "Repeat Customer," "Discount" all exist as one-off estimate lines with no pricebook backing.
- **Tax** — State Sales Tax is appearing as an estimate line item; should be handled in HCP settings, not the pricebook.

---

### A4. Naming Violations in Current Pricebook

Rules: Title Case · amperage as "200A" not "200 amp" · per-foot items end ", per ft" · wire gauge "#12 THHN" or "12/2 Romex" · no abbreviations

| Current Name | Violation | Suggested Fix |
|---|---|---|
| 200 amp Main Breaker | "amp" not "A"; not Title Case | 200A Main Breaker |
| Install 100 amp disconnect | "amp" not "A"; lowercase words | Install 100A Disconnect |
| Smart door bell installation | Lowercase words | Smart Doorbell Installation |
| Install outlets or switches | Lowercase | Install Outlets or Switches |
| Relocate outlets or switches | Lowercase | Relocate Outlets or Switches |
| Repair outlets or switches | Lowercase | Repair Outlets or Switches |
| Upgrade 200a service to 400a(underground) | "a" not "A"; spacing | Upgrade 200A Service to 400A (Underground) |
| Install dryer plug | Lowercase | Install Dryer Plug |
| Install Led flat panel | "Led" not "LED"; lowercase | Install LED Flat Panel |
| Replace Light Fixture (owner provided fixture) | Redundant "fixture"; lowercase "provided" | Replace Light Fixture (Owner Provided) |
| Install ground wire | Lowercase | Install Ground Wire |
| Install light fixtures | Lowercase | Install Light Fixtures |
| Install outdoor lighting | Lowercase | Install Outdoor Lighting |
| Install security system | Lowercase | Install Security System |
| Repair light fixtures | Lowercase | Repair Light Fixtures |
| Aluminum wiring removal | Lowercase | Remove Aluminum Wiring |
| Change 2 Gang to 3 Gang Box and Add Switchleg | Lowercase conjunctions | Change 2-Gang to 3-Gang Box and Add Switchleg |
| Change Toggle 3-Way Switch to Decora 3-Way Switch (11 and more) | Lowercase; "(11 and more)" verbose | Change Toggle 3-Way Switch to Decora 3-Way Switch (11+ Items) |
| Change Toggle Device to Decora Device (41 and more) | Same | Change Toggle Device to Decora Device (41+ Items) |
| Recenter can light in room | All lowercase | Recenter Can Light in Room |
| test | Placeholder; should be deleted | DELETE |

**Estimated total violations:** 112+ items (46% of pricebook) — most are lowercase articles/conjunctions ("to," "and," "or") that slipped through on item creation.

---

### A5. Category Issues

#### Issue 1 — "Install" is a 87-item catch-all (36% of pricebook)

Spans $50 assembly labor to $6,999 specialty systems. Semantic matching against this category fails because everything is in it.

**Proposed split:**
- **Install — Receptacles & Switches** (~18 items)
- **Install — Lighting** (~25 items)
- **Install — Panel & Circuits** (~12 items)
- **Install — Specialty Systems** (~12 items, EV/HVAC/spa)
- Items currently labeled Install but actually materials → move to **Conduit — Materials** / **Wire & Cable — Materials**

#### Issue 2 — "Google" category (16 items) duplicates Install at inconsistent prices

| Item | Install Price | Google Price |
|------|-------------|-------------|
| Repair Light Fixture | $59 | $149 (+152%) |
| Install fan | $199 | $199 (same) |
| Install light fixtures | — | $119 |
| Install Electric Car Charger | $599 | $499 (−17%) |
| Install outlets or switches | — | $89 |

5+ near-identical items at different prices, plus 5 $0 placeholders. Recommend: consolidate everything into canonical Install subcategories and delete this category.

#### Issue 3 — Duplicate panel categories

"Panel/Service" (9 items — hardware fittings) and "Service Entrance and Panel" (14 items — labor + major hardware) overlap. Merge into **Panel & Service**.

#### Issue 4 — Zero-priced placeholders (14 items)

Keep at $0: Job Walk variants, Custom Job, Credit Card Fee (pass-throughs). Delete or price: "test," Google $0 items (Install security system, Other, Remodeling, Replace or upgrade panel, Restore power), Spa circuit.

---

### A6. Action List

**CRITICAL — do first (blocking Tasks 4–6):**

1. Delete "test" item; delete or price Google $0 placeholders
2. Merge "Panel/Service" into "Service Entrance and Panel" → rename **Panel & Service**
3. Decide fate of "Google" category (recommend: consolidate to Install subcategories, delete)
4. Create **Conduit — Materials** category with per-foot entries (3/4" EMT, 3/4" PVC, 1" EMT, 1" PVC — these 4 alone cover 37 jobs with no match)
5. Create **Wire & Cable — Materials** category with per-foot entries (#10 THHN, #4 THHN, 12/2 Romex, 6/3 Romex, 2/0 THHN)
6. Create **Fees & Adjustments** category (Fixed Gratuity, Friends & Family, Repeat Customer, Discount)
7. Remove or system-configure "State Sales Tax (material)" — not a pricebook item

**HIGH PRIORITY — within 1–2 weeks:**

8. Run naming validation script (`npm run validate-pricebook`) and fix all 112+ violations
9. Split Install category into 4–5 subcategories (Items 1–5 above + Install — Specialty)
10. Consolidate duplicate entries between Install and Google before renaming

**MEDIUM PRIORITY:**

11. Merge "Generator Equipment" + "Generator Install Items" → **Generator Systems**
12. Merge "Ethernet and Data" + "Security Camera Systems" → **Data & Security**
13. Merge "Devices" + "Fixtures" + "Outdoor Devices" → review; may keep split by indoor/outdoor
14. Rename "Permit and Licensing" → "Permits & Inspections"

---

### A6. Metrics Summary

| Metric | Current | Target |
|--------|---------|--------|
| Total items | 243 | ~220 after dedup |
| Install category share | 87 items (36%) | <20 per subcategory |
| Duplicate/catch-all categories | 3 | 0 |
| Zero-priced placeholders | 14 | <5 (pass-throughs only) |
| Top-50 match rate | 90% (5 gaps) | 100% |
| Naming violations | 112+ (46%) | 0 |
| Material gap items (3+ jobs unmatched) | 17 | 0 |
| Discount/adjustment line items | 0 | 6–8 |
