# B: AIWA governance, inventory, gateway-autofix, line check, and grizzly-hcp voice deploy

Research date: 2026-09-23. Read-only. Nothing was edited, restarted, or SSH'd. No secret values were read. For `.env*` files, only variable names were listed.

Tags: **[READ]** means read directly from the cited file, line, or read-only Proxmox MCP call. **[INFERRED]** means my own conclusion from the cited material; verify it before relying on it.

Path note [READ]: `C:\Workspace\Active\brain` resolves to `D:\Workspace\Active\brain`, because grep hits under C:\ report D:\ paths.

---

## 0. Headline corrections to the task premise

1. **`/opt/grizzly-hcp` is on the Proxmox host itself (node `aiwa`, 192.168.1.12). It is not in an LXC.** [READ]
   - `Hermes-Supervisor\docs\2026-08-31-helm-lanes-findings.md:25` says "All customer/ops agents run on the **AIWA host**, not in CT103". Line 32 says voice-server runs as "host PM2, `/opt/grizzly-hcp`", on port 8765, behind Funnel `:10000`.
   - `Hermes-Supervisor\memory\JOURNAL.md:817` says "root PM2 on AIWA".
   - The Proxmox MCP shows no CT named "aiwa". The node itself is named `aiwa`, and all guests are LXC (no QEMU VMs).
   - So "the same AIWA container" is really the host's root PM2 estate.
2. **By policy, host root is for host responsibilities only. Application services belong in a service LXC.** [READ]
   - `brain\agent-memory\runbooks\aiwa-deployment.md:15-16` and `Hermes-Supervisor\docs\AIWA-RECIPE.md:69` both say this.
   - The existing voice-server and Hermes units on the host are legacy placement. [INFERRED]
   - A new LiveKit agent placed on host root would extend that legacy placement instead of following the rule. [INFERRED]
3. **The live 3862 `voice_fallback_url` is empty because the gateway-autofix fallback was never applied to 3862.** It was built, deployed to Twilio Functions, and proven on its own canary (…3978). It is still waiting for Carter's re-test and "go". [READ] See section 3.
4. **The only documented "Gateway Autofix Canary" number is +1…3978, not …2642.** Nothing I searched explains why …2642 carries that friendly name. See section 3.5.

---

## 1. Governance docs: where they are and the binding rules for a voice agent

### 1.1 Where the named docs are [READ]

| Doc | Found at | Status |
|---|---|---|
| AIWA-DEPLOY-RUNBOOK.md | `D:\Workspace\Shared\Agents\Hermes-Supervisor\docs\AIWA-DEPLOY-RUNBOOK.md` | **Marked "DO NOT EXECUTE"** (lines 3-8). It records a direct-SSH approach that conflicts with the Orca-only rule. It is kept only as reference. |
| SECRETS-MATRIX.md | `D:\Workspace\Shared\Agents\Hermes-Supervisor\docs\SECRETS-MATRIX.md` | Migration-planning matrix, 2026-07-19 |
| AIWA-VRAM-PLACEMENT.md | `D:\Workspace\Shared\Agents\Hermes-Supervisor\docs\AIWA-VRAM-PLACEMENT.md` | Architecture note, 2026-08-14. No live moves without approval (line 3). |
| agent-memory/runbooks/aiwa-deployment.md | `C:\Workspace\Active\brain\agent-memory\runbooks\aiwa-deployment.md` | **The governing runbook.** Its companion is `proxmox-mcp-split.md` in the same folder. |

