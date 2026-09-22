# LiveKit / Twilio / OpenAI GPT-Live canary — bounded read-only research

As-of date: **2026-09-22**. Public vendor documentation, public package registry, and public GitHub repos only.
No accounts, APIs, credentials, or repo edits were touched. Nothing below was verified against your own project —
every "you must" statement is a doc-derived requirement, not a live check.

Legend: **[U]** = UNVERIFIED (could not confirm from authoritative docs).

---

## Q1. Inbound trunk fields — authenticated AND source-restricted ingress for Twilio

### Exact field names (`CreateSIPInboundTrunk` → `SIPInboundTrunkInfo`)

| Field | Type | Notes |
|---|---|---|
| `name` | string | required |
| `numbers` | array\<string\> | required; E.164 with leading `+`. Calls to any other number are not accepted by this trunk |
| `allowed_addresses` | array\<string\> | IP or CIDR of *senders* allowed to use the trunk. **Must be enabled for your project by LiveKit support before use** |
| `allowed_numbers` | array\<string\> | caller (From) numbers allowed to dial in. If empty, trunk access must be limited by `auth_username`/`auth_password` **or** `allowed_addresses` |
| `auth_username` | string | inbound SIP INVITE username |
| `auth_password` | string | inbound SIP INVITE password |
| `headers` | map\<string,string\> | extra X-\* headers echoed in the 200 OK |
| `headers_to_attributes` | map\<string,string\> | X-\* header → participant attribute name mapping |
| `attributes_to_headers` | map\<string,string\> | attribute → X-\* header (outbound) |
| `include_headers` | `SIPHeaderOptions` | `SIP_NO_HEADERS`=0, `SIP_X_HEADERS`=1 (map all `X-*` → `sip.h.*`), `SIP_ALL_HEADERS`=2 |
| `ringing_timeout` | Duration | max time the caller waits for track subscription (call pickup) |
| `max_call_duration` | Duration | max call duration (hard cap) |
| `krisp_enabled` | bool | Krisp noise cancellation for the caller (`krispEnabled` in JSON; JSON editor only in dashboard) |
| `media` | `SIPMediaConfig` | `codecs`, `only_listed_codecs`, `encryption`, `media_timeout` |
| `media_encryption` | `SIPMediaEncryption` | **DEPRECATED** — use `media.encryption` |
| `metadata` | string | copied onto every SIP participant from this trunk |

`SIPMediaEncryption`: `SIP_MEDIA_ENCRYPT_DISABLE`=0, `SIP_MEDIA_ENCRYPT_ALLOW`=1, `SIP_MEDIA_ENCRYPT_REQUIRE`=2.
Media config precedence for inbound: **dispatch rule → inbound trunk → defaults**; `encryption` and `media_timeout`
fall through independently; codecs resolve as a pair (`codecs` + `only_listed_codecs` inherited together).

### Which combination gives authenticated AND source-restricted ingress for Twilio

**The short answer: with Twilio Elastic SIP Trunking (the path you want), you cannot get both via trunk credentials —
Twilio's Elastic inbound direction does not send LiveKit credentials. Auth at the trunk is only available on the
TwiML / Programmable Voice inbound path, which in turn does not support SIP REFER or outbound calls.**

LiveKit states this explicitly: *"LiveKit supports username and password authentication for inbound trunks, but your
SIP trunking provider must also support it… Twilio Elastic SIP Trunking doesn't support it, though you can use
username and password authentication with TwiML."*

So there are two mutually exclusive Configurations:

**A. Twilio Elastic SIP Trunking (needed for SIP REFER / cold transfer, Q6)**

```
numbers:           ["+1<canary-DID>"]        # only the canary DID is accepted
allowed_addresses: ["54.172.60.0/30", "54.244.51.0/30", ...]   # Twilio signaling ranges (support must enable the field)
allowed_numbers:   ["+1<your-test-handset>"] # only your handset may originate
media: { encryption: SIP_MEDIA_ENCRYPT_ALLOW }   # Twilio media is plain RTP/SRTP; REQUIRE will break it unless TLS+SRTP is on
krisp_enabled:     true
```

- `numbers` gives DID restriction; `allowed_addresses` gives source-IP restriction; `allowed_numbers` gives
  caller restriction. **No credentials are presented by Twilio Elastic inbound**, so the trunk is
  "source-restricted but unauthenticated" — the IP/CIDR and caller allowlists are the authentication.
- **Prerequisite: `allowed_addresses` must be enabled on your project by LiveKit support.** Until then this field
  is inert and the trunk is only DID + caller-number restricted.
- Twilio Elastic SIP Trunking inbound origination is configured as an `Origination URI` (`sip:<your SIP endpoint>;transport=tcp`),
  optionally with `weight`/`priority` for failover. There is no credential list on the origination side —
  credential lists apply to *termination* (outbound) only.

**B. Twilio Programmable Voice (TwiML Bin → `<Dial><Sip username=… password=…>`)** — gives real
`auth_username`/`auth_password` on the LiveKit inbound trunk:

```xml
<Response><Dial><Sip username="<sip_trunk_username>" password="<sip_trunk_password>">
  sip:<your_phone_number>@<your SIP endpoint>;transport=tcp</Sip></Dial></Response>
```
```
numbers:       ["+1<canary-DID>"]
auth_username: "<sip_trunk_username>"
auth_password: "<sip_trunk_password>"
allowed_numbers: ["+1<your-test-handset>"]
```
Cost of this path: **LiveKit documents that it does not support SIP REFER or outbound calls.** If you want cold
transfer later, you must move to Elastic SIP Trunking (config A).

**Best available combination for a canary that needs both auth-ish gating and source restriction:**
`numbers` (single DID) + `allowed_addresses` (Twilio ranges) + `allowed_numbers` (your handset) +
dispatch-rule-level `inbound_numbers` (second, independent caller filter) + `roomConfig.agents[].agentName`
bound to a canary-only agent. Treat `allowed_addresses` as the network control and the phone-number allowlists
as the identity control; there is no shared secret in the Elastic path.

### Does LiveKit publish guidance on Twilio signaling IP ranges?

