# Grizzly Electrical Solutions — Standard Operating Procedures

Reference for Maverick when scoping jobs, writing estimates, and answering tech questions.
All work follows NEC 2020 as adopted in Texas.

---

## Default Materials (Grizzly Standards)

- **Panels**: Eaton BR series (see eaton-br-reference.md)
- **Devices**: Leviton Decora (white, standard residential)
- **Wire**: Copper for all branch circuits; aluminum ONLY for service entrance (SER/SE cable)
- **Conduit**: EMT in exposed locations (garages, attics with conduit runs); Romex (NM-B) in walls
- **Panel wire labels**: Brady or Panduit adhesive labels — label every circuit at the panel

---

## SOP 1: Panel Upgrade (100A → 200A)

### Scope triggers
- Customer has 100A service and wants EV charger, large addition, or load calculation shows inadequate capacity
- Existing panel is full (no open slots)
- Existing panel is Zinsco, Federal Pacific (FPE), or split-bus — recommend full replacement regardless of amperage

### Steps

1. **Pre-job**
   - Confirm Oncor meter socket is 200A rated (most are in DFW; check for 2-jaw vs 4-jaw socket)
   - If meter socket is 100A only, scope includes meter base replacement (Oncor work + electrician)
   - Pull city electrical permit before scheduling work
   - Submit Oncor service upgrade request — get work order number; schedule meter pull

2. **Day of install**
   - Kill main breaker, confirm Oncor has pulled meter (do NOT work on service entrance with meter installed)
   - Remove old panel; photograph existing circuit-to-breaker mapping before disconnecting
   - Install new Eaton BR200 (or BR2040) 200A panel in same location or better location (near point of entry preferred)
   - Install 200A main breaker (comes in panel or order BR2200)
   - Install 4-wire service entrance: hot-hot-neutral-ground from weatherhead through meter base to panel
   - **Bond neutral and ground bars at main panel** (they share a bar or the bonding screw must be installed)
   - Reconnect all existing circuits; update wire gauge if any are undersized for their breaker
   - Torque all lug connections:
     - **200A main lug (AL wire)**: 125 in-lb (check lug label — always follow manufacturer spec)
     - **Branch circuit lugs (copper)**: 35 in-lb for #14–#10 AWG
   - Fill out breaker directory completely

3. **Inspection**
   - Schedule rough-in inspection with city (if required by AHJ — some require rough-in before closing wall)
   - Schedule service/final inspection
   - Oncor reinstalls meter after city green tag

4. **Common gotchas**
   - Old house with 60A or meter base pull-out style: scope meter base replacement separately, budget extra time
   - Aluminum wiring on branch circuits: flag to customer; out of scope for panel upgrade SOP; recommend anti-oxidant compound (NoAlox) on all Al connections if touched

---

## SOP 2: EV Charger Install (Level 2, 240V)

### Scope triggers
- Customer has EV and wants Level 2 charging (typically 32–48A charging = 40–60A breaker)
- Tesla, Rivian, Ford, GM, Stellantis vehicles all use J1772 or NACS — Grizzly installs the circuit; customer's charger connects to it

### Standard spec (most residential)
- **Circuit**: 240V, 50A dedicated circuit
- **Wire**: 6 AWG copper, 3-wire + ground (or 4-wire if NEMA 14-50 outlet)
- **Breaker**: 50A 2-pole (BR250) — NEC 625.41 requires breaker at 125% of nameplate; most Level 2 chargers are 40A continuous → 50A breaker
- **Termination**: NEMA 14-50 outlet (most universal) or hardwired to charger (Tesla Wall Connector, ChargePoint Home Flex)

### Steps

1. **Pre-job**
   - Confirm panel has a free double-pole slot (or scope includes tandem + evaluation)
   - Run load calculation: confirm 50A available headroom (rule of thumb: 200A service with ≤150A of existing load is fine)
   - Measure wire run from panel to garage — price 6 AWG NM or EMT accordingly

2. **Install**
   - Install BR250 in panel
   - Run 6 AWG copper from panel to garage/parking location
   - In garage: install surface-mount box with NEMA 14-50 outlet, or mount charger directly if hardwiring
   - If hardwired: connect charger per manufacturer instructions; no outlet needed
   - If NEMA 14-50: install weatherproof outlet if exterior or damp location

3. **Permit**
   - New 240V circuit requires permit in all DFW cities
   - Inspection: final only (no rough-in required for surface-run EMT in most cities)

