# Maverick v1 — Full System Test Results

| Field | Value |
|---|---|
| Tester | Claude (Opus 4.8) driving, Carter supervising |
| Date/time | 2026-06-21 |
| Environment | Production (no staging — live HCP/RAG/PM2) |
| Test data prefix | `[MAV TEST - DELETE]` |
| Test customer | `ZZ MAV TEST` / `mavtest@example.com` |
| Blueprint classification | **P1** — tested ✅ with online DWG fixture; 2 import/converter bugs found & fixed (F6, F7) |
| Cleanup | Claude auto-cleans HCP/email; Carter deletes live GBP/FB posts AM 6/22 |

Legend: ✅ pass · ❌ fail · ⚠️ pass-with-note · ⏭️ deferred/needs-human · ⬜ not yet run

---

## PASS 1 — P0 Launch Gate

### Pre-Test: Infrastructure Smoke
| Check | Sev | Result | Evidence |
|---|---|---|---|
| `mav-console` online, no restart loop | P0 | ⚠️ | online, uptime 98m, **unstable_restarts=0**; 48 cumulative restarts over days (manual redeploys + a few `Repo bridge action timed out` / `No pending prompt` BUILD-mode errors). Not a crash loop. |
| `mav-email-watcher` online | P0 | ✅ | online, 11 restarts |
| `mav-assistant` online | P0 | ✅ | online, 11 restarts, port 3012 serves HTML |
| `mav-bridge` online | P0 | ✅ | online, 10 restarts |
| Proxmox RAG `/health` | P0 | ✅ | HTTP 200 `{"status":"ok"}` |
| Prometheus `/-/healthy` | P1 | ✅ | HTTP 200 "Prometheus Server is Healthy" |
| llama.cpp port 8080 | P1 | ⚠️ | HTTP 200 on **localhost**:8080 (qwen3-14b), NOT Proxmox:8080. Plan host was ambiguous; model serves locally on CartersPC (RTX 4060 Ti). |
| HCP session valid (customer search) | P0 | ✅ | raw GET `/alpha/customers` → 200, rows returned. Session live. |
| `.env` has CARTER_TECH_ID, JAIME_TECH_ID, ANTHROPIC_API_KEY | P0 | ✅ | all three present (+ HCP_*, RAG_*) |

Note: `npm run templates` returns "No templates found" — confirmed genuine (no saved HCP estimate templates), not an auth failure.

### Grizzly-HCP — from-chat.ts
| Check | Sev | Result | Evidence |
|---|---|---|---|
| No scope → `{success:false,error:"No scope provided."}` | P0 | ✅ | exact match |
| `[progress]` on stderr throughout | P0 | ✅ | 8 progress lines (search→create→estimate→extract→match→assign→done) |
| stdout `{success:true, estimateUrl}` | P0 | ✅ | `est_a292b2ebadd041ffad79088c757d505b` |
| HCP estimate w/ line items + Carter + Jaime | P0 | ✅ | verified via `/api/estimates`: customer=ZZ MAV TEST, 1 line item, assigned_pros=2 |

### Grizzly-HCP — from-email.ts
| Check | Sev | Result | Evidence |
|---|---|---|---|
| stdout `{success:true, estimateUrl}` | P0 | ✅ | `est_cc2e115feb0f44b3b11d72a01d3b19e9` |
| HCP estimate w/ garage-circuit line items | P0 | ⚠️ | line item present but **$0** (no pricebook match); customer=ZZ MAV TEST, assigned_pros=2 |

**Findings (Phase 1):**
- **F1 (P1, regression):** `from-email.ts` ignores the `scope` field — extracts from `body` instead (line 177). The email-watcher's RAG-generated scope is discarded. Confirmed a fidelity regression vs prior code (see Email Watcher section below).
- **F2 (P1):** No-pricebook-match → **$0 line item** silently created, AND a new $0 item auto-saved to the live HCP pricebook (`olit_582749a274154be1b02ce5d08c5b1365`). An estimate with $0 lines isn't customer-usable; combined service names ("3 dedicated 20A circuits") don't match per-unit pricebook entries.
- **F3 (P2):** `from-chat` matched "200A Panel Upgrade" → "200A Panel Enclosure" (material, $3199) at 68% — loose semantic match; a panel *upgrade* is a labor+materials service, not just the enclosure.

**Cleanup artifacts so far:** est_a292…, est_cc2e…, customer `ZZ MAV TEST`, pricebook item `olit_582749a274154be1b02ce5d08c5b1365`.