**No.** No LiveKit documentation page was found that lists Twilio signaling IP ranges, and LiveKit's own
guidance for `allowed_addresses` is only "IP addresses or CIDR blocks that are allowed to use the trunk" plus the
enablement requirement. Twilio publishes its own authoritative list (below), which is what you would feed into
`allowed_addresses`. **[U]** — absence of a doc is not proof a support-provided list doesn't exist.

Twilio's own ranges (Twilio docs, "IP Addresses for Elastic SIP Trunking Services", page last modified 2026-03-09).
Twilio says you MUST allow **all** of them, because it does not guarantee which edge egresses a call:

| Region | Range | Ports |
|---|---|---|
| North America Virginia | `54.172.60.0/30` | 5060 UDP/TCP, 5061 TLS |
| North America Oregon | `54.244.51.0/30` | 5060 UDP/TCP, 5061 TLS |
| Europe Ireland | `54.171.127.192/30` | same |
| Europe Frankfurt | `35.156.191.128/30` | same |
| Asia-Pacific Tokyo | `54.65.63.192/30` | same |
| Asia-Pacific Singapore | `54.169.127.128/30` | same |
| Asia-Pacific Sydney | `54.252.254.64/30` | same |
| South America São Paulo | `177.71.206.192/30` | same |
| Global media (all edge locations) | dest `168.86.128.0/18` | UDP 10000–60000 |

Note the shape: 4 IPs per region, /30 — so an `allowed_addresses` list needs all eight /30s (32 IPs) for full
US+resiliency coverage. Do **not** send traffic directly to those IPs; they are firewall-allowlist entries only.

Reverse direction (LiveKit → your firewall): LiveKit publishes its own static IP ranges (Canada, EU, India, Japan,
US) covering realtime, SIP signaling and media, and webhooks, plus region-based SIP endpoints
`{sip_subdomain}.{region}.sip.livekit.cloud`.

Sources: <https://docs.livekit.io/telephony/accepting-calls/inbound-trunk/>,
<https://docs.livekit.io/reference/telephony/sip-api/#createsipinboundtrunk>,
<https://docs.livekit.io/reference/telephony/sip-api/#sipmediaconfig>,
<https://www.twilio.com/docs/sip-trunking/ip-addresses>,
<https://docs.livekit.io/telephony/start/providers/twilio/>,
<https://docs.livekit.io/deploy/admin/regions/endpoints/>

---

## Q2. Dispatch rules — binding, agent dispatch, and "never reach the model"

### Rule types and fields

| Rule | Proto name | Fields |
|---|---|---|
| Individual | `SIPDispatchRuleIndividual` (proto value 2) | `room_prefix` — room name becomes `<room_prefix>_<caller_number>`; `pin` |
| Direct | `SIPDispatchRuleDirect` (1) | `room_name`; `pin` |
| Callee | `SIPDispatchRuleCallee` (3) | `room_prefix`, `pin`, `randomize` (default **false** in the type def; callee names room after the *dialed* number) |

`SIPDispatchRuleInfo` fields (the ones that matter here): `sip_dispatch_rule_id`, `rule`, `trunk_ids`,
`hide_phone_number`, `inbound_numbers`, `name`, `metadata`, `headers`, `attributes`, `room_preset`, `room_config`,
`media`.

JSON/CLI naming: dispatch-rule JSON uses camelCase — `trunkIds`, `hidePhoneNumber`, `dispatchRuleIndividual.roomPrefix`,
`roomConfig.agents[].agentName`, `roomConfig.agents[].metadata`, `roomConfig.agents[].deployment`. (A livekit GitHub
issue #3789 confirms snake_case `room_config` / `agent_name` in dispatch-rule JSON fails with "missing rule";
CLI flag binding is `--trunks <trunk-id>`.)

### trunk_ids binding

- `trunk_ids` / `trunkIds` / `--trunks` binds the rule to specific trunk IDs.
- **When `trunk_ids` is empty the rule is a WILDCARD rule matching calls from all inbound trunks.** This is the
  single most dangerous default for a canary: any other trunk in the same project would fall into this rule. Always
  set `trunkIds` to the canary trunk explicitly.

### Room + agent dispatch

```json
{
  "name": "canary dispatch rule",
  "trunkIds": ["ST_<canary-trunk-id>"],
  "inboundNumbers": ["+1<your-test-handset>"],
  "hidePhoneNumber": true,
  "rule": { "dispatchRuleIndividual": { "roomPrefix": "canary-" } },
  "roomConfig": { "agents": [ { "agentName": "grizzly-canary-agent", "metadata": "{\"canary\":true}" } ] }
}
```

- `roomConfig.agents[].agentName` (required) must match the name your worker registers with; `metadata` arrives as
  `ctx.job.metadata`; `deployment` targets a non-production deployment.
- `hide_phone_number`: participant identity becomes random and `sip.phoneNumber` is omitted from attributes. Note the
  default is the opposite — *"By default, a dispatch rule… makes a caller's phone number visible to others in the
  room,"* and individual-rule room names embed the caller's number (PII in logs/traces, not removed by PII redaction).
  Set `hidePhoneNumber: true` and rely on `sip.twilio.callSid` for your durable mapping (Q3) — but be aware that
  hiding the number removes `sip.phoneNumber`, so any handset allowlist must live on the trunk/dispatch rule, not in
  the agent.
- `inbound_numbers` on the dispatch rule: *"If this list is populated, the dispatch rule only accepts calls made from
  numbers in the list. If a caller's phone number is not in the list, the call is rejected."* This is a second,
  independent caller filter after trunk `allowed_numbers`.

### Ensuring an unmatched trunk/number gets no agent

There is no "default deny" flag; you compose a deny chain. Each layer below is documented:

1. **Wrong trunk** → trunk `numbers` has only the canary DID, `allowed_addresses` limited to Twilio ranges,
   `allowed_numbers` limited to your handset. Fails before LiveKit accepts the INVITE.
2. **Wrong caller** → dispatch-rule `inbound_numbers` (call is *rejected*, not routed).
3. **Trunk matched but no rule** → LiveKit finds no matching dispatch rule, so no room and no SIP participant is
   created. Twilio sees a SIP failure (community report of `408 request timed out` for exactly this case) and the
   model is never involved. **[U]** LiveKit's own troubleshooting table documents `404` for unknown *trunk ID*
   (outbound/Twirp context) and `486 Busy Here` for "destination declined"; it does not publish a row for
   "trunk matched, dispatch rule missing."
