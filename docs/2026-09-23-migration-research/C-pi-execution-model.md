# C: Pi execution model, grounded facts (research 2026-09-23)

Read-only research. No agents or terminals launched, no calls to model providers, and no secrets read (auth.json and its backups were not opened; key-like fields were stripped when parsing model files).
CLIs run: `orca --help`, `orca terminal --help`, `orca terminal {create,read,send,wait,close,list} --help`, `orca worktree create --help`, `orca orchestration --help`, `orca orchestration worker-start --help`, `orca --version` (1.4.206), `pi --help`, `PI_OFFLINE=1 pi --version` (0.84.3), `PI_OFFLINE=1 pi list`.
Path aliases used below: `BRAIN` = `D:\Workspace\Active\brain` (C:\Workspace is a junction to D:\Workspace). `PIA` = `C:\Users\carte\.pi\agent`. `PSUB` = `PIA\npm\node_modules\pi-subagents`. `PIDOCS` = `C:\Users\carte\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs`. `BL` = `D:\Workspace\Active\Coding_Practice\.session\board-lab`. `TF` = `D:\Workspace\Shared\Agents\Hermes-Supervisor\gateway-autofix\.session`.

---

## 1. Launching a Pi orchestrator in Orca: VERIFIED

### 1a. Orca side
- Command form: `orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--shell <shell>] [--focus] [--json]`. `--command` is typed into the host's default shell. `--shell` selects `cmd.exe|powershell.exe|pwsh.exe|wsl.exe|bash.exe|git-bash`. Worktree selectors: `path:`, `id:<repo-id>::<path>`, `branch:`, `name:`, `active`. (Source: `orca terminal create --help`.)
- A new checkout comes from `orca worktree create --name <n> --repo <selector> [--base-branch <ref>] [--parent-worktree <sel> | --no-parent] --json`. The help text says to use `terminal create` for a fresh agent in an existing worktree. (Source: `orca worktree create --help`.)
- Established pattern for a specific provider and model: `orca terminal create --command "pi --provider <provider> --model <model>"`. Do NOT use `worktree create --agent/--model`, which does not carry arbitrary provider/model combinations. This was confirmed working for `deepseek --model deepseek-v4-pro` and `zai --model glm-5.3`. Verify the launch with `orca terminal read --limit 500`, where the status line shows `(provider) model`. (`BRAIN\inbox\2026-09-23-gpt-live-1-migration-handoff.md:17`; the same pattern with `deepseek-v4-pro • medium` in the status line is at `BRAIN\inbox\2026-09-22-chief-willcall-fixes-done.md:38`.)
- `orca orchestration worker-start --agent pi` rejects `--model`, so pi's settings default is applied instead (`BRAIN\inbox\2026-09-01-g4-nl-intake-live.md:12`). `worker-start --model` accepts only Claude, Codex and Cursor model ids, and it cannot be combined with `--terminal` (`orca orchestration worker-start --help`). A Pi terminal already created can be brought under Orca supervision with `worker-start --terminal <handle> --spec "..."` (`...chief-willcall-fixes-done.md:38`). That supervision was a Claude-coordinated pattern. It was not used by the Pi-orchestrator teams.
- Monitoring verbs: `orca terminal read [--terminal <h>] [--cursor <n>] [--limit <n>] [--screen]`, `terminal send --text <t> --enter`, `terminal wait --for exit|tui-idle --timeout-ms`, `terminal close ([--terminal <h>] [--tab] | --worktree <sel> --all)`, `terminal list [--worktree <sel>]` (subcommand `--help` output).
- Known failures (`BRAIN\tool-failures.md:31-38`):
  - A long `terminal send` into a pi TUI can return ok and never arrive. Read the terminal back after every send and prefer short messages.
  - `terminal close` can fail or leave the session alive. Re-list to confirm it closed.
  - Git Bash rewrites `/new`-style text. Set `MSYS_NO_PATHCONV=1` (`tool-failures.md:57-58`).

