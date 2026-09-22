# Grizzly LiveKit C0 — Stage 1 Handoff

**Status:** Local-only C0 implementation accepted for handoff. This is not a deployed service and must remain disabled.

## What is in this commit

`src/agent/voice/` contains a standalone C0 seam for a future LiveKit/GPT-Live canary:

- closed, disabled-by-default configuration and allowlist contract;
- pure admission, content-block, controller, transfer, and transport contracts;
- append-only local JSONL outbox plus a pure stale-record monitor;
- local redaction before operator-facing snapshots, including embedded 10–15 digit runs in free-form text;
- colocated executable checks for all eight C0 modules.

The implementation intentionally has no route, listener, media, provider, credential, LiveKit, Twilio, Housecall Pro, ConversationRelay, Proxmox, or process-lifecycle integration.

## Verification retained

The final focused checks passed:

```powershell
npx tsx src/agent/voice/outbox.check.ts
npx tsx src/agent/voice/c0-controller.check.ts
```

The runtime C0 sources also passed strict TypeScript checking using the existing primary-worktree compiler and its existing Node type definitions. A source isolation scan found no prohibited telephony, provider, network, process, or endpoint references in non-check C0 sources.

## Important safety boundary

The embedded-number redaction issue identified in independent review was fixed before this handoff. A phrase containing a bare 10–15 digit run is now masked in snapshots, and a record that merely claims to be redacted is refused if that raw value remains.

Do not enable, deploy, import into the existing voice server, or attach this code to any call route without a separate Stage 2 configuration review and explicit approval. In particular, the next stage must separately review the Twilio canary subaccount, SIP authentication, LiveKit/GPT-Live configuration, durable delivery and alerts, human fallback, kill switch, and staff-only call test.

## External-state confirmation

No cloud configuration, phone routing, HCP access, Proxmox action, credentials, service lifecycle, number movement, or customer call occurred during Stage 1.

