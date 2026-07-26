# Project Journal

Entries are append-only. History is never rewritten.

---

## 2026-07-25 — sync-estimates AIWA relocation

Moved the `sync-estimates` weekly job from the Windows PC to run natively on the Proxmox host
at `192.168.1.12` as a systemd timer.

Key outcomes:
- Split HCP auth module: Playwright-free half (`auth-cookies.ts`), interactive login half
  (`auth-login.ts`), compatibility shim (`auth.ts`).
- Made the Qdrant publish step switchable between `remote` (SSH+SCP, default) and `local`
  (direct HTTP to Qdrant + local file copy) via `src/hcp/rag-publish.ts`.
- esbuild bundle produces `dist/sync-estimates.mjs` — no Playwright, no node_modules on target.
- systemd units + timer under `deploy/aiwa/`.
- Operator runbook at `docs/AIWA-DEPLOY-sync-estimates.md`.
- Design spec at `docs/superpowers/specs/2026-07-24-sync-estimates-aiwa-relocation-design.md`.
- No deployment to Proxmox has happened yet — separate human-approved step.

Purpose: run the job on the same host as RAG/Qdrant so the publish step is local, removing
the dependency on a passphrase-less SSH key (first step toward retiring that key entirely).