### Email Watcher — live end-to-end (gmail-multi → classify → RAG → from-email → HCP)
| Check | Sev | Result | Evidence |
|---|---|---|---|
| gmail-multi reachable, `/search` live | P0 | ✅ | Service on **localhost:8001** (not 8000). `/search/grizzly1` → 200 w/ unread mail. Routes incl. `/send`, `/reply`, `/email`. |
| Stale 404s in error.log are dead history | P0 | ✅ | 404s reference `max_results=20` + default port 8000; current code uses `max_results=50` + `GMAIL_MULTI_URL=8001`. Live polls succeed. |
| Estimate email → `classification: estimate_request` | P0 | ✅ | self-sent grizzly1→grizzly2 (`carterbarns@`→`contactus@`, both internal). |
| Non-estimate email → `classification: ignore → skip` | P0 | ✅ | "Re: thanks for the visit" correctly skipped, no estimate created. |
| RAG scope generated | P0 | ✅ | `scope: 1256 chars` |
| from-email.ts spawned → HCP estimate + techs | P0 | ✅ | `est_f32c5bcaf7684a678ac2322aee1e43ff`; customer extracted from body (`ZZ MAV TEST mavtest@example.com`); both items matched PB (EV charger 71% @ $599, GFCI 77% @ $149) |
| seen-emails.json updated (crash-safe) | P0 | ✅ | grizzly2 54→56 ids; marked before processing |
| Service restart recovery | P0 | ✅ | `pm2 restart` → clean boot-poll, resumed 5-min loop, did NOT reprocess prior 54 |

### Concurrency / Duplicate Protection
| Check | Sev | Result | Evidence |
|---|---|---|---|
| 2 concurrent from-chat, same existing customer | P0 | ✅ | both `success:true`, both `Found customer: ZZ MAV TEST` (no dup customer), 2 distinct estimates (est_ff8f7bf6…, est_25a02ef5…), no crash |
| Email reprocessing guard | P0 | ✅ | seen-emails mark-before-process (verified above) |

**F4 (P2, latent race):** two concurrent requests for a *brand-new* customer name would both miss `searchCustomer` and double-create the customer (no unique constraint / lock). Not hit in practice (chat reuses existing customers; email path deduped by seen-emails). Low priority.

**F1 upgraded P2 → P1 (functional regression, not just design Q):** the watcher generates a detailed RAG scope (1256 chars) then `from-email.ts:177` **discards it** and re-extracts coarsely from raw `body` (2 items). A stale production log from the prior code version shows `Parsed 12 line item(s) from scope` with full material breakdown (EV charger, spa disconnect, 200A main breaker, 6 AWG cable, boxes…). The current body-extraction path produces ~2 coarse items vs the old scope-path's 12 — a real loss of estimate fidelity. Fix: extract from `scope` (the RAG-enriched text), falling back to `body` only if scope is empty.

### Core API Endpoints
| Check | Sev | Result | Evidence |
|---|---|---|---|
| `GET /health` → 200 ok | P0 | ✅ | "ok" |
| `POST /api/chat` ask → SSE | P0 | ✅ | clean `data:` deltas, `[DONE]` terminator |
| `GET /api/llm/status` | P1 | ✅ | state online, qwen3-14b, ctx 32768 |
| `GET /api/deploy/status` | P1 | ✅ | state ok, deployedAt 2026-06-21T04:39 |
| `GET /api/query?query=up` | P1 | ✅ | Prometheus vector (gpu_exporter etc.) |

### MCC Chat — ASK mode
| Check | Sev | Result | Evidence |
|---|---|---|---|
| ASK "what is a GFCI?" streams RAG electrical context | P0 | ✅ | accurate 2023 NEC 210.8, 6 mA threshold, dwelling/non-dwelling |
| Streaming cursor ▋ blink | P1 | ⏭️ | UI-only — needs browser/Carter |

### MCC Chat — ESTIMATE mode (end-to-end through MCC)
| Check | Sev | Result | Evidence |
|---|---|---|---|
| Switch to ESTIMATE, scope w/ customer | P0 | ✅ | `est_6d3bb659092140e38573406ad15bfaf0`, ZZ MAV TEST, techs assigned |
| Progress lines stream in chat | P0 | ✅ | customer found→created→items→techs |
| Final HCP URL in chat | P0 | ✅ | URL + `[Open in HCP]` link + `[DONE]` |
| No-customer → "Unknown Customer" placeholder | P0 | ✅ | `est_2756dbb3491d4234a0be94ecb044febb` + placeholder created |
| Empty scope → graceful (no crash) | P0 | ⚠️ | server returns JSON `{"error":"Prompt is required."}` (HTTP 4xx), NOT a streamed SSE error. Graceful but not "streamed" per plan wording. |

