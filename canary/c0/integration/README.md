# C0 cross-component contract harness

Run the offline harness from the repository root with:

```powershell
npx --prefix canary/c0/agent tsx canary/c0/integration/cross-component.check.ts
```

It uses only injected fakes for Twilio Sync, call control, and ntfy. The only
environment file it reads is the committed names-only `canary/c0/.env.c0.example`
template; it never opens a real C0 environment file.
