# Add Price Book Item

Create a new item in Grizzly's HCP price book from a natural language description.

## When to invoke

Use when Carter says something like:
- "add [item] to the price book at $[price]"
- "create a price book item for [thing]"
- "save [item] as $[price] labor/materials"

## Workflow

### 1. Parse the request

Extract from Carter's message:
- `name` — short, clear item name (e.g. "20A Circuit Breaker Install")
- `price` — unit price in dollars (ask if missing)
- `kind` — `labor` or `materials` (infer from name; ask only if ambiguous — physical parts/supplies = materials, install labor = labor)
- `unit` — unit of measure (default: `Each`; use "Per Foot", "Per Hour", etc. when appropriate)
- `category` — optional; infer from context (see category lists below)
- `part-number` — optional SKU/part number (materials only)

### 2. Ask clarifying questions if needed

**For services (labor/combined):**
- What exactly is included (parts? labor? both)?
- Any scope limits (max footage, ceiling height, panel size, etc.)?
- What's explicitly NOT included?
- Residential, commercial, or both?
- Any conditions (existing circuit required? open wall access? owner-supplied fixture?)?

**For materials:**
- Part number / SKU if Carter has it (optional — saves lookup time)
- Which material category it belongs to (if ambiguous)

Ask only if not clear from context. For simple items, make reasonable assumptions and proceed.

### 3. Generate the description

**Services:** Trade-accurate, in Grizzly's voice:
- **Specific** — state exactly what's included: parts, materials, wire runs, breakers, boxes, labor
- **Scope-bounded** — call out limits (e.g. "up to 50'", "up to 12' ceiling", "single pole up to 30A")
- **Exclusions** — mention what's NOT included when it matters
- **Residential vs commercial** — note when relevant
- **No fluff** — no "our expert technicians will..." filler
- **2-4 sentences** for most items; more if scope is complex

Good service examples:
> Install new 15amp or 20amp circuit up to 50' away from panel. Includes breaker, wire, box, duplex receptacle and labor to run new circuit and install box and receptacle.

> Remove and replace old recessed light fixture and install new LED wafer light (retrofit or pop-in). Includes LED fixture and labor to install fixture.

> Remove current switch and/or receptacle and replace with new switch/receptacle and face plate. Does not include dimmers.

> Replace non-working single pole breaker with new breaker up to 30 amps. (does not include GFCI/AFCI breakers)

**Materials:** Cover specs that matter for install — voltage rating, ampacity, size, brand/series, compatibility. 1-3 sentences. Don't describe labor — this is just the part.

Good material examples:
> 12/2 NM-B Romex with ground, copper conductor, rated for 20A circuits. Suitable for residential branch circuit wiring in dry locations.

> Square D QO 200A main breaker load center, indoor, 40-space 80-circuit. Compatible with QO-series breakers.

Show Carter the generated description and ask for approval before creating the item.

### 4. Check for duplicates

Before creating, search the local price book:

```bash
grep -i "<key terms from name>" data/pricebook.csv
```

If a close match exists, show it and ask if Carter wants to create a new item anyway.

### 5. Create the item

Once Carter approves:

**Service (labor or combined labor+material):**
```bash
npm run add-item -- --name "<name>" --price <price> --kind labor --desc "<approved description>" [--unit <unit>] [--category "<category>"]
```

**Material (physical part, supply item):**
```bash
npm run add-item -- --name "<name>" --price <price> --kind materials --desc "<approved description>" [--unit <unit>] [--category "<category>"] [--part-number "<SKU>"]
```

**Service categories** (for `--category`):
Custom, Electrical, Lighting, Panel/Service, Low Voltage, Generator, EV Charging, HVAC, Other

**Material categories** (for `--category`):
Devices, Fixtures, Wire, Conduit, Panel/Service, Disconnects, Boxes/Enclosures, Outdoor Devices, Generator Equipment, Tools/Equipment, Security Camera Systems, Miscellaneous Material

### 6. Confirm

Report back:
- The HCP UUID assigned (`olit_...` for services, `pbmat_...` for materials)
- The final name, price, and description that was saved
- That the local pricebook.csv was updated and item was indexed in RAG

## Examples

Carter: "add 200A panel upgrade to price book at $2800 labor"
→ Ask: new or replace? permits included? meter base included?
→ Generate description, show Carter
→ On approval: `npm run add-item -- --name "200A Panel Upgrade" --price 2800 --kind labor --desc "..." --category "Panel/Service"`

Carter: "WAP install commercial with device, $389"
→ No clarifying questions needed
→ Generate: "Supply and install one wireless access point in commercial space. Includes WAP device, mounting hardware, and all labor. Cat6 run up to 50'. Does not include patch panel termination or network switch configuration."
→ Show Carter, get approval
→ `npm run add-item -- --name "WAP Install - Commercial" --price 389 --kind labor --desc "..."`

Carter: "add 12/2 Romex to materials at $1.25 per foot"
→ No clarifying questions needed
→ Generate: "12/2 NM-B Romex with ground, copper conductor, rated for 20A circuits. Suitable for residential branch circuit wiring in dry locations."
→ Show Carter, get approval
→ `npm run add-item -- --name "12/2 Romex" --price 1.25 --kind materials --unit "Per Foot" --category "Wire" --desc "..."`

Carter: "add 200A Square D QO load center to materials, $485"
→ Ask: indoor or outdoor? main breaker included?
→ Generate spec description
→ `npm run add-item -- --name "200A Square D QO Load Center" --price 485 --kind materials --category "Panel/Service" --desc "..."`

Carter: "AFCI breaker install $85 labor"
→ `npm run add-item -- --name "AFCI Breaker Install" --price 85 --kind labor --desc "..."`

## Error handling

If the command fails with a 404 or 422 from HCP, the API endpoint may need to be updated.
Tell Carter to run `npm run intercept`, manually add that type of item in HCP, then close the browser.
The correct endpoint will appear in `data/hcp-api-calls.json` — report it so the code can be fixed.
