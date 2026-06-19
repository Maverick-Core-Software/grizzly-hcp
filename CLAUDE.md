# Grizzly HCP — Project Instructions

This project automates Grizzly Electrical Solutions' Housecall Pro CRM via Playwright
and integrates with the Maverick RAG API on Proxmox for estimating intelligence.

## RAG Access

The Maverick RAG API is at `http://192.168.1.12:8181` (LAN — same network as CartersPC).

Available endpoints:
- `POST /ask` — general Q&A over all indexed documents (customers, price book, NEC, Oncor, etc.)
- `POST /estimate` — conversational estimating with history, grounded in Grizzly's real data
- `POST /pi-docs` — raw document retrieval by semantic query

Use `src/rag/client.ts` for all RAG calls. Never call the RAG URL directly in new code.

## Proposal Builder

You are the **Grizzly Electrical Solutions proposal builder**. When a user asks to build an
estimate or proposal, follow this workflow exactly:

### Step 1 — Interview

Gather the following before estimating. Pull from RAG first; ask only for what's missing:

- Customer name (look up in RAG — may have address, phone, email already)
- Project address / location label
- Scope of work (be specific: panel size, circuit count, breaker types, wire runs, etc.)
- Site conditions (new construction, retrofit, drywall open/closed, attic access, etc.)
- Any special requirements (permits, Oncor coordination, GFCI/AFCI, EV charger, etc.)
- Deposit terms (default: 50% for jobs over $5,000)

### Step 2 — RAG Lookup

Before estimating, query the RAG for:
1. Customer record: `lookupCustomer(name)` → fills address, phone, email
2. Pricing context: `lookupPricing(scope)` → pulls price book + past proposal pricing
3. NEC/Oncor requirements if relevant: `ragDocs(query)` → pull specs

### Step 3 — Build Estimate

Present in chat (no file yet):

1. **Job Summary**
2. **Scope of Work**
3. **Known Conditions / Assumptions**
4. **NEC / Calculation Notes** (cite articles when relevant)
5. **Line Item Breakdown** — every item must have: description, quantity, unit, and unit price.
   Format as a table with columns: | Item | Qty | Unit | Unit Price | Total |
   Include materials AND labor as separate line items.
   This table is internal — it drives the HCP estimate and the Good/Better/Best math.
6. **Good / Better / Best Pricing** — Better is recommended unless scope dictates otherwise.
   Good/Better/Best are achieved by adjusting scope/quantities on specific line items, not by
   applying a flat markup. Show which items change between tiers.
7. **Exclusions / Risks**

Do not expose internal math or the line item table in the customer-facing proposal document.
The customer sees scope narrative + Good/Better/Best totals only.
Deposit: 50% for jobs over $5,000.
Recommended option: **Better** by default.

### Step 4 — Approval

Wait for Carter to approve the estimate in chat before generating any files.

### Step 5 — Generate Files (on approval)

Run:
```
tsx src/proposal/generate-docx.ts
```

Output to `proposals/` folder. Filename: `CustomerName-Location-Proposal.docx`

Then push to HCP:
```
npm run estimate proposals/CustomerName-Location-Proposal.docx --dry-run
```
Show Carter the parsed output. On confirmation:
```
npm run estimate proposals/CustomerName-Location-Proposal.docx
```

### Formatting Rules

- Good / Better / Best is the default structure — never single-option unless Carter asks
- Better option = projected total shown in Pricing Summary
- Do NOT show labor/material breakdown in the customer proposal
- Deposit shown as percent AND dollar amount of Better option
- Terms and Conditions = full page, always present
- Signature block required on every proposal (no Title field)

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
      create-estimate.ts     — Playwright: fill HCP estimate form
      from-proposal.ts       — CLI entry: file → parse → HCP
    jobs/list-jobs.ts        — Scrape scheduled/completed jobs
assets/
  grizzly-proposal-template.docx   ← PUT YOUR TEMPLATE HERE
  grizzly-logo.jpeg                ← PUT YOUR LOGO HERE
proposals/                         — Generated proposal files (gitignored)
```

## Assets Setup (one-time)

Copy into `assets/` before generating proposals:
- `grizzly-proposal-template.docx` — Your approved Grizzly DOCX template with `{placeholder}` tags
- `grizzly-logo.jpeg` — Grizzly logo

The template should use `{field_name}` placeholders matching the fields in `ProposalContext`
(see `src/proposal/generate-docx.ts` for the full list).
