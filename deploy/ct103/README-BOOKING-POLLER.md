# CT103 — Booking Approval Poller (Phase 2 cutover)

> **Prep only until Phase 1 gate passes.** These files are deploy *artifacts*.
> Do **not** install, enable, or start on a live host from this document without
> explicit cutover approval. Do **not** dual-run PC PM2 and CT103 systemd.

**Host:** CT103 `mcc-prod` (192.168.1.15)  
**Unit:** `booking-approval-poller.service`  
**Source (this repo):** `deploy/ct103/`  
**Plan ref:** `C:\Workspace\Infrastructure\NIGHT-SHIFT-MOVES-PLAN.md` Phase 2

---

## 1. Path conventions (locked for this unit)

| Item | Path |
|------|------|
| App checkout / `WorkingDirectory` | **`/opt/grizzly-hcp`** |
| Pending + template data | `/opt/grizzly-hcp/data/pending-bookings.jsonl` |
| Schedule payload template | `/opt/grizzly-hcp/data/schedule-payload-template.json` |
| Environment file | **`/etc/maverick-integrations/booking-poller.env`** |
| systemd unit install | `/etc/systemd/system/booking-approval-poller.service` |

**Why `/opt/grizzly-hcp` (not `/opt/maverick-integrations/services/grizzly-hcp`):**  
existing grizzly-hcp docs and AIWA-era plans already use `/opt/grizzly-hcp`. One install root avoids split brains for `process.cwd()`-relative `data/*` paths in `approval-poller.ts` / `from-voice.ts`.

The poller resolves:

```text
path.resolve(process.cwd(), 'data/pending-bookings.jsonl')
```

So **cwd must be the install root**, and writers that append pending rows must share that same file (or a bind-mount/shared store pointed at the same path).

---

## 2. What this unit runs

- **Process:** long-lived Node via vendored `tsx` CLI (same as PC PM2 `ecosystem.config.cjs`)
- **Script:** `src/automations/bookings/approval-poller.ts`
- **Behavior:** every `BOOKING_POLL_INTERVAL_MS`, scan pending rows with `status=pending`:
  1. **HCP notes** via MCP (`get_job_notes`) — note matching `SCHEDULE …`
  2. **Ops SMS** — recent inbound Twilio messages on `OPS_SMS_FROM` from `OPS_SMS_TO` matching  
     `SCHEDULE <estimateId> MM/DD h:mm am - h:mm pm` (or without id if only one pending)
  On match: `update_job_schedule` with numeric `CARTER_PRO_ID` / `JAIME_PRO_ID`, mark row
  `scheduled`, confirmation estimate note + ops SMS ack. Seen SMS SIDs:
  `data/ops-sms-schedule-seen.json`
- **Also needs in env (ops SMS path):** `OPS_SMS_FROM`, `OPS_SMS_TO`,
  `OPS_TWILIO_ACCOUNT_SID` / `OPS_TWILIO_AUTH_TOKEN` (or shared Twilio SID/token). Never set
  `OPS_SMS_FROM` equal to the customer `TWILIO_PHONE_NUMBER`.
- **TZ:** `America/Chicago` (unit `Environment=` + env file). Required for local-offset ISO timestamps

**Dual-run risk:** two pollers = double schedule. Never run PC PM2 `booking-approval-poller` and this unit at the same time against the same pending set / same estimates.

---

## 3. Install prep (files only — no start)

On CT103 (Orca only when applying for real):

1. Checkout / rsync grizzly-hcp runtime to `/opt/grizzly-hcp` (`npm ci --omit=dev` or equivalent so `node_modules/tsx` exists).
2. `mkdir -p /etc/maverick-integrations /opt/grizzly-hcp/data`
3. Copy `booking-poller.env.example` → `/etc/maverick-integrations/booking-poller.env`, fill secrets, `chmod 600`.
4. Copy `booking-approval-poller.service` → `/etc/systemd/system/`
5. `systemctl daemon-reload`
6. Confirm: `node --version` (20+), `test -x /usr/bin/node`, MCP reachable from CT103 to CT102 `:7332`
7. **Leave unit disabled/stopped** until cutover step 4.

Do not `systemctl enable --now` until PC poller is stopped.

---

## 4. Cutover steps (Phase 2) — never dual-run

Preferred order from the night-shift plan: **stop PC first, then start CT103**, ideally while no open `pending` rows (or freeze writers briefly).

### 4.1 Pre-flight