4. **Rule matched, agent worker not registered under that `agentName`** → nobody joins the room; call rings and then
   fails. Docs: *"A silent agent … connects but the call is scored as no answer"*; troubleshooting says to verify
   "your dispatch rule matches as expected and points to the correct `agent_name`."
5. **Belt-and-braces in the agent** → before creating the `AgentSession`, read the SIP participant attributes and
   `ctx.shutdown()` if `sip.trunkID`, `sip.ruleID`, or (`sip.twilio.accountSid`) don't match your canary constants.
   This is the only layer that is fully under your control at runtime and the only one that guarantees no model
   session opens even if config drifts.

Also relevant: worker registration name is set on the server (`server.rtc_session(agent_name="…")`; env
`LIVEKIT_AGENT_NAME`, with `LIVEKIT_AGENT_NAME_OVERRIDE` taking precedence), and dispatch rules/trunks are
long-lived objects you must **reuse**, not recreate per call.

### Per-trunk or per-project concurrent-call limits

**No per-trunk and no per-number concurrency limit is documented. "One concurrent call" must be enforced by your
agent or controller. [U]** (absence of documentation).

What *is* documented project-wide:

| Limit | Value |
|---|---|
| Agent session concurrency | Build plan: **5** concurrent agent sessions per project; higher on paid plans (pricing page quotes up to 600 concurrent agent sessions on top tiers) |
| Participant concurrency | Build: 100 connected participants (agents + end users) across all rooms |
| Ingress / Egress requests | Build: 2 each |
| Server API rate limit | 1,000 requests/min per project |
| Third-party SIP minutes | metered (Build included allowance: 1,000 min). Billing-side, not a concurrency cap |
| GPT-Live concurrent sessions (OpenAI side) | measured in **concurrent sessions**: Tier 1 = 25, Tier 2 = 50, Tier 3 = 200, Tier 4 = 300, Tier 5 = 500; Free tier unsupported |

Implication: none of these caps you at 1. Enforce single-call in the controller — e.g. a mutex/lease keyed on the
canary, plus a room-count check before `createSipDispatchRule` exists, plus rejecting/`ctx.shutdown()` inside the
agent entrypoint when a canary room already has an active SIP participant. `max_call_duration` on the trunk is the
only server-enforced time bound (Q6).

Sources: <https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/>,
<https://docs.livekit.io/reference/telephony/sip-api/#createsipdispatchrule>,
<https://docs.livekit.io/reference/telephony/sip-api/#sipdispatchruleinfo>,
<https://docs.livekit.io/deploy/admin/quotas-and-limits/>, <https://livekit.com/pricing>,
<https://livekit.com/blog/verify-sip-caller-identity>, <https://github.com/livekit/livekit/issues/3789>,
<https://docs.livekit.io/reference/telephony/troubleshooting/>

---

## Q3. Getting the Twilio CallSid into LiveKit

### Default SIP attributes (all automatically populated)

| Attribute key | Meaning |
|---|---|
| `sip.callID` | LiveKit's SIP call ID (call tag used to match requests/responses) |
| `sip.callIDFull` | **Trunk provider** SIP call ID (globally unique per SIP call) |
| `sip.callStatus` | `active` \| `automation` \| `dialing` \| `hangup` \| `ringing` |
| `sip.phoneNumber` | caller's number (inbound). **Absent when `hide_phone_number` is set** |
| `sip.ruleID` | **the SIP DispatchRule ID used for the inbound call** (empty for outbound) |
| `sip.trunkID` | inbound or outbound trunk ID |
| `sip.trunkPhoneNumber` | number dialed in by the end user (inbound) |

### Twilio-specific attributes (populated automatically when using Twilio SIP trunks)

| Attribute key | Meaning |
|---|---|
| `sip.twilio.accountSid` | Twilio account SID |
| `sip.twilio.callSid` | **Twilio call SID — this is your CallSid** |

Documented example: `participant.attributes['sip.twilio.callSid']`.

### Exact mapping you asked for

Your durable row can be built entirely from documented attributes plus the room name, with no header parsing:

| Your requirement | Where it comes from |
|---|---|
| Twilio CallSid | `participant.attributes["sip.twilio.callSid"]` |
| LiveKit SIP participant ID | the participant object's `identity` (or `sid`); note identity defaults to the **phone number** unless `hide_phone_number`/explicit identity is used |
| room | the room the participant joined (individual rule: `<roomPrefix>_<caller_number>` + random suffix) |
| dispatch rule ID | `participant.attributes["sip.ruleID"]` |
| trunk ID | `participant.attributes["sip.trunkID"]` |
| provider call ID | `participant.attributes["sip.callIDFull"]` |

Participant kind gate: `participant.kind == ParticipantKind.SIP` (Python `ParticipantKind.PARTICIPANT_KIND_SIP`).

### Custom headers

- `headers_to_attributes: { "X-Customer-Id": "customer.id" }` maps a specific X-\* header onto a named attribute.
- `include_headers: SIP_X_HEADERS` (1) maps **all** `X-*` headers onto `sip.h.*` attributes.
- **Timing caveat, documented:** *"Attributes set using `headers_to_attributes` are updated asynchronously… might not
  be immediately available when the participant joins the room."* If you need them synchronously, use the
  `lk.sip.GetRemoteHeaders` RPC, and/or listen for the `participant_attributes_changed` /
  `RoomEvent.ParticipantAttributesChanged` event.
- Twilio numbers must be written with a leading `+`.

### Is there an `X-Twilio-CallSid` header on the path to LiveKit?

- **NOT documented by Twilio in its Elastic SIP Trunking docs.** Twilio's SIP trunking page documents a `Diversion`
  header and X-header pass-through on *origination URIs* (`?X-myheader=foo`), and `X-*` headers generally, but it does
  not document `X-Twilio-CallSid`. **[U]**
- Third-party captures (Asterisk/FreePBX/3CX community traces, older StackOverflow answers) repeatedly show
  `X-Twilio-CallSid: CA…` arriving on Twilio-originated INVITEs. **[U]** — third-party evidence, not vendor docs.
