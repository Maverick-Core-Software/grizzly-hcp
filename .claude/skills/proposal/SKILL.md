# Grizzly Proposal Builder

Run the full estimate-to-proposal workflow for Grizzly Electrical Solutions.

## When to invoke

Use when Carter describes a job and wants an estimate or proposal built.
Accepts a job description as args, or runs interactively if no args provided.

## Workflow

### 1. Check RAG health

```typescript
import { checkHealth } from '../../../src/rag/client.ts';
const online = await checkHealth();
```

If offline, warn and proceed without RAG context.

### 2. Get customer info from RAG

If a customer name is mentioned:
```typescript
import { lookupCustomer } from '../../../src/rag/client.ts';
const info = await lookupCustomer(customerName);
```

Use the returned info to pre-fill address, phone, email. Only ask Carter for what's missing.

### 3. Get pricing context from RAG

```typescript
import { lookupPricing } from '../../../src/rag/client.ts';
const pricing = await lookupPricing(scopeDescription);
```

Use as reference for building Good / Better / Best options.

### 4. Interview loop

Ask for anything still missing:
- Project address / location label (distinct from billing address)
- Specific scope details (panel amperage, circuit count, wire runs, etc.)
- Site conditions (open walls, attic, crawl space, permit required)
- Special items (Oncor coordination, AFCI/GFCI requirements, EV charger, etc.)

### 5. Present estimate in chat

Show:
- Job Summary
- Scope of Work
- Assumptions / Conditions
- NEC Notes (cite articles if relevant — pull from RAG with ragDocs())
- Material Takeoff
- Labor Assumptions
- **Good / Better / Best** options with prices and summaries
- Why options differ
- Exclusions / Risks

Do NOT generate files yet.

### 6. Revision loop

Revise in chat until Carter approves. Include revision notes with each update.

### 7. On approval — generate files

Build the ProposalContext object, then:

```bash
tsx src/proposal/generate-docx.ts
```

### 8. Push to HCP

```bash
# Dry run first
npm run estimate proposals/<filename>.docx --dry-run

# On Carter's confirmation
npm run estimate proposals/<filename>.docx
```

## Output files

All saved to `proposals/` (gitignored):
- `CustomerName-Location-Proposal.docx`
- `CustomerName-Location-Proposal.pdf` (if requested)

## Pricing rules

- Better option = recommended = projected total in Pricing Summary
- Deposit: 50% for jobs over $5,000
- Show deposit as both % and $ amount
- Never show labor/material cost breakdown in customer proposal
- Internal pricing record: mention it's available but don't include in proposal