### 1b. pi CLI flags (`pi --help`, v0.84.3)
- `--provider <name>`, `--model <pattern>` (accepts `provider/id` and an optional `:<thinking>`), `--thinking off|minimal|low|medium|high|xhigh|max`, `--name/-n`, `--append-system-prompt <text|file>` (repeatable), `--tools/-t <allowlist>`, `--continue/-c`, `--session-id <id>`, `--no-context-files/-nc`.
- **`--extension, -e <path>`: "Load an extension file (can be used multiple times)"**.
- **`--no-extensions, -ne`: "Disable extension discovery (explicit -e paths still work)"**.
- `PIDOCS\usage.md:221-235`: "Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings", with the example `pi --no-extensions -e ./my-extension.ts`. `-e` also accepts `npm:`/`git:` specs, but those are installed into a temporary directory for that run (`PIDOCS\packages.md:45-49`). An explicit list should therefore use absolute paths to the already-installed entry files.

### 1c. Extensions available (for building the explicit list)
Installed packages come from `PIA\settings.json:106-121` and are confirmed by `pi list`. Entry files are taken from each package's `package.json` `pi.extensions`.

| Package (version) | Entry file to pass with `-e` | Role |
|---|---|---|
| pi-subagents 0.67.0 | `PIA\npm\node_modules\pi-subagents\index.ts` | delegation tool plus native supervisor bridge. **Required** |
| @ctliz/agent-intercom-pi 0.12.2 | `PIA\npm\node_modules\@ctliz\agent-intercom-pi\index.ts` | intercom broker/tools (`AGENT_INTERCOM_SCOPE_ID`) |
| @pi-orca/messages 0.0.5 | `PIA\npm\node_modules\@pi-orca\messages\dist\index.js` | pi-to-pi "message" tool. **Not the Orca app**: `PIA\orca\config.yaml` belongs to it |
| pi-web-access 0.29.0 | `...\pi-web-access\index.ts` | web_search / fetch_content |
| pi-mcp-adapter 2.32.1 | `...\pi-mcp-adapter\index.ts` | MCP tools |
| pi-studio 0.9.60 | `...\pi-studio\index.ts` | TUI theme/studio |
| pi-provider-kimi-code, pi-xai-oauth | (provider extensions) | only needed for those providers |
| git ponytail; `D:\Workspace\Active\pi-agents\qwen-*` (4) | local packages | not needed for this model |
| **@arhen/pi-core-vision 1.0.7** | `...\@arhen\pi-core-vision\index.ts` | **OMIT** (see section 4) |

Auto-discovered local extensions in `PIA\extensions\` are also dropped by `-ne` unless passed with `-e`:
- `orca-agent-status.ts` and `orca-prefill.ts`, both headed `// @orca-managed-pi-extension` (these drive Orca's agent status)
- `orca-titlebar-spinner.ts`
- `rtk.ts`
- `context-compress.ts`
- `zai-code\index.ts`

This is a directory listing plus the file headers.

### 1d. Intercom scope id
- Scope id is set with the env var `AGENT_INTERCOM_SCOPE_ID` in the shell before `pi` starts. PowerShell form: `$env:AGENT_INTERCOM_SCOPE_ID = "<id>"; pi ...` (`PIA\team\README.md:54,68-72`; Git Bash `export` form at `:76-80`; intercom `README.md:36-44`).
- Validation regex: `^[A-Za-z0-9_-]{16,128}$` (`PIA\npm\node_modules\@ctliz\agent-intercom-core\dist\protocol-v4.js:5-6`). The missions record that "shorter ids make the extension refuse to load" (`BL\MISSION.md:39`, `TF\MISSION.md:27`).
- Previous ids: `board-lab-build-20260920` and `twilio-fallback-20260920`, both 24 characters (`BL\MISSION.md:3`, `TF\MISSION.md:3`). The team README scope `Debate` would now fail (`BRAIN\inbox\2026-09-20-morning-brief-board-lab-twilio-pool.md:46`).
- On Windows, set `PI_INTERCOM_TRANSPORT=tcp` if the named pipe broker fails (`PIA\team\README.md:56`). Intercom config: `PIA\intercom\config.json` (`enabled:true`, `inboundTrigger:"always"`, `confirmSend:false`).