- **Practical read:** if Twilio does send it, LiveKit would only surface it if you set
  `include_headers: SIP_X_HEADERS`, in which case it appears as `sip.h.X-Twilio-CallSid` (or map it explicitly with
  `headers_to_attributes: {"X-Twilio-CallSid": "twilio.callSid"}`). **Do not build the durable mapping on this.**
  The supported, documented path is the automatically-populated `sip.twilio.callSid` attribute — it requires no
  header configuration and is not subject to the async-attribute caveat in the same way.

Also useful for your deadlines work: `sip.callStatus` transitions `ringing` → `active` when the SIP participant
subscribes to remote audio, and `hangup` at teardown with a `disconnect_reason` (Q6).

Sources: <https://docs.livekit.io/reference/telephony/sip-participant/>,
<https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/>,
<https://docs.livekit.io/telephony/accepting-calls/workflow-setup/>,
<https://livekit.com/blog/verify-sip-caller-identity>,
<https://www.twilio.com/docs/sip-trunking>

---

## Q4. GPT-Live plugin — Node availability, packages, versions, model id, delegation

### Availability: **Python AND Node.js** (not Python-only)

The LiveKit docs page *"OpenAI GPT-Live plugin guide"* carries both `Node.js` and `Python` availability checkmarks.
(This is separate from the older *"OpenAI Realtime API plugin"* page; Realtime and GPT-Live are different plugins.)

### Exact package names and current versions

| Ecosystem | Package | Latest | Notes |
|---|---|---|---|
| Node | `@livekit/agents` | **1.9.0** (published 2026-09-15) | peers: `@livekit/rtc-node ^0.13.34`, `zod ^3.25.76 \|\| ^4.1.8` |
| Node | `@livekit/agents-plugin-openai` | **1.9.0** (published 2026-09-15) | peers: `@livekit/agents 1.9.0`, `@livekit/rtc-node ^0.13.34`, `zod ^3.25.76 \|\| ^4.1.8`; deps `openai`, `ws`, `@livekit/mutex` |
| Node | `livekit-server-sdk` | **2.19.1** (published 2026-09-20) | engines `node >= 19`; used for SIP trunk/dispatch/transfer APIs |
| Python | `livekit-agents[openai]` | `~=1.8` per docs | provides `livekit.plugins.openai.realtime.GPTLiveModel` |

Docs install lines: `pnpm add "@livekit/agents-plugin-openai@1.x"` (Node) and
`uv add "livekit-agents[openai]~=1.8"` (Python).

I confirmed `plugins/openai/src/realtime/gpt_live_model.ts` exists in the published Node tag
`@livekit/agents-plugin-openai@1.9.0` (not just on `main`), along with `gpt_live_types.ts` re-exported as the
`GPTLive` namespace.

### Minimum Node version

**Node.js >= 20.** Documented in the Voice AI quickstart: *"LiveKit Agents for Node.js requires Node.js >= 20."*
(The transitive `@livekit/rtc-node` declares `engines: node >= 18`, and `livekit-server-sdk` `>= 19`; the binding
constraint is the 20 from the Agents docs.)

### Model id string for GPT-Live 1

- Voice model: **`gpt-live-1`** — it is the plugin default (`DEFAULT_MODEL = 'gpt-live-1'` in
  `gpt_live_model.ts`; docs: *"`model` … Default: `gpt-live-1`: GPT-Live voice model slug."*).
- Backend Responses model default: **`gpt-5.6-luna`** (`DEFAULT_BACKEND_MODEL`).
- Node config: `new openai.realtime.GPTLiveModel({ voice: 'marin', responsesOptions: { model: 'gpt-5.6-luna', instructions: '…' } })`
- Python config: `openai.realtime.GPTLiveModel(voice="marin", responses_options={"model": "gpt-5.6-luna", …})`

### `GPTLiveModel` options (Node, `GPTLiveModelOptions`)

| Option | Type / default | Notes |
|---|---|---|
| `model` | string, default `'gpt-live-1'` | voice model slug |
| `voice` | name or custom-voice object, default `'marin'` | suggested names: `aster`, `beacon`, `cinder`, `marin`, `stone`, `vesper`; **fixed at startup** |
| `delegation` | `'responses' \| 'client'`, default `'responses'` | **fixed at startup**; client mode requires an agent with **no tools** |
| `responsesOptions` | object | backend Responses settings (below) |
| `apiKey` | string | falls back to `OPENAI_API_KEY`; constructor throws if absent |
| `baseURL` | string | falls back to `OPENAI_BASE_URL`, then `https://api.openai.com/v1` |
| `maxSessionDuration` | number \| null, default **null** (timer disabled) | milliseconds; **recycles the connection** — the model continues from where it stopped |
| `connOptions` | `APIConnectOptions` | connection/startup timeout + retries, default `DEFAULT_API_CONNECT_OPTIONS` |

Transport detail from the source: the plugin converts `baseURL` to `wss://…/live/sessions`, sends
`User-Agent: LiveKit Agents` and `Authorization: Bearer <apiKey>`.
`responsesOptions`: `model`, `instructions`, `toolChoice`, `parallelToolCalls`, `reasoning`, `text`, `serviceTier`
(`auto|default|flex|priority`), `maxOutputTokens` (service requires ≥ 16).

### "Client-controlled delegation" / backend delegation

There are exactly two delegation targets, chosen at session creation and **immutable for the life of the session**
(to change, start a new session):

**`delegation: 'responses'` (default)** — a backend Responses model does the reasoning and picks the tools.
Your `@function_tool` / `llm.tool(...)` methods still execute in your agent process and the plugin returns each
result to that backend model. Provider tools (`WebSearch`, `FileSearch`, `CodeInterpreter`) run on OpenAI's servers.
Tools and tool choice **can** be updated mid-session (`sendDelegationUpdate`); `midSessionToolsUpdate` is only
enabled in this mode.

**`delegation: 'client'` (client-controlled delegation)** — no second OpenAI model runs; *your* code (your LLM, your
retrieval stack, a DB lookup) produces the answer. Concretely:

