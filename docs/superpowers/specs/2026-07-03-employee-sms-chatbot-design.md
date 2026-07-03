# Employee SMS Chatbot — Design Spec

**Date:** 2026-07-03
**Status:** Approved

## Overview

Add an employee-facing SMS channel to the existing `customer-chat-server`. Employees text a dedicated Twilio number and get full Maverick agent access — job scoping, pricing lookups, HCP estimate creation, code questions, scheduling. Access is gated by a phone-number allowlist with role support for future expansion.

---

## Architecture

Extend `src/server/customer-chat-server.ts` to handle two Twilio numbers on the same port (3012). The Twilio webhook already delivers a `To` field on every inbound POST identifying which number was texted. Routing:

- `To == CUSTOMER_PHONE_NUMBER` → customer channel (existing behavior, unchanged)
- `To == EMPLOYEE_PHONE_NUMBER` → employee channel (new)

Both numbers share one webhook URL in the Twilio console:
`https://aiwa.tailf72e3f.ts.net/webhook/twilio`

No new server, no new PM2 entry, no new port.

---

## New Environment Variables

```
EMPLOYEE_PHONE_NUMBER=+1...   # E.164 format, the new Twilio number
```

Added to `/opt/grizzly-hcp/.env` and `.env.example`.

---

## Access Control

`data/employee-phones.json` — hot-reloaded on every employee-channel request (no restart required to add/remove employees).

```json
{
  "+1XXXXXXXXXX": { "name": "Carter", "role": "owner" },
  "+1XXXXXXXXXX": { "name": "Jaime", "role": "owner" }
}
```

**Roles (defined now, enforced later):**

| Role | Intended access |
|---|---|
| `owner` | Full toolset |
| `manager` | Full toolset |
| `employee` | Read/scope only |
| `office` | Ops tools only |

For now all approved numbers get the full employee toolset (only `check_thumbtack_messages` excluded, per existing `EMPLOYEE_EXCLUDED`). Role-based tool filtering is a future task.

**Parse error behavior:** If `employee-phones.json` is missing or malformed, all employee-channel requests are rejected with a safe default message and an error is logged. No crash, no fallback to open access.

**Rejection behavior:** If `From` is not in the allowlist, reply once with:
> "This number isn't authorized to use the Grizzly employee assistant. Contact Carter to request access."
No session is created, no agent is invoked.

---

## Employee Conversation Flow

1. Employee texts the employee Twilio number
2. Server validates `From` against `data/employee-phones.json`
3. Message routed to Maverick agent (`employee` channel) with conversation history
4. Agent scopes job, looks up pricing, checks HCP data as needed
5. When ready to build an estimate, agent presents the full scope and asks for explicit confirmation in conversation
6. Employee confirms ("build it", "go ahead", etc.)
7. Agent emits `[ESTIMATE_READY]{...}[/ESTIMATE_READY]`
8. Server detects block → spawns `from-chat.ts` subprocess (identical to customer flow)
9. `from-chat.ts` creates the estimate in HCP
10. Server sends confirmation SMS back to the employee's phone with estimate details

No server-side YES/NO interception. The agent owns the confirmation gate through natural conversation, mirroring the "BUILD IT" button in MCC.

---

## Session Management

Reuses the existing `CustomerSession` shape and session map, keyed by phone number. Employee sessions are stored separately in their own `Map` (not shared with customer sessions) to avoid any cross-channel collision. TTL: 24 hours idle, same as customer sessions.

Session log written to `data/employee-sessions.jsonl` (separate from `data/customer-sessions.jsonl`).

---

## Signature Validation

Same Twilio signature validation as the customer webhook — uses `TWILIO_AUTH_TOKEN` and `PUBLIC_URL`. No changes needed; the same auth token covers both numbers.

---

## SMS Format Rules for Employee Channel

The existing `EMPLOYEE_INSTRUCTIONS` system prompt is designed for full-featured interfaces. Add an SMS suffix (similar to existing `SLACK_SUFFIX`) that enforces:
- No markdown
- Responses under 320 chars where possible
- One question per message
- Numbers and bullet points as plain text

---

## Files Changed

| File | Change |
|---|---|
| `src/server/customer-chat-server.ts` | Add `To`-based routing, employee allowlist check, employee session map, employee agent instance |
| `src/agent/resolver.ts` | Add SMS suffix for employee channel |
| `data/employee-phones.json` | New file — phone → `{name, role}` map |
| `.env.example` | Add `EMPLOYEE_PHONE_NUMBER` |
| `/opt/grizzly-hcp/.env` | Add `EMPLOYEE_PHONE_NUMBER` (manual step) |

---

## Out of Scope

- Role-based tool filtering (future)
- Web UI for managing the allowlist (future)
- A2P campaign registration for the employee number (handled separately in Twilio console)