- [ ] Phase 1 acceptance recorded (poller healthy; ideally one live `SCHEDULE`→`scheduled` smoke on PC).
- [ ] CT103 unit installed but **inactive**: `systemctl is-active booking-approval-poller` → `inactive`
- [ ] PC PM2 still sole owner: `pm2 describe booking-approval-poller`
- [ ] Snapshot pending file for rollback:
  - PC: copy `data/pending-bookings.jsonl` and `data/schedule-payload-template.json` to a dated backup dir
- [ ] Note any open `status: pending` rows (move or freeze writers if needed)

### 4.2 Freeze writers (if voice still booking)

If `voice-server` / `from-voice` still runs on the PC and will keep appending pending rows, either:

- pause voice briefly (1–2 min), **or**
- accept that after cutover writers **must** write the CT103 pending file (see §6)

### 4.3 Stop PC poller (sole scheduler off)

On PC (elevated PM2 as used in prod):

```text
pm2 stop booking-approval-poller
pm2 save
```

Confirm **stopped**. Do not start CT103 until this is verified.

### 4.4 Copy shared state to CT103

Copy from PC grizzly-hcp (or last backup) onto CT103:

| File | Destination on CT103 |
|------|----------------------|
| `data/pending-bookings.jsonl` | `/opt/grizzly-hcp/data/pending-bookings.jsonl` |
| `data/schedule-payload-template.json` | `/opt/grizzly-hcp/data/schedule-payload-template.json` |

Preserve content exactly (jsonl line order / statuses). Take a second backup of the files as landed on CT103 before starting the unit.

### 4.5 Start CT103 poller only

```text
systemctl enable booking-approval-poller.service
systemctl start booking-approval-poller.service
systemctl status booking-approval-poller.service
journalctl -u booking-approval-poller -n 50 --no-pager
```

Expect a startup line like: `[poller] Booking approval poller started — every …s, pros: 2`.

### 4.6 Smoke

- Inject or use one test pending + operator `SCHEDULE …` note (not inside a `MAVERICK` template note).
- Confirm row → `scheduled` and HCP appointment; single scheduler only.

### 4.7 Point writers at the same pending file

If `from-voice` (or chat estimate path) remains on PC after the poller moves, those processes **must not** keep writing a PC-local `data/pending-bookings.jsonl` that CT103 never sees. Options:

1. **Preferred:** move/run writers on CT103 with the same `/opt/grizzly-hcp` cwd, **or**
2. Shared durable path (NFS/SMB/bind) mounted so both hosts resolve the **same** pending file, **or**
3. Freeze PC writers until voice cutover (Phase 3)

Until one of those is true, new voice bookings will not be scheduled by CT103.

---

## 5. Rollback

Goal: sole scheduler back on PC; no dual-run during rollback either.

1. **Stop CT103 first:**

   ```text
   systemctl stop booking-approval-poller.service
   systemctl disable booking-approval-poller.service
   ```

2. **Restore pending file on PC** from the pre-cutover backup (or copy CT103’s file back if it advanced state and you want to keep those updates — pick one source of truth).

3. **Start PC PM2 only:**

   ```text
   pm2 start booking-approval-poller
   # or: pm2 start ecosystem.config.cjs --only booking-approval-poller
   pm2 save
   ```

4. Confirm PC logs tick; CT103 unit inactive; only one poller exists.

5. Re-point writers to the PC pending path if they were switched.

---

## 6. Writers note (from-voice still on PC)

`from-voice.ts` appends to `data/pending-bookings.jsonl` under **its** `process.cwd()`. The poller only reads the file under **its** cwd.

| Phase | Poller | Voice / from-voice | pending file |
|-------|--------|--------------------|--------------|
| Today | PC PM2 | PC | PC `…/grizzly-hcp/data/pending-bookings.jsonl` |
| Phase 2 only | CT103 | PC (still) | **Must share** — see §4.7 — or voice must not create new pendings |
| Phase 3 | CT103 | CT103 | `/opt/grizzly-hcp/data/pending-bookings.jsonl` only |

Customer SMS (`hermes-customer-sms`) does **not** use this pending file / poller path.

---

## 7. Safety checklist

- [ ] Never dual-run PC + CT103 poller
- [ ] Stop PC → copy data → start CT103 (or reverse only with empty pending + frozen writers)
- [ ] Secrets: env **names** in logs only
- [ ] Orca only for CT103 apply (no ad-hoc agent SSH)
- [ ] `TZ=America/Chicago`
- [ ] Rollback ref: pending file backup + prior PM2/systemd state

---

## 8. Files in this directory

| File | Purpose |
|------|---------|
| `booking-approval-poller.service` | systemd unit (`Type=simple`, `Restart=always`) |
| `booking-poller.env.example` | env names for `/etc/maverick-integrations/booking-poller.env` |
| `README-BOOKING-POLLER.md` | this cutover / rollback runbook |