### Maverick Assistant Proxy (port 3012)
| Check | Sev | Result | Evidence |
|---|---|---|---|
| Only 3 modes: ASK/ESTIMATE/OPERATIONS | P0 | ✅ | `MODES` array in main.jsx:7-9 — exactly these 3 |
| BUILD/SUPERPOWERS unavailable | P0 | ✅ | absent from source |
| ASK streams response | P0 | ✅ | proxied /api/chat → MCC, correct 12 AWG answer |
| ESTIMATE triggers HCP pipeline via MCC | P0 | ✅ | Scenario D: `est_86b88cb45f614cb49ec3973b9e068057` |

---

---

## PASS 2 — P1 Features

### SEO Agents App (mav-bridge :8790)
| Check | Sev | Result | Evidence |
|---|---|---|---|
| `/health` | P1 | ✅ | online, uptime ~40h |
| `/seo/status` | P1 | ⚠️ | responds w/ run history; state=`error` but only fault is `gbp post 2026-06-20 ... not Approved` — i.e. the approval gate **correctly refused** an unapproved post. See F5. |
| `/seo/actions` | P1 | ✅ | `{needs_approval:0, blocked_access:1}` |
| `/seo/posts/week` | P1 | ✅ | full generated week — 7 FB posts w/ hook/body/CTA/video-prompt; content pipeline produces real output |
| `/seo/facebook/pending-prompt` | P1 | ✅ | graceful 404 `{"error":"No pending prompt"}` when none pending |
| Facebook poster `--dry-run --schedule-all` | P1 | ✅ | parsed 7-day schedule, mapped each to `schedule_<date>_09:00`; no browser/video/Supabase side-effects (returns at line 714) |
| **Live Facebook post** (Graph API) | P1 | ✅ | Day 2 photo posted live to real Grizzly page via `/{page}/photos`. **Post id `989322197221009`** — Carter to delete AM 6/22. Token valid, photo upload + schedule parse confirmed. |
| **Live GBP post** (browser automation) | P1 | ✅ | **2026-06-19** "Importance of Electrical Troubleshooting" (Approved row) posted live to Grizzly's Google Business Profile via `driver.mjs --date 2026-06-19`. `{result:"posted", verified:true, verificationAttempts:1}` — confirmed on first verify pass (snapshot `outputs/gbp-debug/verify-attempt-1-2026-06-21T06-53-20Z.png`). `postUrl` null (GBP didn't expose permalink). Browser + Google session + 5×60s verify loop all functional. Standalone driver run does NOT write `Posted=TRUE` back to workbook (that's mav-bridge's job) — row 2026-06-19 still reads Posted=false. Carter to delete AM 6/22. |

### Recovery / Degradation
| Check | Sev | Result | Evidence |
|---|---|---|---|
| Service restart (email-watcher) | P0 | ✅ | clean boot-poll, no reprocessing (above) |
| RAG unreachable → from-chat degrades gracefully | P1 | ✅ | `RAG_URL=dead` → estimate STILL created (est_a731150f…), pricebook matched 100%/67% from **local cache**. from-chat has no hard RAG dep (extraction=Haiku, match=local). |
| RAG dep isolation note | P1 | ⚠️ | Only email-watcher *scope generation* (`/estimate-stream`) hard-depends on RAG; if RAG down, scope-gen fails before from-email runs. from-chat / MCC-estimate path unaffected. |

**F5 (P2):** `/seo/status` reports `state:"error"` when a post is merely awaiting approval ("blocked on approval" is expected, not a fault). Recommend distinguishing `blocked`/`needs_approval` from genuine errors so the dashboard doesn't read red for normal gating.

---

## Cleanup Artifacts (running list)
**HCP estimates (9):** est_a292b2eb…, est_cc2e115f…, est_6d3bb659…, est_2756dbb3…, est_86b88cb4…, est_f32c5bca… (email-watcher), est_ff8f7bf6…, est_25a02ef5… (concurrency), est_a731150f… (RAG-down recovery)
**Test emails (2):** sent grizzly1→grizzly2, both `[MAV TEST - DELETE]` subject — read & in grizzly2 inbox (Carter can delete; not auto-deleted per safety rules)
**Carter deletes manually (AM 6/22):**
- Facebook post id `989322197221009` (live on real Grizzly page)
- GBP post "Importance of Electrical Troubleshooting" (2026-06-19 content, posted live 6/21) on Grizzly's Google Business Profile

---