4. **Common gotchas**
   - Customer says "I just want a 30A circuit to save money": educate on future-proofing; 50A is the right call for most EVs
   - Panel is full: price tandem for one circuit or scope panel upgrade if multiple circuits needed
   - Long run (>100 ft): check voltage drop; may need to upsize to 4 AWG for runs over 100 ft at 50A

---

## SOP 3: GFCI / AFCI Upgrade

### NEC 2020 Requirements
- **AFCI**: Bedrooms, living rooms, dining rooms, family rooms, closets, hallways, laundry areas — all 120V circuits in these spaces
- **GFCI**: Kitchens (countertop), bathrooms, garages, outdoor, crawl spaces, unfinished basements, within 6 ft of any sink
- **Dual Function (AFCI+GFCI)**: Use BR120DF where both apply (e.g., kitchen countertop circuit, which needs both)

### Upgrade options (in order of preference)

1. **Breaker-level**: Install AFCI or GFCI breaker at panel (BR115AF, BR120GF, BR120DF)
   - Protects entire circuit
   - More expensive per breaker (~$40–70) but cleaner install
   - Required for circuits where first device is not accessible

2. **Outlet-level**: Install GFCI outlet at first device in circuit; other outlets downstream are protected by "LOAD" terminals
   - Cheaper for GFCI-only upgrades
   - Does NOT satisfy AFCI requirement

3. **Combination**: AFCI breaker at panel + GFCI outlet at wet location (belt-and-suspenders; some inspectors prefer it)

### Steps
- For AFCI breaker install: swap standard breaker for AFCI breaker; connect the white pigtail from breaker to neutral bar
- For GFCI outlet: install at first outlet in the circuit; connect downstream outlets to LOAD terminals; test with TEST button

---

## SOP 4: New Circuit

### Wire gauge by breaker size (NEC 310.12)
| Breaker | Min Wire Gauge (Copper) | Common Use |
|---------|------------------------|-----------|
| 15A | 14 AWG | Lighting, general outlets |
| 20A | 12 AWG | Kitchen countertop, bathroom, garage outlets |
| 30A | 10 AWG | Dryer, water heater, small AC |
| 40A | 8 AWG | Range, larger AC |
| 50A | 6 AWG | EV charger, large range |
| 60A | 4 AWG | Hot tub, large subpanel feed |

### Steps

1. **Load calc**: confirm panel has capacity; check main breaker rating and existing load
2. **Find a slot**: open slot in panel for a full-size breaker, or tandem if panel is full (check tandem rules)
3. **Run wire**: NM-B in walls; EMT in exposed locations (garages, attics, basements)
4. **Install breaker**: match amperage to wire gauge
5. **Label**: label breaker in directory; mark wire at both ends with circuit number
6. **Permit**: pull permit for any new circuit; schedule final inspection

---

## SOP 5: Service Entrance

### SE vs SER Cable
- **SE cable** (Service Entrance): 2-wire + bare neutral; used for older 3-wire service; avoid on new installs
- **SER cable** (Service Entrance Round): 3 conductors + ground; correct for modern 4-wire service
- Aluminum conductor is acceptable (and standard) for service entrance under NEC 230; do NOT use aluminum for branch circuits
- Common size: 2/0-2/0-1/0 AL SER for 200A service

### Weatherhead and Mast
- Mast must extend minimum 3 ft above roofline (Oncor requirement for clearance)
- Weatherhead opening must point down to prevent water entry
- Inspect for damage, rust, or loose straps on every service entrance job — replace if any doubt
- Drip loop required at service drop to weatherhead

### Steps

1. Pull permit + Oncor work order (meter pull required)
2. Install new weatherhead/mast if needed; secure mast with approved straps
3. Run SER cable from weatherhead down exterior to meter base, then to main panel
4. Land neutral and hots at meter base terminals; ground to panel
5. Bond neutral at main panel (one location only — NEC 250.24(A))
6. Inspection: rough-in (if any penetrations need inspection) → service inspection → Oncor meter reinstall

---

## Estimating Rules of Thumb (for Maverick Scoping)

| Job Type | Labor Hours (rough) | Notes |
|----------|--------------------|----- |
| Panel upgrade 100→200A | 6–10 hrs | Add 2 hrs if meter base replacement needed |
| EV charger (simple garage run) | 2–4 hrs | Add if long conduit run or panel work needed |
| New circuit (single room) | 2–3 hrs | Depends on wire run distance |
| GFCI/AFCI breaker swap | 0.5 hr each | Quick if panel is accessible |
| Service entrance replacement | 4–6 hrs | More if mast replacement or mast raise |
| Subpanel install (garage) | 4–6 hrs | Includes feeder from main |

Always add permit fee as a line item. Current range in DFW: $75–$250 depending on city and scope.