### 1e. Model strings and defaults
- Orchestrator on GLM: `zai/glm-5.3`, i.e. `--provider zai --model glm-5.3`. Used by `tf-orch` (`TF\MISSION.md:3`; `BRAIN\WORKBOARD.md:13`) and confirmed live on 2026-09-23 (`...gpt-live-1-migration-handoff.md:17`).
- `glm-5.3` is **not** in `enabledModels` (`PIA\settings.json:10-35`) and is **not** in the `zai` provider block of `PIA\models.json:142ff`. It resolves from the downloaded catalog at `PIA\models-store.json:3358` (zai section starting at `:3225`).
- The `zai` provider baseUrl is `https://api.z.ai/api/coding/paas/v4`, the Coding Plan endpoint (`PIA\models.json:142-143`).
- Pi defaults: `defaultProvider: deepseek`, `defaultModel: deepseek-v4-flash`, `defaultThinkingLevel: medium` (`PIA\settings.json:4-6`). **A launch without explicit flags therefore lands on v4-flash, not v4-pro.**
- `C:\Users\carte\.claude\skills\build-handoff\SKILL.md:94` still claims the default is `deepseek-v4-pro`. That is stale; the default was changed on 2026-09-14 per `settings.json.bak-defaultmodel-20260914`.
- Orchestrators used in earlier runs:
  - `openai/gpt-6-astra` with thinking medium (`BL\MISSION.md:3`)
  - `bl-orch2` on gpt-6-astra (`BL\MISSION-1.5.md:3`)
  - `zai/glm-5.3` (`TF\MISSION.md:3`)

### 1f. Recorded workaround (the exact list was NOT recorded)
- "`@arhen/pi-core-vision` overrides pi's builtin `read` ... Worked around per session with `pi -ne -e <explicit extensions>`; his global config is unchanged" (`BRAIN\inbox\2026-09-20-morning-brief-board-lab-twilio-pool.md:45`).
- `TF\STATUS.md:17`: "pi relaunched with `--continue`; subagent extension list adjusted (builtin read)".
- `PIA\settings.json:120` still lists `npm:@arhen/pi-core-vision`, so the global config is indeed unchanged.

**Reconstructed template. NOT verified as the command actually run; assembled from 1b-1e:**
```
orca terminal create --worktree path:<worktree> --title "<WP> — orchestrator" --command
  '$env:AGENT_INTERCOM_SCOPE_ID="<wp-slug>-<yyyymmdd>"; pi -ne
   -e C:\Users\carte\.pi\agent\npm\node_modules\pi-subagents\index.ts
   -e C:\Users\carte\.pi\agent\npm\node_modules\@ctliz\agent-intercom-pi\index.ts
   -e C:\Users\carte\.pi\agent\extensions\orca-agent-status.ts   (optional; see open item 2)
   --provider zai --model glm-5.3 --thinking medium --name <wp>-orch'
```
Then send a short first message that points at `.session\<wp>\ROLE-orchestrator.md` and `MISSION.md`. Verify with `orca terminal read --limit 500`.

---

## 2. pi-subagents "supervisor bridge": VERIFIED

- **What it is.** It is pi-subagents' own coordination channel. The child calls `contact_supervisor` with `reason` set to `need_decision`, `interview_request` or `progress_update`. The parent answers with `subagent_supervisor({action:"reply", replyTo, message})` or checks queued questions with `subagent_supervisor({action:"pending"})`.
- Messages are "scoped to the exact Pi session id that spawned the child". The bridge does not require the external intercom package (`PSUB\docs\workflows.md:424-460`; `PSUB\docs\configuration.md:399-421`).
- Brain summary: "pi-subagents' 'intercom bridge' is its native `contact_supervisor` / `subagent_supervisor` channel; children do not appear as peers in `@ctliz/agent-intercom-pi` unless their agent definition loads it" (`morning-brief...:46`).
- Observed in practice: "Intercom no peers; native supervisor used, no restarts" (`BL\STATUS-1.5.md:9`).
- **Config** (`PIA\settings.json:50-105`):
  - `subagents.defaultModel: zai-code/glm-5-turbo`, `defaultThinking: medium`, `maxSubagentDepth: 1`
  - `intercomBridge: {mode: "always", resultDelivery: true}`
  - `agentOverrides`: `planner` → zai-code/glm-5.2, `researcher` → deepseek-v4-flash, `reviewer` → zai-code/glm-5.2