Places I searched with no hits:
- Named docs: none at the top level or one level down of `D:\Workspace\Active`, and none in `D:\Workspace\Active\grizzly-hcp\docs` or `deploy`.
- `Hermes-Supervisor\agent-memory\` does not exist. The repo uses `memory\` (HANDOFF.md, JOURNAL.md).
- Other brain folders searched (`knowledge`, `projects`, `plans`) have none of the named files.

Related canonical docs found along the way [READ]:
- `Hermes-Supervisor\docs\AIWA-RECIPE.md` ("CANONICAL SOURCE" for AIWA policy)
- `Hermes-Supervisor\AGENTS.md`
- `Hermes-Supervisor\PLAN2.md`
- `Hermes-Supervisor\docs\SERVICE-MATRIX.md`
- `Hermes-Supervisor\docs\LANES.md`
- `brain\knowledge\infrastructure.md`

### 1.2 Binding rules relevant to hosting a voice agent [READ unless marked]

**Orca only; no SSH, SCP, or ad-hoc shell**
- `aiwa-deployment.md:13-14`: "Use Orca for every AIWA action. Do not use SSH, SCP, or an ad-hoc remote shell without Carter's explicit approval for that named exception."
- `AIWA-RECIPE.md:10`: the same rule. Lines 17-19: an exception needs explicit per-action approval for the named target, and Orca remains the default even then.
- `AIWA-RECIPE.md:75-78`: a guard banner (`tools/aiwa-guard.sh`) enforces this.
- `proxmox-mcp-split.md:49-61`: everything inside a container stays on Orca, including git, npm, PM2/systemd, logs, test gates, and the TZ check. The Proxmox API has no LXC exec endpoint, so any tool claiming LXC exec is SSHing.
- `Hermes-Supervisor\AGENTS.md:20` says the same.

**Read-only diagnosis**
- `aiwa-deployment.md:5-9`: use the `proxmox` MCP at tier `read`. It does not need the change steps.
- `proxmox-mcp-split.md:31-39`: tiers are read, lifecycle, and all. `lifecycle` is per-session only, and `all` must not be enabled.

**Orca environments**

| Environment | Target | Source |
|---|---|---|
| `aiwa-host` | Proxmox root on .12, "host responsibilities only" | `AIWA-RECIPE.md:69` |
| `aiwa-orca` (sandbox) | CT101 (.13), agent work | `AIWA-RECIPE.md:69-71` |
| `aiwa-prod-102` | CT102, `/opt/hcp-mcp` | `AIWA-RECIPE.md:69-71` |
| `mcc-prod-103` | CT103, `/opt/maverick-integrations` | `AIWA-RECIPE.md:69-71` |

- `brain\knowledge\infrastructure.md:42` calls the CT101 environment `aiwa`, not `aiwa-orca`. The name drifted on 2026-08-25. [READ; the naming conflict is INFERRED]

**Sandbox first; exact ref; rollback ref**
- `aiwa-deployment.md:11-12`: author locally; AIWA and its LXCs are runtime targets, never development workspaces.
- Lines 17-21: commit and push the reviewed candidate, keep an exact rollback ref, and validate that exact ref in the sandbox through Orca.
- `AIWA-RECIPE.md:30-47` gives the 7-step release path.
- `Hermes-Supervisor\AGENTS.md:21` repeats it.

**Approval gates**
- `aiwa-deployment.md:22-23`: explicit approval is required before any live state change (service restart, timer/unit action, firewall change, backup restore, or credential/login action).
- `AIWA-RECIPE.md:58-60`: do not start, stop, restart, reload, or kill any process without approval for that named action, and never force-kill.
- Verification after the change: `aiwa-deployment.md:24-28` and `AIWA-RECIPE.md:42-47`.

**Never patch live**
- `aiwa-deployment.md:42-45`: never patch live source, `/etc`, browser profiles, or runtime state as development. No `git clean`, no hard resets, no unverified rollback.
- A repo runbook cannot weaken these rules (`AIWA-RECIPE.md:61-62`).

**Timezone**
- `aiwa-deployment.md:32-40`: the rule names SEO-Agents-App services, which must set `TZ=America/Chicago`.
- The voice-watchdog unit also sets it (`voice-watchdog.service:9`). A new voice agent that uses local time should too. [INFERRED]

**Root versus service LXC**
- `aiwa-deployment.md:15-16`: "Use AIWA root only for host responsibilities. Use the service LXC for normal application configuration, logs, health checks, and approved releases."

**Container placement plan for voice**
- `PLAN2.md:83`: "Voice server | High-risk external interface | … | **CT103 last, after a dedicated readiness review**".
- `PLAN2.md:206-217` (Phase E) sets these conditions before any customer-facing cutover:
  - ingress and TLS path documented
  - isolated credentials and rate limits
  - audit logs
  - a customer-safe rollback
  - a verified health check and alert route
  - a canary that does not affect real customers
- `SERVICE-MATRIX.md:26`: `voice-server` is "Wave 5 (last)" with a "Dedicated readiness review per PLAN2".
- `PLAN2.md:33` and `:263`: Hermes gateway and triage stay on the AIWA host and must not move into CT102 or CT103.

**Supervisor**
- `PLAN2.md:62` and `:134-146`: systemd is the production supervisor, one unit per service. PM2 is "a temporary local compatibility aid" and must not be the long-term service manager.
- Voice-server today is root PM2 (`pm2-root.service` resurrect, `infrastructure.md:30`).

**Secret placement**
- `SECRETS-MATRIX.md:3`: one `EnvironmentFile` per service under `/etc/maverick-integrations/`, owned by the service user, mode 0600. No service reads another service's file. No shared `.env`.
- `PLAN2.md:63` and `:116-128` say the same.
- `SECRETS-MATRIX.md:78-83`: the planned `voice.env` holds `VOICE_PORT`, `VOICE_PUBLIC_URL`, `VOICE_TTS_PROVIDER`, `VOICE_TTS_VOICE`, `CARTER_PHONE`, `JAIME_PHONE`.
- `SECRETS-MATRIX.md:89`: Twilio credentials are shared by email-watcher, chat, and voice. That is acceptable, but each service gets its own copy with no shared include.
- `SECRETS-MATRIX.md:88`: provider LLM keys should be per-service where possible.
- `AGENTS.md:30`: no aggregator or multi-provider API keys.

**How secrets actually sit today**
- voice-server reads the single repo-root `/opt/grizzly-hcp/.env` through dotenv (`ecosystem.config.cjs:8`, cwd `__dirname`). [READ]
- The new root `voice-watchdog` unit uses the same file (`voice-watchdog.service:10`). [READ]
- A LiveKit or OpenAI agent would need its own env file (for example `/etc/maverick-integrations/voice-agent.env`, 0600, service user) to satisfy the matrix. [INFERRED]
- The C0 canary keeps its secrets in the git-ignored `canary/c0/.env.c0` (C0 build-decisions D2, `docs/2026-09-22-c0-stage2-build-decisions.md:32`). [READ]

**Resources, VRAM, CPU, and RAM caps**
- `AIWA-VRAM-PLACEMENT.md:14`: "Customer path stays cloud / isolated", meaning no experimental local models on the customer path.
- `AIWA-VRAM-PLACEMENT.md:20`: "Any AIWA local process needs hard VRAM/RAM ceilings and a reaper/watchdog story."
- `AIWA-VRAM-PLACEMENT.md:43`: sandbox-only trial, then a rollback ref, then Carter's approval before any systemd unit.
- The doc's topology table (lines 9-10) is **stale**: it puts the R9700 on CartersPC. The R9700 32GB is in AIWA since 2026-08-22 (`infrastructure.md:8, 37-38`), passed through to CT210 `llama-vulkan` (/dev/dri/card0 and renderD129).
- gpt-live-1 on LiveKit Cloud is cloud inference, so it needs no VRAM. The caps that apply are RAM and CPU. [INFERRED]
- No document gives numeric caps for host-root processes. Host processes run outside any Proxmox cgroup limit. [INFERRED]
- The C0 canary sets per-day ceilings of 30 calls or 90 GPT-Live minutes (`c0-stage2-build-decisions.md` D6). [READ]

**Customer-facing fragility**
- `AGENTS.md:27` and `SERVICE-MATRIX.md:38`: `hermes-customer-sms` (:3014) is a fragile production service. Every change needs a sandbox run, exact SHA, rollback ref, explicit approval, and post-change health checks. Never use a live customer conversation as a test.
- The same standard should apply to the voice line. [INFERRED]

**Other AIWA constraints**
- AIWA has no `sudo`. Use `runuser -u hermes --` (`LINE-CHECK-AND-OPS-DIGEST.md:130`; gateway-autofix `PLAN.md:577`). [READ]
- Never run the pm2 CLI from interactive shells on the Workbench PC (memory `pm2-session0-stray-daemon`; gateway-autofix MISSION hard gate 4). [READ]

---

## 2. Proxmox inventory (read-only MCP, 2026-09-23) [READ]

### 2.1 Node `aiwa`

| Item | Value |
|---|---|
| Platform | PVE 9.2.2, kernel 7.0.2-6-pve, uptime about 14.2 days |
| CPU | i5-13600K: 14 cores, 20 threads; load 0.17 / 0.22 / 0.15 |
| RAM | 62.5 GiB (67.15 GB) total; 16.05 GB used (23.9%); 51.1 GB available |
| Swap | 8 GB total; 0.76 GB used |
| Root filesystem | 100.9 GB; 58.4 GB used; 37.3 GB available |
| `local-lvm` thin pool | 852.9 GB; 168.7 GB used |
| GPU | R9700 32GB (from `infrastructure.md:8`, not from the MCP) |

### 2.2 LXCs (no QEMU VMs)

| VMID | Name | IP | Cores | RAM | Disk | State / notes |
|---|---|---|---|---|---|---|
| 100 | rustdesk | dhcp | 1 | 512 MB | 4G | running; `/dev/net/tun`; mp0 `/mnt/samsung-sata/mav-transfer` |
| 101 | **orca** (sandbox `aiwa-orca` / `aiwa`) | 192.168.1.13 | 4 | 8 GB (+2 GB swap) | 40G (3.3G used) | running; about 0.32 GB RAM in use; unprivileged; nesting=1 |
| 102 | hcp-mcp-prod | 192.168.1.14 | 4 | 8 GB | 40G | running; about 0.99 GB in use |
| 103 | mcc-prod | 192.168.1.15 | 4 | 8 GB | 40G (3.1G used) | running; about 0.34 GB in use; **PLAN2's designated voice target** |
| 104 | mav-fabric | dhcp | 1 | 1 GB | 8G | running; `/dev/net/tun` (fabric/tailnet; the host `mav-fabric-watchdog` restarts it, `infrastructure.md:68`) |
| 200 | rustdesk | – | 1 | 512 MB | 4G | stopped |
| 210 | llama-vulkan | 192.168.1.240 | 8 | 16 GB | 96G | running; about 6.7 GB in use; GPU passthrough |

- Allocated CT RAM is about 41.5 GB of 62.5 GiB. The host-root estate (Hermes lanes, root PM2 grizzly apps, Prometheus, RAG :8181, NUT, and more) uses the rest. [READ, plus INFERRED attribution]

### 2.3 Sandbox candidates [INFERRED]

- **CT101 `orca`** is the designated sandbox (`AIWA-RECIPE.md:69-71`).
  - It is lightly loaded (4c/8G, about 0.3 GB used).
  - `AIWA-ORCA-CUTOVER-RUNBOOK.md:22` says CT101 reaches the PC.
  - A LiveKit agent worker is outbound-only (C0 D1), so it can run a full sandbox test there without Funnel.
- **CT103 `mcc-prod`** is the policy target for production voice (`PLAN2.md:83`). It has headroom (4c/8G, about 0.34 GB used) and its Orca environment is `mcc-prod-103`.

---

## 3. Hermes-Supervisor gateway-autofix

### 3.1 What it is [READ]

`D:\Workspace\Shared\Agents\Hermes-Supervisor\gateway-autofix\PLAN.md` (671 lines):
- Status: "DRAFT, 2026-09-19. Blueprint only" (lines 3-4).
- The whole `gateway-autofix/` folder is **untracked** in the main checkout (`git status` shows `?? gateway-autofix/`; 0 tracked files).

The design (lines 95-131) has these parts:
- a `hermes` monitor, `gateway_autofix.py`, that is deterministic, stdlib-only, and uses no LLM
- a root read-only sensor
- a root action guard driven by request files, with per-action `.path` units
- a Cloudflare Worker external prober
- Twilio Functions for customer fallback and a second probe vantage
- line-check improvements F1-F7

Its purpose is to classify and repair customer SMS and voice ingress failures.

Incident it was written for (lines 60-78):
- 2026-09-18 18:55-21:53: house WAN down.
- 2026-09-19 06:30: inbound broken. Twilio got 11200 "HTTP 502" on `:10000/twiml` while the apps stayed healthy.
- The line check's TwiML probe gave a false pass because `ts.net` resolves tailnet-local on AIWA (line 70).

Tailscale analysis (lines 310-360):
- Issue #21114 on the same version, 1.102.3: after a reconnect, Funnel goes silently dead, `Drop: … no rules matched` appears from `fd7a:` peers, and a tailscaled restart restores it in about 25 s.
- #17892, #19290, #20739, and #20905 describe similar failures.
- Remedy ladder (lines 344-352): restart tailscaled; restun/rebind is manual only; down/up is rejected; funnel reset is manual escalation only.
- Blast radius (line 353): every tailnet connection blips 5-25 s, including in-flight ConversationRelay sockets.
- MISSION.md:7-8: the actual fix was a Carter-approved `systemctl restart tailscaled` through Orca `aiwa-host` at 2026-09-20 00:27. It "WILL recur on the next internet drop".

### 3.2 Did it build a Twilio `voice_fallback_url` for the business line?

It built one and deployed the Functions, but **did not apply it to 3862**. [READ]

- Built on branch `barnscarter-ops/twilio-fallback`, in Orca worktree `C:\Users\carte\orca\workspaces\Hermes-Supervisor\twilio-fallback`.
- Commits: `e8ecbd9` (09-20 01:00), `22a6c50`, `f23f0c2`, `c479e54` (09-20 10:20), plus two made **today**: `476c343` (09-23 12:25, "greet and connect first; apologise only if the forward is not answered") and `020bc8a` (09-23 12:35, "Polly.Matthew-Neural voice for every prompt").
- There is no `origin/barnscarter-ops/twilio-fallback` ref, so the branch appears **not pushed**.
- Files: `gateway-autofix/twilio-fallback/{CHANGE-SET.md, README.md, functions/voice-fallback.protected.js, functions/sms-fallback.protected.js, verify-fallback.mjs, test/*}`.

**URLs and hosts** (`CHANGE-SET.md:28-35`):
- Twilio Serverless Service `grizzly-fallback`, SID `ZScb…1a55`, environment dev `ZEb2…258f`.
- Domain `grizzly-fallback-8197-dev.twil.io`.
- `voice_fallback_url` → `https://grizzly-fallback-8197-dev.twil.io/voice-fallback` (POST).
- `sms_fallback_url` → `https://grizzly-fallback-8197-dev.twil.io/sms-fallback` (POST).
- Primaries stay unchanged: `https://aiwa.tailf72e3f.ts.net:10000/twiml` and the Funnel `/customer` route to :3014 (lines 36-39).

**Behaviour** (branch `README.md:8-12`, and the behavior table):
- Probe number (+1…1546) calls get `<Reject/>`, and probe texts get an empty `<Response/>`, so the line check fails honestly.
- Other callers hear the greeting, then a 20 s screened `<Dial>` to FORWARD_TO (Carter's cell …9870) with a "press 1" whisper and `callerId` set to the caller.
- A call counts as answered only if it is completed and lasted at least 15 s; otherwise it falls through to a voicemail `<Record>` plus an ops page.
- SMS gets one auto-reply plus a masked page to ops.

### 3.3 Why it is host-independent [READ + INFERRED]

- The handlers are Twilio-hosted Functions. They run in Twilio's cloud, not on AIWA, not over Funnel or tailscaled, and not across the house WAN.
- Twilio calls the fallback URL itself, right away, when the primary returns an HTTP error, fails to connect, or times out (11200 family). It returns to the primary on the next event (`PLAN.md:271-287`).
- Twilio recommends hosting fallbacks "on infrastructure separate from the primary" (`PLAN.md:281-282`).
- Twilio credentials are implicit in the Function context (`PLAN.md:304`).
- So it keeps working when the whole house is dark (WAN down) or Funnel silently drops ingress. [INFERRED]

**Caveat that matters for the LiveKit migration** (`PLAN.md:283-284`, [READ]): "`voice_fallback_url` and `sms_fallback_url` are ignored if `voice_application_sid`, `sms_application_sid`, or `trunk_sid` is set on the number."
- If 3862 is attached to a Twilio Elastic SIP Trunk (`trunk_sid`) for LiveKit, the fallback stops working. [INFERRED]
- The C0 design avoids this: VoiceUrl points to a Function `/ingress` that does `<Dial><Sip>` to LiveKit, and TrunkSid and VoiceApplicationSid stay empty (`c0-stage2-build-decisions.md:8-14`). [READ]

### 3.4 Current status [READ]

- `gateway-autofix\.session\STATUS.md:1`: `STATE: BLOCKED-NEEDS-CARTER`. Last updated 2026-09-20 10:24.
- Line 5: build `ZBe7…dcfe` was active on the dev domain. **"The 4 fields on +14698963862 remain NOT SET."**
- Line 13: after Carter's canary re-test and "go", `tf-orch` would set the 4 fields and read them back.
- This matches today's read-only API read: 3862 `voice_fallback_url` is empty.
- STATUS.md was not updated for today's commits `476c343` and `020bc8a`. Whether they are **deployed** to twil.io is unverified (the build SID after 09-20 is unknown).
- `brain\WORKBOARD.md:13` also shows "AWAITING RE-TEST 2026-09-20 10:24 CDT".
- `brain\inbox\2026-09-20-morning-brief-board-lab-twilio-pool.md:29-37`: the item was parked, and tf-orch's pi terminal was left open and idle.
- Other slices of PLAN.md are not built: Cloudflare prober (D4, G1), monitor, root guard, sensor, units (G3-G7), line-check F1-F7 (G8).
- Decisions D5 and D6 were approved 2026-09-20 (`CHANGE-SET.md:63-66, 87-89`). D1-D4 and D7-D11 are open, though an ad-hoc D7-style restart did happen on 09-20.
- Rollback for 3862 is simple: clear the two fallback URL fields (`CHANGE-SET.md:91-97`).

### 3.5 "Gateway Autofix Canary" and …2642

**Documented gateway-autofix canary** (`CHANGE-SET.md:68-81`) [READ]:
- Number **+1…3978**, SID `PN55…b87a`, friendly name "Gateway Autofix Canary", about $1.15/month. Bought under decision D6 on 2026-09-20.
- Primaries are deliberately dead (`https://example.invalid/hook`); the fallbacks are the two Function URLs.
- Its purpose is to test the fallback path end to end without breaking the customer line (`PLAN.md:39-41`). It is kept as "the permanent end-to-end regression line".

**The …2642 number** [READ]:
- The auto-memory note `grizzly-c0-canary-build.md:24` says the C0 subaccount "Grizzly LiveKit GPT-Live Canary" "now owns the number ending 2642, **moved from main at Carter's request**". Its voice URL points to the Functions `/ingress` (…5889-production.twil.io).
- A parent-to-subaccount transfer keeps `friendly_name` (C0 research `docs/2026-09-22-c0-stage2-research/twilio-subaccount-sip-fallback.md:253`, branch `barnscarter-ops/grizzly-livekit-c0-stage1`).
- The C0 readiness plan recommended buying a **new** voice-only number inside the subaccount instead (`c0-stage2-config-readiness-plan.md:34`, F5).

**Why …2642 is named "Gateway Autofix Canary" is not documented anywhere I searched.** Places searched for "2642" and the name:
- Hermes-Supervisor (all files and both branches)
- the twilio-fallback worktree `gateway-autofix/`
- the C0 branch (git grep) and the C0 worktree `canary/c0` and `docs`
- the brain vault (excluding jsonl logs)
- the auto-memory folder

Hypotheses [INFERRED], none verified:
- (a) The gateway-autofix team (tf-orch) bought or labelled …2642 on the main account during the 09-20 D6 purchase (a first attempt or duplicate), and only …3978 was recorded.
- (b) Someone relabelled …2642 on main before the C0 move.

Either way the label came with …2642 when it moved to the subaccount.

Suggested read-only check: Twilio `IncomingPhoneNumbers` on main for …3978, and on the subaccount for …2642. Compare `date_created`, `sid`, and `friendly_name`. Also confirm …3978 still has dead primaries and fallback URLs, and that …2642's fallback fields no longer point at `grizzly-fallback` (which would hit the gateway-autofix canary behaviour). [INFERRED]

---

## 4. Line check (06:30 and 21:00)

Sources: `D:\Workspace\Shared\Agents\Hermes-Supervisor\line-check\{README.md, line_check.py, systemd\*}` and `docs\LINE-CHECK-AND-OPS-DIGEST.md`.

### 4.1 Schedule, host, and runtime [READ]

- Applied live on AIWA **host** on 2026-09-15 from commit `8f9fca8` through Orca `aiwa-host`, with per-step approvals (`LINE-CHECK-AND-OPS-DIGEST.md:3-28`).
- `mav-line-check.timer:5-6`: `OnCalendar=*-*-* 06:30:00 America/Chicago` and `21:00:00`, with `Persistent=true`.
- `mav-line-check.service:8-13`: `User=hermes`, `EnvironmentFile=/home/hermes/.hermes/line-check.env`, `ExecStart=/opt/hermes-venv/bin/python /opt/mav-line-check/line_check.py --window auto`, `TimeoutStartSec=600`, `OnFailure=mav-line-check-failed.service`.
- Code is installed at `/opt/mav-line-check/line_check.py`, with `notify.py` copied in (README 112-133).

### 4.2 Who calls whom, and from which number [READ]

- The **probe** is the ops line **+1…1546** (…1546). The **target** is the customer line **+1 469-896-3862** (…3862) (`LINE-CHECK-AND-OPS-DIGEST.md:39-40, 59-68`).
- Configuration comes from `load_config` (`line_check.py:255-295`):
  - customer is `LINE_CHECK_CUSTOMER_NUMBER`, falling back to `TWILIO_PHONE_NUMBER` (line 260)
  - probe is `LINE_CHECK_PROBE_NUMBER`, falling back to `OPS_SMS_FROM` (line 261)
  - it refuses to run if probe or `OPS_SMS_FROM` equals the customer number (lines 276-280)
- The env file is built by `tools/aiwa-install-line-check-env.py:79-101`. It copies from `/home/hermes/.hermes/profiles/customer-sms/.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (becomes customer), `OPS_SMS_FROM` (becomes probe), and `OPS_SMS_TO`.
- The Slack token comes from `triage-slack.env`.
- The installer **hardcodes** `LINE_CHECK_TWIML_URL=https://aiwa.tailf72e3f.ts.net:10000/twiml` and `LINE_CHECK_VOICE_HEALTH_URL=http://127.0.0.1:8765/health` (lines 100-101).
- Both numbers must be on the one Twilio account in `TWILIO_ACCOUNT_SID` (README 45).

### 4.3 What it asserts [READ]

**SMS**
- 1546 texts 3862: "Maverick line check … Ref <hex>".
- Pass means any reply from 3862 to 1546 arrives within 150 s (`LINE-CHECK-AND-OPS-DIGEST.md:59-64`).
- The reply is dropped silently by hermes-pc-sms (`unauthorized_dm_behavior: ignore`).

**Voice** (`line_check.py:537-676`)
1. `GET LINE_CHECK_VOICE_HEALTH_URL` (default `http://127.0.0.1:8765/health`) must return 200 (lines 554-559).
2. `POST LINE_CHECK_TWIML_URL` with a fake CallSid must return 200 and a body that **contains `<ConversationRelay` and `ttsProvider="`** (lines 561-583; the check is hardcoded at 577-583).
3. A real call from 1546 to 3862 with TwiML `<Pause length="20"/><Hangup/>` (lines 593-595).
4. Pass requires status `completed`, `duration >= 10` (`MIN_CALL_SECONDS`, line 75), `twiml_ok`, and **no Twilio Monitor alert** on either leg after a 30 s settle (lines 661-675).

**Line-alert scan**: informational only (README 36-39).

**Paging**
- Silent on success.
- On failure, it pages by SMS from 1546 to Carter and by Slack through `notify.notify_channels`.
- Exit 3 means the page failed; exit 2 means the check could not run and the `OnFailure` page fires.
- `hermes-triage` fires `line_check_stale` if `line-check.json` is older than 16 h (`LINE-CHECK-AND-OPS-DIGEST.md:73-89`).

**State**: `/home/hermes/.hermes/state/line-check.json`, read by the morning brief through the aiwa-ops `get_line_check_status`.

**Known blind spot**: the TwiML probe resolves `ts.net` tailnet-locally on AIWA, so it proves only that the app can build TwiML, not that public ingress works (`gateway-autofix/PLAN.md:70-75, 358-360`).

### 4.4 Pointing it at a new voice path (LiveKit + gpt-live-1) [INFERRED from READ code]

1. **URLs.** Change them in `/home/hermes/.hermes/line-check.env` (`LINE_CHECK_TWIML_URL`, `LINE_CHECK_VOICE_HEALTH_URL`) and in the installer defaults (`tools/aiwa-install-line-check-env.py:100-101`). This is an approved credential/env-file action under the runbook.
2. **Code change needed.** The TwiML assertion is hardcoded to `<ConversationRelay` plus `ttsProvider=` (`line_check.py:577-583`). A LiveKit path returns something else, for example C0's Function `/ingress` returns `<Say>`, then `<Dial><Sip>`, and needs a Twilio signature. The voice test would fail and skip the call.
   - The fix is either a configurable expected-marker env var or a new mode that skips the local TwiML probe and relies on the real call.
   - `--skip-voice` exists only as a CLI flag. The unit's `ExecStart` is fixed, so using it means a unit edit plus `daemon-reload` (approval).
3. **Probe caller admission.** The real call comes from 1546.
   - C0's `/ingress` sends callers who are not on the staff allowlist to `/fallback`, which screen-transfers to the office or backup. That would ring humans at 06:30 and 21:00. [READ design, `c0-stage2-build-decisions.md:9-17`]
   - The gateway-autofix `/voice-fallback` rejects `PROBE_NUMBERS`.
   - The new ingress needs an explicit probe policy: either answer the probe with the agent, or reject it so the check fails honestly. It must never forward the probe.
4. **Pass semantics.** With a `<Pause 20/>` caller, the agent will greet and hear silence. Pass requires `completed` and at least 10 s, and no alerts. If the agent hangs up early on silence, or the call goes to fallback and voicemail, the result could be a false fail or a false pass. Define what "voice OK" means for the new agent. One option is to also check that LiveKit or agent logs show first audio, as the C0 detector does.
5. **Account scope.** If 3862 moves to a Twilio subaccount, the line check's `Calls.json`, `Messages.json`, and Monitor Alerts queries under the main `TWILIO_ACCOUNT_SID` will not see the subaccount's legs and alerts. Twilio lists resources per account. The line-check env needs subaccount-aware credentials or path.
6. **Downstream readers that also assume voice-server:**
   - `ops-digest` reads `/opt/grizzly-hcp/data/{pending-bookings.jsonl, voice-messages.jsonl, audit.jsonl}` (`ops-digest/ops_digest.py:500-505`). The new agent must write compatible records or the 22:00 digest loses voice outcomes.
   - The new root `voice-watchdog` (branch `barnscarter-ops/voice-watchdog`, `deploy/aiwa/voice-watchdog.service`, every 2 min) keys on `VOICE_PUBLIC_URL`, ConversationRelay/WebSocket probes, and Funnel drops. It needs re-pointing too.
7. **Fallback plus line check.** If D5 fallback URLs are set on 3862, apply line-check F6 (`gateway-autofix/PLAN.md:374`). Otherwise an SMS fallback auto-reply, or a non-probe-aware voice fallback, turns a broken primary into a false pass.

---

## 5. grizzly-hcp voice deploy configuration

Repo: `D:\Workspace\Active\grizzly-hcp`.

### 5.1 Git state [READ]

- Main checkout is at HEAD `ac42ac9` on `main`.
- Worktrees:
  - `D:\Workspace\Active\grizzly-hcp\voice-watchdog` (branch `barnscarter-ops/voice-watchdog`, `b7cb4ed`, untracked `voice-watchdog/` in main)
  - `C:\Users\carte\orca\workspaces\grizzly-hcp\grizzly-livekit-c0-stage1` (`102bc6a`)

### 5.2 `ecosystem.config.cjs` at HEAD (lines 1-67) [READ]

- Five PM2 apps, all `node_modules/tsx/dist/cli.mjs` with `cwd: __dirname`: `mav-email-watcher`, `customer-chat-server`, **`voice-server`** (lines 32-41, `src/agent/voice-server.ts`, `autorestart`, `max_restarts: 10`, `restart_delay: 5000`), `booking-approval-poller`, `sync-estimates-weekly`.
- The file sets **no port or env**. Settings come from `.env` through `dotenv/config` (line 8).
- The AIWA clone `/opt/grizzly-hcp` had HEAD `dc31c9b`, with `ecosystem.config.cjs` checked out from `7bc341b` (mav-slack retired). The AIWA root PM2 dump holds exactly those 5 apps (`brain\inbox\2026-09-02-aiwa-ups-move-prep.md:196-206`).
- AIWA boot uses `pm2-root.service` (oneshot resurrect) (`infrastructure.md:30`).

### 5.3 Voice-server ports and routes (`src/agent/voice-server.ts`) [READ]

- `PORT = VOICE_PORT ?? 8765` (line 40).
- `PUBLIC_URL = VOICE_PUBLIC_URL ?? 'https://voice.grizzlyelectrical.net'` (line 41). That hostname is stale; the live path is Funnel `:10000` (helm findings lines 64, 113).
- Routes: `GET /health` (line 199), `POST /twiml` which returns `<Connect><ConversationRelay …ttsProvider…>` (lines 205-212), and WebSocket `/ws` (line 16). It listens at line 491.

### 5.4 Ingress: Tailscale Funnel on the host [READ]

- Voice: `https://aiwa.tailf72e3f.ts.net:10000` → 127.0.0.1:8765 (helm findings line 32; `JOURNAL.md:817, 866`; line-check default at `line_check.py:57`).
- SMS: Funnel `/customer` → :3014 (`SERVICE-MATRIX.md:38`).
- Funnel also serves `/` and `/pc` (`gateway-autofix/PLAN.md:351`).
- Funnel listens only on 443, 8443, and 10000 (`PLAN.md:314`).
- The grizzly-hcp repo itself contains **no** Funnel or `tailscale serve` config. Its only references are in the employee-SMS plan docs (`docs/superpowers/plans/2026-07-03-employee-sms-chatbot.md:40, 532, 543`).
- The C0 build-decisions doc (line 25) says "production is exposed through a Proxmox-hosted Cloudflare tunnel". That **conflicts** with every other source, which say Tailscale Funnel. [READ; the judgment that it is wrong is INFERRED]

### 5.5 `deploy/` folder at HEAD [READ]

- `deploy/aiwa/`: `hcp-catalog-sync.{service,timer,env.example}` and `hcp-estimates-sync.{service,timer,env.example}`. Each has its own `/opt/<svc>` and own `EnvironmentFile`, following the matrix.
- `deploy/ct103/`: `booking-approval-poller.service`, `booking-poller.env.example`, `README-BOOKING-POLLER.md`. The CT103 template keeps `/opt/grizzly-hcp` as the install root.
- `deploy/mav-rag/`.
- **No voice-server unit or voice deploy doc exists on main.** The docs present are `docs/AIWA-DEPLOY-catalog-sync.md` and `docs/AIWA-DEPLOY-sync-estimates.md`.
- The voice-watchdog branch adds `deploy/aiwa/voice-watchdog.{service,timer}`:
  - `User=root`, `WorkingDirectory=/opt/grizzly-hcp`, `EnvironmentFile=/opt/grizzly-hcp/.env`, `TZ=America/Chicago`, 2-minute timer.
  - `docs/AIWA-DEPLOY-voice-watchdog.md`, which says every server action needs approval and must go through the gated Orca AIWA runtime (line 3).
  - The watchdog shares the voice-server `.env`. That diverges from the one-EnvironmentFile-per-service rule. [INFERRED]

### 5.6 Env variable NAMES only [READ]

- `.env.example` at HEAD includes `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `CUSTOMER_CHAT_PORT`, `OPS_TWILIO_ACCOUNT_SID`, `OPS_TWILIO_AUTH_TOKEN`, `OPS_SMS_FROM`, `OPS_SMS_TO`, `PUBLIC_URL`, `EMPLOYEE_PHONE_NUMBER`, `VOICE_TTS_PROVIDER`, `VOICE_TTS_VOICE`, `HCP_VIA_MCP`, `HCP_MCP_URL`, `HCP_MCP_TOKEN`, plus Venice and ZAI keys.
- The local PC `.env` also carries `VOICE_PORT`, `VOICE_PUBLIC_URL`, `CARTER_PHONE`, `JAIME_PHONE`, and others.
- The AIWA `/opt/grizzly-hcp/.env` gained `VOICE_TTS_PROVIDER`, `VOICE_TTS_VOICE`, and four `OPS_*` keys on 2026-09-14 (`JOURNAL.md:829-832`).

---

## 6. Implications for "LiveKit Cloud + gpt-live-1 agent on AIWA" [INFERRED]

- **Placement.** Policy points to a service LXC (CT103, or a new CT), not host root. Host root is "host responsibilities only", and PLAN2 already names CT103 as the voice target after a readiness review. Staying on host root would need an explicit, recorded exception from Carter.
- **Rollout.** Sandbox in CT101 (`aiwa-orca`) through Orca first. Then an exact pushed SHA, a rollback ref, and approval before any unit, timer, or restart.
- **Ingress.** A LiveKit agent worker is outbound-only, so the media path needs no Funnel. Twilio routing to LiveKit can be a Twilio Function `/ingress` with `<Dial><Sip>` (C0 D1), keeping `trunk_sid` empty so `voice_fallback_url` stays effective. This removes the tailscaled Funnel ingress failure (#21114, 64102/11200) from the voice path. SMS remains on Funnel `/customer`.
- **Supervisor.** Use systemd, one unit, with its own `EnvironmentFile` (0600, service user) holding the LiveKit and OpenAI keys. Not PM2, and not the shared `/opt/grizzly-hcp/.env`. Set bounded `Restart=on-failure`, `TZ=America/Chicago`, and a health check. Add explicit `MemoryMax=` and `CPUQuota=`, or rely on CT limits, to meet the VRAM doc's "hard ceilings" rule.
- **Line check, watchdog, and digest.** All three need coordinated changes (section 4.4). The line-check voice assertion is ConversationRelay-specific code, not config.
- **Gateway-autofix fallback.** It can protect the new path unchanged if the number keeps a plain `voice_url` (no trunk or app SID). Its 4 fields on 3862 are still unset, and the canary …3978 is the regression line for it.
