# Grizzly HCP — Project Instructions

This project automates Grizzly Electrical Solutions' Housecall Pro CRM via Playwright
and integrates with the Maverick RAG API on Proxmox for estimating intelligence.

## RAG Access

The Maverick RAG API is at `http://192.168.1.12:8181` (LAN — same network as CartersPC).

Available endpoints:
- `POST /ask` — general Q&A; queries both `reference_docs` (NEC 2026, Oncor, etc.) and `grizzly_hcp` (customers, jobs)
- `POST /estimate` — conversational estimating with history, grounded in Grizzly's real data
- `POST /estimate-stream` — streaming version of `/estimate`
- `POST /pricebook/search` — semantic search over the `pricebook` collection
- `POST /code` — raw context chunks from `coding_docs` collection

Use `src/rag/client.ts` for all RAG calls. Never call the RAG URL directly in new code.

## Estimate Builder (HCP pipeline)

When a user asks to build an estimate, the canonical workflow is the **HCP estimate
pipeline** — the same one the email watcher runs. There is **no Good/Better/Best proposal
flow** and **no customer-facing DOCX**; the deliverable is a real Housecall Pro estimate
with price-book-matched line items.

The pipeline lives in `src/automations/estimates/`:
- `from-chat.ts` — entry for chat/MCA/MCC. stdin JSON `{ scope, customerName?, customerEmail?, customerPhone? }` → stdout `{ success, estimateUrl, estimateUuid }`; progress on stderr as `[progress] …`.
- `from-email.ts` — entry for the email watcher. Structurally identical to `from-chat.ts`; only the input source differs (email body/attachments vs. chat scope).

Both run the same steps:
1. **Find/create customer** — `searchCustomer(name)`, falling back to email prefix, else `createCustomer(...)` (or an "Unknown Customer" placeholder if no info).
2. **Create the HCP estimate** — `createEstimate(customer.id, customer.addressId)`.
3. **Extract service items** — Haiku turns the scope into short price-book-style service names (`extractServiceItems`).
4. **Match the price book** — `matchLineItems` against the live HCP price book; unmatched items get a flagged $0 line (`NEEDS_PRICING_FLAG`) and are returned in `unmatched[]`. They are **never** auto-written to the live price book (see `src/hcp/build-line-item.ts`).
5. **Add line items** — `addLineItem` per matched item (materials/labor/discount kind inferred).
6. **Assign technicians** — Carter + Jaime via `CARTER_TECH_ID` / `JAIME_TECH_ID`.
7. **Return the HCP URL** — `https://pro.housecallpro.com/app/estimates/<uuid>`.

### Scope generation

The scope text fed to the pipeline is produced by the RAG, grounded in Grizzly's real data:
- Email watcher: RAG `POST /estimate-stream` (see `src/automations/estimates/email-watcher.ts` `generateScope`). Run with `npm run watch-email` (PM2: `mav-email-watcher`).
- Chat (MCC/MCA): the server extracts customer + scope from the conversation, then spawns
  `from-chat.ts`. When RAG is offline a Claude fallback system prompt generates the scope.

When gathering scope from a person, pull from RAG first and ask only for what's missing:
customer (RAG may already have address/phone/email), project address, specific scope (panel
size, circuit count, breaker types, wire runs), site conditions, special requirements
(permits, Oncor, GFCI/AFCI, EV charger). Use `lookupCustomer`, `lookupPricing`, `ragDocs`.

### Blueprint takeoff (optional upstream step)

If a drawing is attached (DWG/DXF/PDF/PNG), `src/takeoff/cli.ts` produces device counts,
routing lengths, and labor hours that feed into the scope before the pipeline runs.

### Deposit

50% for jobs over $5,000 (shown as percent and dollar amount where relevant).

## Company Defaults

- Business: Grizzly Electrical Solutions
- Office: (469) 863-9804 | Cell: (469) 863-9031
- Email: contactus@grizzlyelectrical.net
- Deposit: 50% for jobs over $5,000
- Date format: MM/DD/YYYY

## Key Scripts

| Command | What it does |
|---------|-------------|
| `npm run login` | Log into HCP and save browser session (run once) |
| `npm run estimate <file>` | Parse proposal PDF/DOCX → create HCP estimate via API |
| `npm run estimate <file> -- --dry-run` | Parse only, show what would be sent — no HCP changes |
| `npm run estimate <file> -- --template <eot_uuid>` | Same but applies a saved HCP template first |
| `npm run templates` | List all saved HCP estimate templates and their UUIDs |
| `npm run intercept` | Capture HCP API calls during manual browser session |
| `npm run watch-email` | Poll Gmail inboxes → classify → scope → create HCP estimates (long-running; PM2 `mav-email-watcher`) |
| `npm run run` | Pull scheduled jobs from HCP |

## Project Structure

```
src/
  rag/client.ts          — RAG API client (lookupCustomer, lookupPricing, ragDocs)
  proposal/
    generate-docx.ts     — Fill template DOCX with proposal data
  parsers/
    extract-text.ts      — PDF/DOCX → raw text
    parse-proposal.ts    — Claude parses raw text → ProposalData
  automations/
    estimates/
      from-chat.ts           — PRIMARY: chat/MCA/MCC scope → HCP estimate (stdin JSON → stdout URL)
      from-email.ts          — PRIMARY: email watcher → HCP estimate (same pipeline as from-chat)
      email-watcher.ts       — long-running Gmail poller that feeds from-email.ts (npm run watch-email)
      create-estimate.ts     — Playwright: fill HCP estimate form
      from-proposal.ts       — LEGACY: DOCX/PDF proposal file → parse → HCP
    jobs/list-jobs.ts        — Scrape scheduled/completed jobs
  takeoff/cli.ts             — Blueprint takeoff (DWG/DXF/PDF/PNG → device counts, routing, labor)
assets/
  grizzly-logo.jpeg                ← PUT YOUR LOGO HERE
proposals/                         — LEGACY generated proposal files (gitignored)
```
> `src/proposal/generate-docx.ts` + `from-proposal.ts` + `grizzly-proposal-template.docx`
> are the **retired** Good/Better/Best DOCX proposal flow. The live estimate path is the
> from-chat / from-email pipeline above — see "Estimate Builder (HCP pipeline)".

## Assets Setup (one-time)

- `grizzly-logo.jpeg` — Grizzly logo (used in `assets/`).

> The `grizzly-proposal-template.docx` template and its `{field_name}` placeholders belong to
> the retired DOCX proposal flow (`src/proposal/generate-docx.ts`). Not needed for the live
> from-chat / from-email HCP estimate pipeline.
