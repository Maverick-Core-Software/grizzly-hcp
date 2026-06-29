# Maverick: One Brain, Two Front Doors — Design Spec

**Date:** 2026-06-29
**Status:** Design — awaiting user review
**Repos touched:** `grizzly-hcp` (the brain), `MCC` (the dashboard front door)

---

## 1. Goal

Make the MCC dashboard **ASK** surface and the Slack/dashboard **AGENT** surface run on the
**same Maverick brain** (grizzly-hcp's Mastra agent), specialized per surface — instead of
today's split where the dashboard ASK runs its own MCC-local Anthropic-direct brain.

After this change there is exactly **one** Maverick brain. Every front door
(Slack, dashboard ASK, dashboard AGENT) calls it through `src/agent/run.ts`, differing only
by a `channel` parameter that tunes the instructions and the tool set.

---

## 2. Background — current state (verified this session)

- **Slack** → already calls grizzly's brain (`spawnMaverickAgent` → `tsx src/agent/run.ts`,
  `channel:'text'`). ✅ unified already.
- **Dashboard AGENT button** (`mode:'agent'`) → already calls grizzly's brain via the same
  `spawnMaverickAgent`, `channel:'text'`. ✅ unified already.
- **Dashboard ASK button** (`mode:'ask'`) → ❌ calls a **separate** MCC-local brain
  (`CLAUDE_ASK_SYSTEM` / `ESTIMATE_EXTRACT_SYSTEM` in `MCC/lib/chat.mjs`, Anthropic SDK direct).
  This is the only real fork. This spec closes it.
- The two brains only converge today at `from-chat.ts` → `commitEstimateWorkflow` (the HCP write
  spine), which already routes through the HCP MCP daemon (`HCP_VIA_MCP=true`, done 2026-06-29).

### The ASK vs AGENT distinction (Carter's mental model)

ASK Maverick is an **advisory / LLM chat companion** — for talking through jobs, electrical
code questions, troubleshooting on-site, conversion tables, and scoping. **It does not take
action.** It can *propose* a job scope and hand it to the agent to execute, but it never writes
to HCP itself.

The boundary is **data source, not a hand-picked tool list**:

- **ASK = RAG only.** Its HCP awareness (pricebook, customers, upcoming schedule, estimates)
  comes from the **weekly snapshot pipeline**: a script exports HCP data → Gemini auto-saves the
  CSVs to Google Drive → a watcher indexes them into the RAG. ASK reads that indexed snapshot.
  No live HCP connection, structurally no write tools.
- **AGENT = RAG + live HCP.** Everything ASK has, plus the live HCP read tools and messaging
  tools, plus the ability to emit the `ESTIMATE_READY` block that triggers a real write.

This maps cleanly onto the existing file split:
`src/agent/tools/reads/rag.ts` (RAG-backed) vs `src/agent/tools/reads/hcp.ts` (live HCP).

---

## 3. Design

### 3.1 Add an `advisory` channel to the brain

`Channel` type (`src/agent/resolver.ts`) gains `'advisory'`:

```
type Channel = 'text' | 'voice' | 'cli' | 'employee' | 'slack' | 'advisory'
```

**`resolveTools('advisory', allTools)`** returns the **RAG-only** subset:
- `lookup_customer`, `search_pricebook`, `lookup_pricing`, `get_prior_estimates` (existing rag.ts)
- `search_knowledge` (NEW — see 3.2)
- `lookup_home_depot_price` (read-only pricing lookup; no HCP write surface)
- `save_rule`, `save_alias` (memory writes — these write to Maverick's own memory, not HCP;
  keeping them lets ASK capture preferences mid-chat. They are **not** HCP writes.)

It **excludes** every live-HCP tool (`check_hcp_messages`, `check_schedule`, `get_job`,
`list_open_jobs`, `get_customer_estimates`) and the messaging tools
(`check_thumbtack_messages`, `draft_reply`).

Implementation: define an `ADVISORY_INCLUDED` allow-list (advisory is the one channel that
*allow-lists* rather than *excludes*, because its safety property — "cannot touch live HCP" —
must be enforced positively, not by remembering to add each new HCP tool to an exclude list).

**`resolveInstructions('advisory', base)`** appends an advisory framing suffix:
- You are a knowledgeable electrical-trade companion. You answer questions, troubleshoot, do
  conversions, reason about code, and help scope jobs.
- You do **not** take action or write to HCP. Your HCP knowledge comes from indexed weekly
  snapshots and may be up to a week stale — say so when it matters.
- When you and Carter agree on a concrete job scope, emit the `[ESTIMATE_READY]…[/ESTIMATE_READY]`
  block exactly as specified so the agent can execute it. (Same format as base instructions.)

### 3.2 New RAG tool: `search_knowledge`

