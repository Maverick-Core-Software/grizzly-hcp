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