- **No tool channel exists.** The plugin ignores registered tools and logs a warning. Source message:
  *"gpt-live client delegation has no tool channel, so the model can never call <tool>"* and the guidance is to
  *"leave the agent's tools empty and answer delegation_created with appendCommentary, or pass delegation='responses'
  to run tools on the backend model."* `midSessionToolsUpdate` is disabled in this mode.
- Delegated work arrives as a `GPTLiveDelegation` on the duplex session event `delegationCreated`
  (Python: `delegation_created`). The object carries **no task and no arguments** — just:
  - `id` — "Answer with `GPTLiveSession.appendCommentary`. **Valid only on the connection that created it.**"
  - `pendingTranscript` — "The caller's current turn, which may not yet be in the agent's chat context."
- You answer with one of three append channels, each capped at **500 tokens per append** by the service:
  - `appendCommentary(text, { delegationId })` — the model paraphrases it aloud now.
  - `appendThinking(text, { delegationId })` — silent context the model may use later.
  - `appendInstructions(text, { delegationId })` — developer guidance for the rest of the session.
  Repeating `appendCommentary` with the same `delegationId` **continues** the same delegation rather than starting a
  new one, so progress reporting works. An append with an unknown/inactive delegation id is ignored (debug log).
- Wire-level events: `session.delegation.created` (server→client, fields `delegation.id`, `delegation.target`), and
  the session-start config `{ "model": "gpt-live-1", "delegation": { "type": "client" } }`; sends are
  `session.commentary.append` / `session.thinking.append` / `session.instructions.append` with required
  `delegation_id` (`null` allowed for general context).

Other GPT-Live plugin behaviours worth knowing for a canary (all documented):

- **Server-driven, model-controlled barge-in.** No client event creates/cancels/truncates a response; the model
  decides when to stop. The framework can cut *local playback* but cannot stop the model. Barge-in needs an explicit
  VAD because the session drops its default VAD for this model.
- **Append-only context.** Startup history max **128 messages / 8192 rendered tokens** (oldest dropped first);
  after start you can only append.
- **No half-cascade.** No text-only modality, so you cannot pair it with a TTS plugin for exact wording;
  `session.say()` errors unless a TTS is attached (and even then it may overlap).
- **Audio only.** No video/image input, including to the backend.
- **Two separate instruction sets**: the voice persona is the `Agent.instructions`; `GPTLiveModel` has **no**
  `instructions` parameter; the backend takes `responsesOptions.instructions`. Neither can be changed mid-session
  (setting new ones raises `RealtimeError`).
- **`generateReply()` is commentary, not an utterance** — the model may refuse; if it hasn't started speaking within
  **10 seconds** the reply counts as refused and the handle completes with a `RealtimeError`.
- **Handoff** cannot reuse a GPT-Live connection if instructions/chat context change; tools-only handoffs keep it.
- **Usage/metrics split**: voice model reports cumulative session seconds (emit as `RealtimeModelMetrics.session_duration`, ~once a minute plus a final delta on close); backend tokens emit as `LLMMetrics` under the backend model name. Read totals from `session.usage`.

Sources: <https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/>,
<https://docs.livekit.io/agents/models/realtime/plugins/openai/>,
<https://github.com/livekit/agents-js/blob/main/plugins/openai/src/realtime/gpt_live_model.ts>,
<https://github.com/livekit/agents-js/blob/main/plugins/openai/src/realtime/gpt_live_types.ts>,
<https://registry.npmjs.org/@livekit/agents>, <https://registry.npmjs.org/@livekit/agents-plugin-openai>,
<https://docs.livekit.io/agents/start/voice-ai/>,
<https://developers.openai.com/api/docs/guides/live-delegation>,
<https://developers.openai.com/api/docs/guides/live-partner-integrations>

---

## Q5. OpenAI-side configuration for GPT-Live 1

### Endpoint and model support

- **Supported endpoint: `v1/live/sessions` only.** The model page explicitly marks `Not supported` for
  `/v1/realtime`, `/v1/responses`, `/v1/chat/completions`, `/v1/audio/speech`, `/v1/audio/transcriptions`,
  `/v1/embeddings`, `/v1/batch`, `/v1/fine-tuning`, assistants, images, videos, moderation.
  → A "just point the Realtime plugin at gpt-live-1" approach will not work; the dedicated GPT-Live plugin (Q4) is
  required. OpenAI's partner-integration checklist says the same thing in prose: *"A Realtime integration is not
  automatically compatible with GPT-Live."*
- Model details: snapshot `gpt-live-1`; input modalities audio+text; output audio+text; image/video unsupported;
  knowledge cutoff 2025-07-31; supported features `streaming`, `function_calling`; **not supported**:
  `structured_outputs`, `fine_tuning`, `predicted_outputs`.

### Project and key type

- Docs describe the topology as *"a trusted server with an OpenAI project API key. **Keep the key on the server.**"*
  The plugin reads `OPENAI_API_KEY` (or an explicit `apiKey`). This matters architecturally: the LiveKit agent worker
  is your trusted server, so the long-lived project key lives there — not in a browser or on the caller's side.
- Key hygiene OpenAI recommends and supports: set an **expiration date** on project API keys and rotate; admins can
  enforce a maximum key lifetime at org or project level; **API Key Governance** can restrict key *types* (e.g. allow
  only service-account keys) at org/project level. Org-level restrictions always win.
- If you belong to multiple orgs, the org is selected per request via a header; otherwise the default org is billed.
- The docs also call for a **safety identifier** (`OpenAI-Safety-Identifier` header) when you identify end users —
  *recommended but not required*, for a stable, privacy-preserving value such as a hashed internal ID. Send it on the
  server-side request that creates/connects each session.

### Organization verification

**No organization-verification requirement is documented for GPT-Live 1.** The production guide's org setup section
covers org ID, members/roles, billing, usage limits, and key governance — no verification gate for this model. **[U]**
if you were expecting a verification step.
**However, there is a discrepancy worth resolving before you build:** the *LiveKit* GPT-Live page says the plugin
requires *"an OpenAI API key on an account with GPT-Live alpha access,"* while the *OpenAI* model page publishes
normal tiered rate limits and no alpha note. **[U]** — treat "alpha access" as a possible account-level gate to
confirm with your OpenAI account, since it would block the canary outright.

### Rate limits

Rate limits for `gpt-live-1` are **measured in concurrent sessions**, and the **Free usage tier is unsupported**:

| Tier | Concurrent sessions |
|---|---|
| Free | unsupported |
| Tier 1 | 25 |
| Tier 2 | 50 |
| Tier 3 | 200 |
| Tier 4 | 300 |
| Tier 5 | 500 |

One canary call is far below any tier, so the practical risk is not the cap — it's the Free-tier exclusion and any
alpha/access gate.

### Data retention and ZDR

- Default: **abuse-monitoring logs are retained up to 30 days** for all API feature usage, unless longer is required.
- **GPT-Live sessions are eligible for Zero Data Retention.** *"With Zero Data Retention enabled, `store` is treated as
  `false`, even if a request sets it to `true`."*
- ZDR (or Modified Abuse Monitoring) requires **prior OpenAI approval** and acceptance of additional requirements;
  it is configured per **organization or per project** in **Settings → Organization → Data controls → Data Retention**
  (`default` = inherit org; or explicitly ZDR / MAM / None per project).
- Stored session recordings are available for **30 days**; **forking requires a completed stored recording and is
  unavailable under ZDR** (so don't plan on fork-based replay if you go ZDR).
- Data residency: `/v1/live/sessions` is listed for both **United States** (`us.api.openai.com`) and
  **Europe (EEA + Switzerland)** (`eu.api.openai.com`). Canada, Japan, India, Singapore, UK, Australia, etc. do not
  list `/v1/live/sessions`.
- The endpoint table also flags whether a region supports audio/voice: `/v1/live/sessions` is listed under the
  voice-capable endpoints for US and EU.

### Pricing units (no exact numbers needed — but they are published)

- **Voice session: $0.05 per minute, billed per second**, not rounded up to the next whole minute
  (`gpt-live-1` model page, "Live session duration").
- **Backend model and tool usage is billed separately** at normal token pricing for the configured Responses model
  and any provider tools. The plugin reports the two separately (Q4).

Sources: <https://developers.openai.com/api/docs/models/gpt-live-1>,
<https://developers.openai.com/api/docs/guides/live>,
<https://developers.openai.com/api/docs/guides/live-conversations>,
<https://developers.openai.com/api/docs/guides/live-partner-integrations>,
<https://developers.openai.com/api/docs/guides/your-data>,
<https://developers.openai.com/api/docs/guides/production-best-practices>

---

## Q6. Agent-side timeouts, disconnect handling, and SIP REFER

### Silence / user-away timeout

| Platform | Option name | Default |
|---|---|---|
| Node | `voiceOptions.userAwayTimeout` | `15.0` seconds |
| Python | `user_away_timeout` | `15.0` seconds |

Semantics: *"Time in seconds of silence before the framework sets the user state to `away`."* Set `None`/null to
disable. Pair it with the `user_state_changed` event (`AgentSessionEventTypes.UserStateChanged`) and check
`newState === 'away'`. The documented pattern is: on `away`, start a check-in task that calls `generateReply(...)`
a few times with delays, then `ctx.shutdown()` (Node) / `session.shutdown()` (Python); cancel that task when the user
speaks again. Note the away timer fires on *silence from both sides* — "when neither the user nor the agent has
spoken for the configured duration."

**First-audio deadline:** the trunk's `ringing_timeout` is the server-side bound on *"Maximum time for the caller to
wait for track subscription (that is, for the call to be picked up)"* — this is the closest documented knob to a
first-audio deadline and it is enforced by LiveKit SIP, not by your agent. Beyond that, first-audio is an
application-level measurement (`sip.callStatus` `ringing` → `active`, plus your own meter on the first output audio).

### Max session duration

There is **no documented `AgentSession` "max duration" option**. **[U]** The documented levers, in decreasing order
of enforcement strength:

1. **`max_call_duration` on the inbound trunk** (`SIPInboundTrunkInfo.max_call_duration`, `google.protobuf.Duration`)
   — a hard, server-enforced cap. Also available on `CreateSIPParticipant` and on dispatch-rule media config
   (`SIPDispatchRuleInfo.media`), with inbound precedence dispatch rule → trunk → defaults.
2. **`maxSessionDuration` on `GPTLiveModel`** (ms; default `null` = timer disabled) — recycles the OpenAI connection,
   *"the new connection receives the full conversation again, and the model continues from the point where the
   connection stopped."* This is a **connection-recycling** control, **not** a call-end control.
3. **Application timer → `ctx.shutdown()` / `session.shutdown()`**, or a tool-triggered hangup. Programmatic hangup
   without the agent: the `delete_room` API. With the agent: the prebuilt `EndCallTool` ("shuts down the session and
   can delete the room to disconnect everyone").
4. **Room lifecycle:** by default a room stays open after the last participant leaves for `departure_timeout`
   (a room property); set `delete_room_on_close: true` (default **`false`**) to delete the room immediately at
   session end.
5. OpenAI-side: `session.closed` with `reason: "expired"` means *"The session reached its duration limit"* —
   OpenAI does not publish the numeric limit. **[U]**

Add a controller-side wall-clock deadline for the canary and you get a bound that doesn't depend on any vendor.

### Handling SIP participant disconnect

`disconnect_reason` on the participant, and whether `AgentSession`/`RoomIO` auto-closes:

| Reason | Timing | Direction | Auto-closes session? |
|---|---|---|---|
| `USER_REJECTED` | pre-connection | outbound only | Yes |
| `USER_UNAVAILABLE` | pre-connection | outbound only | No — your code must call `ctx.shutdown()` |
| `SIP_TRUNK_FAILURE` | pre-connection | outbound only | No — your code must call `ctx.shutdown()` |
| `CLIENT_INITIATED` | post-connection | inbound + outbound | Yes (inbound SIP `BYE` maps here) |
| `ROOM_DELETED` | post-connection | inbound + outbound | Yes (e.g. `EndCallTool` or `delete_room`) |

For an inbound canary, the realistic path is `CLIENT_INITIATED` (caller hangs up) and `ROOM_DELETED` (your own
teardown) — both auto-close. Still register a shutdown callback, because the pre-connection reasons do **not**
auto-close and will leave a session dangling. `sip.callStatus` going to `hangup` is the attribute-level signal.
`ROOM_DELETED` is also how a controller-enforced teardown (single-call lease violation) cleanly ends things.

### SIP REFER / cold transfer

- API: **`TransferSIPParticipant`** (`api.sip.transferSipParticipant(roomName, participantIdentity, transferTo, opts)`
  in Node; requires the SIP **`call`** grant).
  - `participant_identity` (required), `room_name` (required), `transfer_to` (required) — accepts
    `tel:+15105550100`, `sip:+15105550100@sip.telnyx.com`, `sip:+15105550100@my-livekit-demo.pstn.twilio.com`.
  - `play_dialtone`, `ringing_timeout` (*"defaults to 30 seconds"*; on timeout the request errors and **the caller
    stays in the room**, which is the behavior you want for a bounded canary).
  - `transfer_to` becomes the `Refer-To` URI of the outgoing REFER. Transfers to external SIP domains and private IP
    addresses are blocked (documented for the Plivo path; stated as a general restriction).
- Flow: call `TransferSIPParticipant` → LiveKit sends SIP REFER through your trunk → caller leaves the LiveKit room,
  **ending the session** (cold transfer closes the caller's LiveKit session).
- **Precondition: your provider trunk must allow call transfers.** LiveKit says this explicitly and points at Twilio.
- **Does Twilio accept SIP REFER from LiveKit? Yes, if you enable it on the trunk.** Twilio Elastic SIP Trunking
  supports "blind" transfers by consuming an incoming SIP REFER and sending an INVITE to the `Refer-To` address.
  Documented console path: **Elastic SIP Trunking → Manage → Trunks → select trunk → Features → Call Transfer
  (SIP REFER) → Enabled**, plus **Enable PSTN Transfer** if you want PSTN targets, and set **Caller ID for Transfer
  Target** (`Transferee` default, or `Transferor`). CLI equivalent:
  ```
  twilio api trunking v1 trunks update --sid <twilio-trunk-sid> \
    --transfer-mode enable-all --transfer-caller-id from-transferee
  ```
  Caller ID is a **trunk-level** setting, not settable per transfer via the API. Twilio returns `202 Accepted` on
  receipt, sends NOTIFYs (`100 Trying`, `200 OK`), and does not support early media with call transfers.
  Emergency transfers (911/933) are not supported. Initiating a transfer is free; you still pay per-minute trunking
  to the referred destination.
- **Important interaction with Q1:** LiveKit's Twilio *Programmable Voice (TwiML)* inbound path **does not support
  SIP REFER or outbound calls**. So if you want cold transfer on the canary, you must use Elastic SIP Trunking, which
  means giving up inbound trunk username/password auth (Q1).
- Warm/agent-assisted transfer is a separate documented flow if you later want the agent to brief a human.

Sources: <https://docs.livekit.io/agents/logic/sessions/>,
<https://docs.livekit.io/reference/telephony/sip-participant/>,
<https://docs.livekit.io/telephony/accepting-calls/workflow-setup/>,
<https://docs.livekit.io/telephony/features/transfers/cold/>,
<https://docs.livekit.io/reference/telephony/sip-api/#transfersipparticipant>,
<https://www.twilio.com/docs/sip-trunking/call-transfer>, <https://www.twilio.com/docs/sip-trunking>

---

## Q7. LiveKit Cloud isolation, API key scoping, agent deployment, egress

### Separate project per canary?

Yes — separate LiveKit Cloud projects are the documented isolation primitive, and OpenAI's own production guidance
mirrors the pattern ("create separate projects for your staging and production environments … allowing you to
isolate your development and testing work"). Things worth knowing before you split:

- **Free Build-plan caveat:** *"Free projects also share allowances and limits across all of a user's free projects;
  creating additional projects doesn't increase the total."* So a second free project is **not** additional isolation
  of *capacity* — the 5 concurrent agent sessions / 100 participants / SIP-minute allowances are shared. Paid plans
  give per-project limits; Enterprise manages quotas at the **workspace** level (workspaces group projects under
  shared billing and quotas, with default or custom per-member access).
- Real isolation wins from a separate project: separate trunks, dispatch rules, agent deployments, API keys, webhooks,
  and observability data. That is what you want for a canary that must not be reachable by production trunks.
- **Do not** share a project between the canary and Grizzly production and rely on trunk/dispatch config alone:
  an empty `trunk_ids` dispatch rule is a wildcard across all trunks in that project (Q2).

### API key scoping

LiveKit access tokens carry explicit grants; scope the canary controller's key narrowly:

- **SIP grant** (`sip` field of the JWT): `admin` = *"Permission to manage SIP trunks and dispatch rules"*;
  `call` = *"Permission to make SIP calls via `CreateSIPParticipant`"*. `TransferSIPParticipant` also **requires the
  SIP `call` grant**.
- SIP API calls other than those noted **require the SIP `admin` permission** — so a controller that only dials and
  transfers does not need `admin`; a provisioning script that creates the trunk/dispatch rule does.
- **Video grant** room scoping for anything that joins or moderates rooms: `roomJoin`, `roomAdmin`, `canPublish`,
  `canPublishData`, `canPublishSources` (e.g. microphone only), `roomRecord`, `ingressAdmin`, `roomCreate`,
  `roomList`. `canPublishSources` requires `canPublish`.
- Node usage: `new AccessToken(apiKey, secret, { identity })` with `SIPGrant { admin, call }` / `VideoGrant`.
- Practical scoping: a `sip.call`-only key for the runtime controller, a separate `sip.admin` key for the one-time
  provisioning/teardown, and no `roomRecord`/Egress grants on either — that alone denies recording, which is a
  meaningful blast-radius reduction for a voice canary.

### Agent deployment options

| | LiveKit Cloud agents | Self-hosted |
|---|---|---|
| Mechanism | `lk agent deploy` (builds, secrets, logs, monitoring handled for you) | your own `AgentServer` |
| Networking | LiveKit-managed | *"Agent servers use a WebSocket connection to register with LiveKit server and accept incoming jobs. This means that agent servers do not need to expose any inbound hosts or ports to the public internet."* Optional private health check endpoint (default `http://0.0.0.0:8081/`) |
| Constraints | Build-plan cold starts: agents *"might have their deployed agents shut down after all active sessions end,"* causing **10–20 s delay** before the agent joins the room; 5 concurrent agent sessions on Build; build context size limit 1 GB; secrets managed via `lk agent deploy` secrets | you own scaling, patching, and network policy |
| Regions | Region-based agent deployment, EU data residency option | wherever you run it |

For a *canary*, the LiveKit Cloud cold-start behavior is directly relevant to your first-audio deadline: a Build-plan
agent can add 10–20 s before it joins the room. Budget for it or keep the deployment warm.

### Egress: denying outbound traffic to specific hosts

Two different things are called "egress" here — worth separating explicitly:

1. **LiveKit's Egress service** = recording/streaming out of rooms (composite, track, HLS, RTMP, file). Documented
   limits: 2 egress requests on Build, time limits 3 h for file output and 12 h for HLS/RTMP/track; an over-limit
   egress ends with status `LIMIT_REACHED`. **This is not network egress and gives you no host-level deny control.**
2. **Network egress** = what the agent process may connect out to. Findings:

- LiveKit Cloud's documented firewall page is **inbound allowlisting for clients behind a corporate firewall**, not
  an agent-side egress denylist. It lists required outbound destinations for connecting *to* LiveKit
  (`*.livekit.cloud` TCP 443, `*.turn.livekit.cloud` TCP 443, `*.host.livekit.cloud` UDP 3478, UDP 50000–60000,
  TCP 7881) plus a "Minimum requirements" hostname list, and notes the list changes.
- **No LiveKit Cloud setting is documented that lets you deny an agent worker outbound access to specific hosts.**
  **[U]** (absence of documentation).
- Therefore: **the only enforceable per-host egress control is on your side of the boundary** — self-host the worker
  where you control the network namespace/egress rules, or run the LiveKit Cloud agent and enforce outbound policy in
  your own code/tool layer (the agent's outbound calls to the OpenAI API, your RAG service, SMS, HCP, etc. are all
  your code). If you must have a hard per-host deny, self-hosting is the lever; if you can accept application-level
  control, Cloud deployment plus a tool allowlist is sufficient.
- Related controls that *are* documented and useful for keeping a canary hermetic: region pinning (realtime, SIP,
  and agent deployments confined to one region), region-based SIP endpoints
  (`{sip_subdomain}.{region}.sip.livekit.cloud`), static IP ranges for SIP signaling/media/webhooks, EU data
  residency, secrets management for the agent deployment, and PII redaction in observability (note: PII redaction
  does **not** scrub individual-dispatch-rule room names, which embed the caller's number).

Sources: <https://docs.livekit.io/deploy/admin/>, <https://docs.livekit.io/deploy/admin/firewall/>,
<https://docs.livekit.io/deploy/admin/regions/endpoints/>,
<https://docs.livekit.io/deploy/admin/quotas-and-limits/>,
<https://docs.livekit.io/frontends/authentication/tokens/>,
<https://docs.livekit.io/deploy/agents/>, <https://docs.livekit.io/deploy/custom/deployments/>,
<https://docs.livekit.io/transport/media/ingress-egress/egress/>,
<https://docs.livekit.io/telephony/features/region-pinning/>

---

## Consolidated UNVERIFIED list

1. **LiveKit does not publish Twilio signaling IP ranges.** No such page found; use Twilio's own list. Whether LiveKit
   support hands out a curated list for `allowed_addresses` is unknown.
2. **`X-Twilio-CallSid` is not documented by Twilio** for Elastic SIP Trunking. Third-party packet captures show it.
   If present it surfaces as `sip.h.X-Twilio-CallSid` with `include_headers: SIP_X_HEADERS`. Do not depend on it;
   use the documented `sip.twilio.callSid` participant attribute.
3. **No per-trunk or per-number concurrent-call limit is documented** on LiveKit. "One concurrent call" must be
   enforced by the agent/controller. The one thing that might be expected to exist (a maximum-calls-per-trunk or
   per-dispatch-rule setting) does not appear anywhere in the SIP API reference.
4. **No documented `AgentSession` max-session-duration option.** Use trunk `max_call_duration`, an app timer, and/or
   `GPTLiveModel.maxSessionDuration` (which recycles the connection rather than ending the call).
5. **No documented behavior row for "trunk matched but no dispatch rule matched."** Community reports `408 request
   timed out`; LiveKit's troubleshooting table covers `403`, `404` (unknown trunk ID), `486`, `503` instead.
6. **GPT-Live access gate discrepancy:** LiveKit's page says the API key must be on an account with "GPT-Live alpha
   access"; OpenAI's model page publishes normal tiered limits with no alpha note. Confirm with OpenAI before
   committing to the canary.
7. **OpenAI organization verification requirement for GPT-Live 1: none documented.** No verification gate found for
   this model specifically.
8. **OpenAI's numeric session duration limit** (the value behind `session.closed` `reason: "expired"`) is not published.
9. **No LiveKit Cloud mechanism to deny an agent worker outbound access to specific hosts.** Egress host control, if
   required, means self-hosting the worker behind your own network policy.

## Things that most affect the design (not asked, but load-bearing)

- **Q1 vs Q6 are in direct tension.** Elastic SIP Trunking (needed for SIP REFER / cold transfer) has no inbound
  credentials, so "authenticated ingress" degenerates to IP allowlist + caller allowlist. TwiML Programmable Voice
  gives real credentials but kills SIP REFER *and* outbound calls. Pick per requirement; you cannot have both.
- **`allowed_addresses` is gated on a LiveKit support request.** Until it's enabled on the project, the only
  source restriction is the DID + caller-number lists, which are not network controls.
- **`trunk_ids` empty = wildcard across all trunks in the project.** This is the highest-severity config footgun for
  a canary sharing a project.
- **The durable CallSid → participant mapping is free.** `sip.twilio.callSid`, `sip.callID`/`sip.callIDFull`,
  `sip.trunkID`, `sip.ruleID`, and the room name are all automatically populated — no header parsing, no
  `headers_to_attributes` ordering hazard.
- **`max_call_duration` on the trunk is the only server-enforced deadline** you get; everything else (first audio,
  silence, single-call) is application-enforced, and `hide_phone_number` removes `sip.phoneNumber` so any handset
  check must live on the trunk/dispatch rule, not in the agent.