The existing rag.ts tools are entity-specific (customer, pricebook, pricing, prior-estimates).
There is **no** general tool that lets ASK answer "what's on my schedule this week?" or
"what estimates went out recently?" from the indexed snapshot. `get_prior_estimates` already
wraps the general `ragDocs(query, topK)` search, so the capability exists under the hood — it
just isn't exposed as a general knowledge lookup.

Add `search_knowledge` to `src/agent/tools/reads/rag.ts`:
- Wraps `ragDocs(query, topK)` over the whole indexed corpus (schedule, jobs, estimates,
  customers, NEC/Oncor reference docs).
- Description steers the model to use it for schedule / open-jobs / general-knowledge questions
  that the entity-specific tools don't cover.
- Available to **both** ASK and AGENT (it's RAG, so it's safe everywhere).

### 3.3 Route the dashboard ASK button to the brain

In `MCC/lib/chat.mjs`, `handleChat`'s `mode==='ask'` branch changes from "call MCC-local brain"
to:

```
spawnMaverickAgent({ prompt, history, channel: 'advisory' })
```

— the identical mechanism the AGENT button already uses, only the channel differs. The SSE
streaming, `ESTIMATE_READY` detection, and `spawnEstimatePipeline` handoff are unchanged and
already live in this file, so scope→execute keeps working from ASK.

### 3.4 Retire the MCC-local ASK brain

Delete the now-dead MCC-local brain code: `CLAUDE_ASK_SYSTEM`, `ESTIMATE_EXTRACT_SYSTEM`,
`handleEstimateFromAsk`, `handleEstimateEdit`, and the direct Anthropic client used only by
them. Keep `spawnEstimatePipeline` and the `estimate-ready` mode (those are the handoff, not
the brain).

---

## 4. Tool matrix (after)

| Tool | ASK (`advisory`) | AGENT (`text`/`slack`) |
|---|---|---|
| lookup_customer, search_pricebook, lookup_pricing, get_prior_estimates | ✅ | ✅ |
| **search_knowledge** (NEW) | ✅ | ✅ |
| lookup_home_depot_price | ✅ | ✅ |
| save_rule, save_alias (memory, not HCP) | ✅ | ✅ |
| check_schedule, get_job, list_open_jobs, get_customer_estimates, check_hcp_messages (live HCP) | ❌ | ✅ |
| check_thumbtack_messages, draft_reply (messaging) | ❌ | ✅ |
| `ESTIMATE_READY` scope handoff | ✅ propose | ✅ execute |

---

## 5. Data dependency (verify, don't build here)

ASK's schedule/estimate awareness is only as good as the **weekly export → Drive → watcher → RAG**
pipeline. If schedule/open-jobs are not actually being exported and indexed, `search_knowledge`
will return nothing for those queries no matter how it's wired.

**In scope for this work:** a verification step that confirms whether the indexed RAG corpus
contains schedule/jobs/estimate snapshots, and a clear report if it does not.

**Out of scope for this spec:** building or fixing that export pipeline. If verification shows
it's not indexing jobs/schedule, that becomes its own follow-up — it does not block the brain
consolidation, which is purely about which brain answers and with which tools.

---

## 6. Testing & verification

1. **Tool resolution unit check** — `resolveTools('advisory', allTools)` returns exactly the
   allow-listed set and **none** of the live-HCP/messaging tools. This is the safety-critical
   assertion (ASK must be structurally unable to touch live HCP), so it gets the one runnable
   check this change leaves behind.
2. **Instruction resolution** — `resolveInstructions('advisory', base)` contains the advisory
   framing and still includes the `ESTIMATE_READY` format.
3. **`search_knowledge` smoke** — calling it returns RAG docs (against the live RAG client).
4. **End-to-end ASK** — dashboard ASK button → advisory brain answers a code/troubleshooting
   question with no HCP write tools available; then a scoping conversation emits `ESTIMATE_READY`
   and `spawnEstimatePipeline` fires.
5. **RAG corpus content check** (the §5 dependency) — query `search_knowledge` for schedule and
   report whether the snapshot is present.

---

## 7. Risks & rollback

- **Risk: ASK loses "live" freshness users expected.** Mitigation: advisory instructions state
  the snapshot may be up to a week stale; live data stays on AGENT.
- **Risk: a future HCP tool is added to `allTools` and silently leaks into ASK.** Mitigation:
  advisory uses a positive allow-list, so new tools are excluded by default.
- **Rollback:** revert the `mode==='ask'` routing change in `MCC/lib/chat.mjs` (restore the
  MCC-local brain call). The grizzly-side `advisory` channel is additive and harmless if unused.

---

## 8. Out of scope

- **OPS button → Maverick brain** (deferred until after this consolidation, per Carter).
- **Slack 2-app split** (separate thread, blocked on new tokens).
- **Building/fixing the weekly RAG export pipeline** (§5 — verify only).