- **Consequence of the overrides:** built-in reviewer and scout children do NOT default to v4-pro. The orchestrator must pass `model: "deepseek/deepseek-v4-pro"` explicitly, as Board Lab did (`BL\workflow.js:1,6`).
- Docs: `resultDelivery` should be `true` "only when an external listener consumes `subagent:result-intercom`" (`configuration.md:417`). The current `true` is probably unnecessary; flag it for review.
- There is no `PIA\extensions\subagent\config.json`, so documented defaults apply:
  - `globalConcurrencyLimit` 20 (`configuration.md:282-288`)
  - `maxSubagentSpawnsPerRun` 64 (`:302-312`)
  - per-session spawns unlimited (`:292-298`)
  - a 30-minute default run timeout for foreground and single async runs (`configuration.md:258-266`). Board Lab hit it: "One 30min Windows timeout recovered via native same-protocol resume" (`BL\STATUS-1.5.md:9`).
- **Ambient-extension inheritance, which is the pi-core-vision vector:**
  - Background children load the parent's ambient extensions unless the agent sets `extensions:`. Foreground children never do (`PSUB\docs\agents.md:323,412`).
  - `subagents.defaultExtensions` in settings applies one allowlist to every agent that does not declare its own (`agents.md:449`). It is a candidate permanent fix, not yet applied.
- **Spawn API used before** (workflowScript): `runs.run(key, {...})` and `runs.all([...])`, with items shaped `{agent, label, model, cwd, context:"fresh", task, output, key, acceptance}` (`BL\workflow.js:1-6`, `BL\workflow-1.5.js:1-4`).
  - Every child passed `model: "deepseek/deepseek-v4-pro"`.
  - Writers used `agent: "feature-implementer"`; the scout used `scout`; reviews used `reviewer`.
  - The child brief carried the parent session id ("Parent ID 01a0bd5d-...", `BL\assignments.json:2`).

---

## 3. feature-implementer agent: VERIFIED

`PIA\agents\feature-implementer.md:1-25`:
- `model: deepseek/deepseek-v4-pro`
- `tools: read, grep, find, ls, bash, edit, write, contact_supervisor`
- `skills: feature-workflow`, `systemPromptMode: append`, `inheritProjectContext: true`, `inheritSkills: false`
- `defaultContext: fork` (Board Lab overrode it to `fresh`)
- `acceptanceRole: writer`, `maxSubagentDepth: 0`
- No `extensions:` field, so a background instance inherits the parent's ambient extensions.

Body: edit only the files named in the plan, otherwise `contact_supervisor reason:"need_decision"`. No git commit, push, fetch, pull, reset, clean or unscoped staging. No dependency, lockfile, CI, credential, infrastructure or service changes. Return the `feature-workflow` result contract: an uncommitted, review-ready diff.

Sibling agent: `PIA\agents\planner.md:1-18` (zai-code/glm-5.2, fallback deepseek-v4-pro, read-only).

Conflicts to resolve in the plan:
- `PIA\skills\feature-workflow\SKILL.md:28-32` says "launches exactly one `feature-implementer` ... Do not run parallel writers" and requires user approval before invoking it. The Pi teams ran 2-3 writers in parallel on disjoint repos (`BL\workflow.js:3`, `BL\workflow-1.5.js:1`) under "keep at most 3 alive" (`BL\ROLE-orchestrator.md:6`).
- `BRAIN\workflows\feature-implementation.md:77` still calls `feature-implementer` "a local-Qwen, one-worktree writer". That is stale.