### Blueprint Takeoff (P1)
Fixture: real residential electrical DWG sourced online ([HorikitaSuzuneTsundere/-ELECTRICAL-WIRING-AND-FLOOR-PLAN-DESIGN](https://github.com/HorikitaSuzuneTsundere/-ELECTRICAL-WIRING-AND-FLOOR-PLAN-DESIGN), `MASAGA_Electrical wiring design.dwg`, 113 KB, AutoCAD 2018) → `test-fixtures/MASAGA-electrical.dwg`.

| Check | Sev | Result | Evidence |
|---|---|---|---|
| DWG→DXF conversion (ODA) | P1 | ✅ | **after fix** — ODA produced 574 KB DXF. |
| DXF parse + INSERT block device detection | P1 | ✅ | Devices counted: Light Fixture 15, Exhaust Fan 4, Smoke Detector 3, Switch (single) 3, Duplex Receptacle 3, Recessed Light 1, Panel (sub) 1. Device-type recognition (smoke/fan/recessed/switch/panel/receptacle) all hit. |
| Vision pass (classify + symbol count) | P1 | ✅ | ran; counts reconciled with DXF blocks (no crash). |
| Calibration / scale detection | P1 | ✅ | correctly reported `unknown (low confidence)` — DWG has no title-block scale text. Did NOT fabricate a scale. |
| Routing lengths | P1 | ✅ (graceful) | correctly **skipped** with 2 warnings (no scale detected, panel location not found) rather than emitting bogus lengths. |
| Labor estimate | P1 | ✅ | 35.8 hrs total (rough-in 16.6 / trim-out 11.1 / panel 8.0) derived from device counts. |
| `⚠ REVIEW REQUIRED` footer present | P1 | ✅ | printed. |

> No ground-truth device counts for this third-party drawing, so exact-accuracy isn't asserted — but device recognition, graceful degradation (scale/routing), and labor math all behaved correctly. Counts are plausible for a small residential plan.

**F6 (P1, fixed):** `takeoff` CLI crashed at **import** for ALL formats. `parsers/pdf.ts` did `import pdfParse from 'pdf-parse'`; that package's `index.js` runs a debug block (`readFileSync('./test/data/05-versions-space.pdf')`) when `module.parent` is falsy — which it is under tsx/ESM — throwing before `main()`. Fixed: import `pdf-parse/lib/pdf-parse.js` directly. Blueprint takeoff was non-functional until this.

**F7 (P1, fixed):** `converters/dwg-to-dxf.ts` passed ODA CLI args in the wrong order (`… DXF ACAD2018 …`). ODA's signature is `<src> <out> <OutputVersion> <OutputFileType> <recurse> <audit> <filter>` — version BEFORE filetype. With them swapped ODA silently no-ops (exit 0, no DXF written), so every DWG produced nothing and then the 30s timer fired. Fixed arg order to `ACAD2018 DXF` and bumped `ODA_TIMEOUT_MS` 30s→120s (ODA's cold first-launch GUI init exceeds 30s; warm runs finish in seconds). DWG path now works end-to-end.

**F8 (P2):** PDF takeoff path is unusable on this machine — GraphicsMagick + Ghostscript not installed (pdf2pic needs them). `--check` reports this clearly. DXF/DWG/raster paths unaffected. Install `choco install graphicsmagick ghostscript` to enable PDF. Also a cosmetic libuv teardown assertion (`UV_HANDLE_CLOSING`) prints after `--check` exits — harmless, from the ODA spawn handle closing during Node shutdown.

## PASS 2 UI — Eyeball Checklist (driven by Claude via Chrome MCP, 2026-06-21)
Executed live against MCC http://localhost:3000 and MCA http://localhost:3012 (local Chrome on CartersPC). ✅ = verified on screen.

**MCC dashboard pages**
- [x] ✅ **Home** — loads clean, no spinners. Live tiles: Agent Fleet 5/5 ALL ONLINE, Local Model QWEN3-14B (32,768 ctx), Deploy OK, Prometheus clock live-ticking, 7-day reports=3, Faults=1, SEO Automation workflow card.
- [x] ✅ **Hardware** — live Prometheus numbers: CPU 17% (i5-13600K), GPU 4% (RTX 4060 Ti 16GB), RAM 59.7% (38.1/63.7GB), disks HEALTHY, Proxmox exporter ONLINE, storage 98% GOOD.
- [x] ✅ **Network** — full live topology (2.5GB AT&T Fiber → Internet → Gateway 1.7Mb/s → 10GB 24-port switch → Workstation/Wireless/Proxmox endpoints w/ live CPU·RAM), port map active. No red error cards.

**MCC chat**
- [x] ✅ **Streaming cursor** — response streamed in (renderer briefly busy mid-stream); answer settled when done.
- [x] ✅ **MavMarkdown** — asked office phone → rendered **(469) 863-9804** bold + a file path as inline monospace code (not raw `**`).
- [x] ✅ **Copy button** — clipboard icon present on message row / input bar.
- [x] ✅ **Chat persistence** — full prior history intact across page navigation (Home↔Orchestrator).
- [x] ✅ **File attachment** — FILES button present in chat bar.
- [x] ✅ **Folder picker** — FOLDER button present in chat bar.
- [ ] ⏸️ **Voice input** — no mic affordance observed (FILES/FOLDER/tools/copy only); not exercised. Low priority.
- [ ] ⏸️ **Job history** — not opened this pass.
- [x] ✅ **Keyboard** — Enter sends (verified), placeholder confirms "Shift+Enter for new line".

**Maverick Assistant (MCA :3012)**
- [x] ✅ **Three modes only** — ASK MAVERICK / ESTIMATE / OPERATIONS. No BUILD-FIX, no SUPERPOWERS (those are MCC-only). 3-mode restriction confirmed.
- [x] ✅ **ASK streams** — "What deposit % for jobs over $5,000?" → "**50% deposit is required for jobs over $5,000.**" Correct, RAG-grounded, markdown bold.
- [x] ✅ **ESTIMATE mode** — switches to amber state, badge → ● ESTIMATE. Workflow = the **email-HCP-estimate pipeline**: server extracts customer+scope via Haiku, spawns `src/automations/estimates/from-chat.ts` (structurally identical to email watcher's `from-email.ts`: extractServiceItems → matchLineItems → createEstimate → addLineItem → HCP URL). Single real HCP estimate, **not** Good/Better/Best. (Live HCP submit not fired here — cleanup already pending; full ESTIMATE→HCP-URL flow validated in prior P0/P1 passes.)
  - ⚠️ **F9 (P2, copy bug):** ESTIMATE tooltips/chips still describe the retired Good/Better/Best DOCX workflow — `maverick-assistant/src/main.jsx:8` (+ built dist), `homelab-noc-dashboard/.../src/main.jsx:2029`, `.../src/MaverickPage.jsx:137`, and the whole "Proposal Builder" section of Grizzly-HCP `CLAUDE.md`. Behavior is correct; only the copy is stale and misleading. Fix the strings + rebuild MCA dist.
- [x] ✅ **OPERATIONS mode** — switches to green state, badge → ● OPERATIONS, tooltip "read emails, Word/PDF docs, build spreadsheets, send emails, create agents and skills." No crash.

**Visual regression (PASS 3)**
- [x] ✅ Layout intact at desktop width across all MCC pages + MCA — no overlap/cutoff, logo/spacing correct, dark theme consistent. Mode-tab color states distinct (cyan/amber/green).
**HCP customers (2):** `ZZ MAV TEST`, `Unknown Customer` (placeholder)
**Pricebook $0 test items:** ✅ DELETED — `olit_582749a274154be1b02ce5d08c5b1365` (3 New Dedicated 20A Circuits Garage) and `olit_1193142fbd17461da39d1b85b8d2510a` (Replace Outlets) removed from live HCP via `npx tsx src/hcp/cleanup-zero-items.ts --delete ...` (170→168 services). Remaining 11 $0 services are legitimate catalog entries (Credit Card Fee, Job Walk, Custom Job, [Google] LSA placeholders, etc.) — left untouched. RAG vectors for the two deleted items persist until next full collection rebuild.
> Delete helper now exists: `deletePriceBookItem(uuid)` in `src/hcp/price-book.ts` + `cleanup-zero-items.ts` CLI. F2 root cause fixed: no more auto-create of $0 items on no-match; unmatched items are flagged ($0 + "⚠ NEEDS PRICING" description) and reported back to MCC/email-watcher.

## Test Execution Status — COMPLETE
All automated tests run, and the UI Eyeball Checklist was driven live by Claude via Chrome MCP (see PASS 2 above — MCC pages + chat, MCA 3-mode, ESTIMATE/OPERATIONS mode states, visual regression all ✅; only voice-input and job-history left unexercised, both low priority). Remaining items are human-only:
- **Carter:** delete the 2 live social posts AM 6/22 (FB id `989322197221009`, GBP 2026-06-19 troubleshooting post).
- **Cleanup:** 9 HCP estimates + 2 customers + 2 $0 pricebook items pending (see below — no auto-delete helper exists; recommend manual UI delete).
- **Blueprint takeoff:** ✅ tested with online DWG; fixed 2 P1 bugs (F6 pdf-parse import crash, F7 ODA arg-order). DWG/DXF paths work; PDF path needs gm+gs installed (F8).