---

## 4. pi-core-vision read-tool breakage: VERIFIED

- `@arhen/pi-core-vision` 1.0.7 registers a tool named `read` ("overrides built-in read") at `...\@arhen\pi-core-vision\index.ts:85-86`, with the README at `:24` saying "Overrides the built-in `read` tool".
- Its vision backend is `zai-vision/glm-4.6v` (`C:\Users\carte\.pi\pi-vision.json`).
- Observed effect: `pi-subagents` refuses `scout`/`reviewer` children and starts other children without `read` (`morning-brief...:45`).
- Workaround: `pi -ne -e <explicit list>` omitting it. Carter's decision to drop the extension or load it conditionally is still open (same line).

---

## 5. STATUS.md protocol: VERIFIED (two instances, identical core)

- **Where:** in the main checkout, under `.session\` (not committed).
  - `D:\Workspace\Active\Coding_Practice\.session\board-lab\STATUS.md` (`BL\MISSION.md:43,50`)
  - `...\Hermes-Supervisor\gateway-autofix\.session\STATUS.md` "in the main checkout path", even though work ran in an Orca worktree (`TF\MISSION.md:31`)
  - A second round used a new pair of files: `MISSION-1.5.md` / `STATUS-1.5.md` (`BL\MISSION-1.5.md:27`).
- **Who writes it:** only the orchestrator ("You own `STATUS.md`", `BL\MISSION.md:38`). Children are told "Parent owns STATUS.md and WORKBOARD.md" (`BL\assignments.json:2`).
- **Format:**
  - The first line is exactly one of `STATE: WORKING` | `STATE: BLOCKED-NEEDS-CARTER` | `STATE: DONE-AWAITING-APPROVAL` | `STATE: DONE`.
  - Optional one-line track states follow (`WINDOWS:` / `IOS:`).
  - Then newest-first CDT-timestamped bullets: decisions with reasons, what each worker is doing, build/test results.
  - Under BLOCKED or DONE-AWAITING-APPROVAL, the exact question or change set Carter must approve, "with cost and blast radius in a few words".
  - Keep it under one screen (`TF\MISSION.md:29-38`; `BL\MISSION.md:41-50`).
- **Cadence:** "at every milestone and at least every ~20 minutes while working" (same lines).
- **Done:** set `STATE: DONE-AWAITING-APPROVAL` and stop (`TF\MISSION.md:42`, `BL\MISSION.md:54`).
- **Session folder kit:** `MISSION.md` (goal, defaults, hard gates, STATUS protocol, definition of done), `ROLE-orchestrator.md`, `ROLE-worker.md` (a preamble pasted at the top of every child brief), `STATUS.md`, plus `ACCEPTANCE.md`, `evidence\`, `workflow*.js`, `assignments.json` (`BL\` listing; `TF\` listing).
- **Monitor protocol:**
  - The Claude session reads STATUS.md and the terminals only.
  - Typed messages are prefixed `CARTER:` (Carter's words verbatim) or `MONITOR:` (a status request or nudge, "never approval for a gated action") (`TF\ROLE-orchestrator.md:11`; `BL\ROLE-orchestrator.md:11`; `morning-brief...:37`).
- **Orchestrator rules from ROLE-orchestrator.md:6-10 (both instances):**
  - delegate all implementation
  - children run in the background, at most 3 alive
  - briefs name exact disjoint files and include the hard gates
  - "Verify, never relay": read the diffs and run the tests yourself
  - a stall of more than ~10 minutes means asking for status, then re-dispatching with a tighter brief, and recording it
  - `BLOCKED-NEEDS-CARTER` only for a real gate
- **Workspace-level rules:**
  - WORKBOARD row per workstream, updated at spawn, milestone and exit.
  - Terminal title `<workstream> — <role>`.
  - Max 2 active workstreams machine-wide (`BRAIN\WORKBOARD.md:3-9`; `D:\Workspace\Shared\Agents\AGENTS.md:93-97`).
  - Example row: `BRAIN\WORKBOARD.md:13`.

---

## 6. Cost and pricing: VERIFIED where cited

Pi catalog units are USD per 1M tokens (`PIDOCS\models.md:210`).

| Model | Source | Input / Output / Cache-read ($/1M) |
|---|---|---|
| deepseek/deepseek-v4-pro | Carter's override `PIA\models.json:109-121` (deepseek provider) | 1.10 / 4.40 / 0.14 |
| deepseek-v4-pro | downloaded catalog `PIA\models-store.json:650` (deepseek, section at :602) | 1.32 / 3.96 / 0.044 |
| zai/glm-5.3 | catalog `PIA\models-store.json:3358` | 1.40 / 4.40 / 0.26 (1M ctx, 131k max out) |
| openai(-codex)/gpt-6-astra | catalog `PIA\models-store.json:5153` | 10 / 50 / 1; above 272k input: 20 / 75 |
| deepseek-v4-flash (default) | `PIA\models.json` | 0.14 / 0.28 |

- Observed spend: "`bl-orch` spent roughly $20+ on GPT-6 Astra (large context re-read each step); the deepseek children were cents each" (`morning-brief...:27`).
- De facto cap seen before: DeepSeek is prepaid. On 2026-09-07 it "returned `402 Insufficient Balance` and killed all three pi workers on first call" (`BRAIN\inbox\2026-09-07-fb-boost-tick.md:17`).
- **No per-package cost cap or budget enforcement has been used before.** grep across BRAIN, `BL`, `TF` and Shared\Agents found no `usageBudget`/`costUsd`/cost-cap use.
- Available mechanisms in the installed pi-subagents:
  - `usageBudget {tokens?, costUsd?: {soft?, hard}}`. It is root-only. A hard limit "prevent[s] later child launches ... already-running children are not stopped" (`PSUB\docs\tool-reference.md:119`). The docs advise against tight usage budgets on writers (`:129-133`).
  - `toolBudget` (`:118`).
  - `subagents.modelScope {enforce, strict, allow, agents}` to pin child models, for example to `deepseek/deepseek-v4-pro` (`PSUB\docs\models.md:255-285`).
  - Spawn caps: `maxSubagentSpawnsPerRun` / `maxSubagentSpawnsPerSession` (`configuration.md:292-312`).
  - Live cost display: FleetView shows "aggregate cost" (`PSUB\docs\observability.md:13`).
  - None of these caps the orchestrator's own spend.

---

## 7. Earlier runs (Pi-orchestrated vs Claude-coordinated)

- **Pi orchestrator + pi-subagents, Claude monitors (the target model):**
  - Board Lab slice 1: `bl-orch`, gpt-6-astra, children `bl-scout`/`bl-win`/`bl-ios`/`bl-review` on v4-pro, 2026-09-20 00:45-02:25 CDT.
    - Orchestrator cwd was the Coding_Practice main checkout; children were in a new local repo and a CircuitCoach Orca worktree (`BL\MISSION.md:3,11,22-24`).
    - Result `DONE-AWAITING-APPROVAL` (`BL\STATUS.md:1-9`).
    - Post-mortem notes: `morning-brief...:5-27,45-46`.
  - Board Lab 1.5: `bl-orch2`, 3 parallel writers plus reviewer. The parent rejected the first green run; a 30-minute timeout was resumed; no intercom peers (`BL\MISSION-1.5.md`, `BL\STATUS-1.5.md:1-9`).
  - Twilio fallback: `tf-orch` on zai/glm-5.3, children `tf-dev*` on v4-pro, run from Orca worktree `Hermes-Supervisor/twilio-fallback` (`TF\MISSION.md:3`, `TF\ROLE-worker.md:5`).
    - Ended `BLOCKED-NEEDS-CARTER` awaiting a live-change approval.
    - The morning change was made by tf-orch directly, with no subagents (`TF\STATUS.md:1,17`; `BRAIN\WORKBOARD.md:13`).
- **Claude coordinator + Pi workers in Orca terminals (the contrast, not the target):**
  - 2026-09-01 Maverick Core v1 (`run_feb20c3eb703`, 11 pi workers). Lessons: pi bash has no timeout; `check --ack` does not clear `worker_done`; poll `task-list` instead (`BRAIN\inbox\2026-09-01-maverick-core-v1.md:3,23-25`).
  - 2026-09-01 G4 (`run_50edaeb3a169`, 4 v4-pro workers, `...g4-nl-intake-live.md:3,12`).
  - 2026-09-22 willcall fixes. The independent review caught real bugs; run the full test suite (`...chief-willcall-fix-brief.md:8-18`, `...fixes-done.md:30-38`).
  - 2026-09-23 gpt-live-1 Pi worker on glm-5.3 (`...gpt-live-1-migration-handoff.md:11,17`).
- **Older 3-terminal intercom team** (Karen/Darren/Jefe with quick commands): `PIA\team\README.md:1-80`. Its `Debate` scope is now invalid.

---

## 8. Stale or conflicting docs the plan should call out
1. `D:\Workspace\Shared\Agents\AGENTS.md:90` still says "Pi agents paused (2026-08-28). Do not spawn `pi`... Lift only when Carter unpauses Pi". There is no written unpause in BRAIN or Shared\Agents, yet Pi runs have happened since 09-01 at Carter's direction.
2. `build-handoff\SKILL.md:94` states the wrong Pi default model (section 1e).
3. `BRAIN\workflows\feature-implementation.md:77` says local-Qwen (section 3).
4. `feature-workflow\SKILL.md:30` requires a single writer, which conflicts with parallel team writers (section 3).
5. `PIA\team\README.md:54` has the invalid `Debate` scope.
6. `settings.json` has `intercomBridge.resultDelivery: true` without an external listener (section 2).
7. The reviewer, planner and researcher overrides are not v4-pro, so an explicit `model` is needed on each spawn (section 2).

---

## 9. OPEN ITEMS (not found; do not guess)
1. **The exact `-e` list and full command line used for `bl-orch` and `tf-orch` on 2026-09-20.** It is not recorded in any searched directory. It likely lives in the 2026-09-20 Claude monitor transcript (`C:\Users\carte\.claude\projects\...`) or in Pi session files (`PIA\sessions\`), and both were outside scope.
2. Whether `orca-agent-status.ts` / `orca-prefill.ts` (Orca status integration), `pi-web-access` or `pi-mcp-adapter` were in that list, and what breaks in Orca's status display if they are omitted.
3. How the ROLE and MISSION text was delivered: `--append-system-prompt ROLE-orchestrator.md` or a first chat message. No record exists; ROLE files are written as system-prompt style.
4. Whether `-e` accepts a package directory as well as an entry file. The docs only show files and npm/git specs.
5. Billing for `zai/glm-5.3`. The zai baseUrl is the Coding Plan endpoint, so it probably draws on Z.AI plan quota rather than the catalog's $1.40/$4.40. This is unconfirmed, and so is the current Z.AI quota and plan tier.
6. The actual current DeepSeek price and remaining balance. The override (1.10/4.40) and catalog (1.32/3.96) disagree, and the balance was not checked (no provider calls allowed).
7. No written rule was found for "orchestrator default zai/glm-5.3; gpt-6-astra only on explicit ask". The only supporting evidence is the $20+ Astra cost note. Carter's directive presumably lives in chat or memory outside scope.
8. No earlier per-work-package cost cap exists. `usageBudget` has never been used here, and it cannot stop running children or cap the orchestrator itself.
9. Auto-memory `orca-cheap-model-workers.md`, cited at `fb-boost-tick.md:17`, was not read because it is outside the searched directories.
10. No Pi-team run used `orca orchestration run-create` / Orca mailbox. Whether the plan wants Orca Runs layered on top of the pi-subagents bridge is undecided.
