# Twilio / LiveKit voice-canary research — subaccount isolation, SIP handoff, independent fallback

**Scope:** public vendor documentation only (twilio.com/docs, docs.livekit.io, published Twilio permission PDFs). Retrieved 2026-09-22.
**Limits honored:** no logins, no API calls, no account/config changes, no `.env`/credential reads, no messages/calls/purchases, no repo files touched. Nothing below is tested against a live account; everything is quoted from docs.
**Legend:** ✅ = confirmed in vendor docs (URL given). ⚠️ UNVERIFIED = could not confirm from docs.

---

## Q1. Subaccount credential authority, and how to scope a key narrowly

### Can a subaccount read/modify the parent or sibling subaccounts?

**No** — for subaccount credentials.

> "You may also use a subaccount's AccountSid and AuthToken to access the resources of that subaccount. **You can't use a subaccount's credentials to access resources in your main Twilio account or any other subaccounts.**"
> — https://www.twilio.com/docs/iam/api/subaccounts (section *Authentication*)

✅ Confirmed.

### Can the parent's credentials access the subaccount?

**Yes.**

> "You can also access v2010 API resources for any of your subaccounts."
> — same page, *Authentication*

Two documented carve-outs a canary design must respect:
- ⚠️ Sub-domain resources (`studio.twilio.com`, `taskrouter.twilio.com`) "must be accessed directly using subaccount credentials". v2010-path resources (`/2010-04-01/...`, which includes `IncomingPhoneNumbers` and `Calls`) are reachable with **either** main or subaccount credentials.
- Billing/permissions: "Twilio bills all subaccount usage directly to your main account… If your main Twilio account is ever suspended, your subaccounts will also be suspended." and "Subaccounts use the main account's voice and SMS messaging permissions." → the canary subaccount **inherits the parent's voice/SMS permissions**; subaccount isolation is credential/resource isolation, not capability isolation.

### Do API keys cross the boundary?

| Key type | Access | Create where |
|---|---|---|
| **Main** | "Full access to all Twilio API resources. Equivalent to using your Account SID and Auth Token" | **Console only** (`/console/runtime/api-keys/create`) |
| **Standard** | "Access to all Twilio API resources, **except** for Accounts (`/Accounts`) or Keys (`/Accounts/{SID}/Keys`, `/v1/Keys`) resources" | Console or REST |
| **Restricted** | "Customized, fine-grained access to specific Twilio API resources" | Console or REST (**v1 only**) |

Sources: https://www.twilio.com/docs/iam/api-keys/key-resource-v2010 (*Types of keys*), https://www.twilio.com/docs/iam/api-keys/restricted-api-keys

Two warnings that matter for a narrower-than-standard key:
> "**Main account API Keys are only available to access main account resources. Access to subaccount resources will be denied.**" — /docs/iam/api/subaccounts
> "If your API key requires access to the Accounts (`/Accounts`) or Keys … endpoints, then you'll need to use a Main key." — /docs/iam/api-keys/key-resource-v2010

Net: a **Standard** key created *in the subaccount* cannot touch `/Accounts` (so it cannot enumerate or edit the parent or siblings) — that is a documented, enforced limitation of the key type itself.

### Restricted API keys — the narrow-scope mechanism

- Each permission maps to one endpoint/action; **max 100 permissions per key**.
- "You can't create Access Tokens for Twilio's client-side SDKs with Restricted API keys."
- Permissions are published as per-product PDFs (the docs page only links them; the tables are not inline).

Voice permissions PDF — exact slug confirmed for the call-modification endpoint a fallback detector needs:
```
/twilio/voice/calls/create | POST | https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls
/twilio/voice/calls/update | POST | https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls/{Sid}
```
Also present in that PDF: `/twilio/voice/calls/read`, `calls/list`, `calls/delete`, recordings, conferences, `sip.*` (domains, credential lists, IP ACLs), `byoc-trunks.*`, `source-ip-mappings.*`.
Source: https://docs-resources.prod.twilio.com/documents/Twilio_Restricted_API_Keys_Permissions_-_Voice_Permissions.pdf

Numbers permissions PDF — covers `IncomingPhoneNumbers` and account-level "active numbers":
```
…/Accounts/{AccountSid}/incomingPhoneNumbers      POST   (create)
…/Accounts/{AccountSid}/incomingPhoneNumbers      GET    (list)
…/Accounts/{AccountSid}/incomingPhoneNumbers/{sid} GET   (read)
…/Accounts/{AccountSid}/incomingPhoneNumbers/{sid} POST  (update)
…/Accounts/{AccountSid}/incomingPhoneNumbers/{sid} DELETE (release)
GET …/Accounts/{AccountSid}/incomingPhoneNumbers  ← "active-numbers/list"
```
plus Regulatory Compliance (Bundles, EndUsers, SupportingDocuments, ItemAssignments, Evaluations, Bundle Copies, ReplaceItems) and AvailablePhoneNumbers reads.
Source: https://docs-resources.prod.twilio.com/documents/Twilio_Restricted_API_Keys_Permissions_-_Numbers_Permissions.pdf

⚠️ **UNVERIFIED:** the *literal permission-slug strings* for the Numbers product. The published PDF's text layer renders that table mangled (e.g. `twilo/tphone-numbers/active-numbers/list`), so the endpoint→action mapping above is reliable but the exact slug spelling (e.g. `incoming-phone-numbers/create` vs another form) must be read off the Console when the key is actually created. The Voice rows rendered cleanly and are quoted verbatim.

### Reproducible negative-authority test without exposing secrets

Docs support these building blocks:
1. Credentials via environment variables, never in code: "Find your Account SID and Auth Token at twilio.com/console and set the environment variables. See http://twil.io/secure" (every REST sample page). Secrets are only returned once at creation: "Twilio returns the `secret` field only when the API key is first created and never includes the `secret` field when you fetch the resource."
2. The documented authority boundary to assert against (Q1 above): subaccount creds **must fail** on parent/sibling resources; parent creds **will succeed** on subaccount v2010 resources.
3. The documented key-type boundary to assert against: a Standard key **is denied** `/Accounts` and `/Keys`.

Test shape (all assertions map to a quoted doc statement; run in CI with the canary credentials injected as env vars, print only status codes, never the token):
- **PASS-expected (positive control):** subaccount key `GET /2010-04-01/Accounts/{CANARY_AC}/IncomingPhoneNumbers/{CANARY_PN}.json` → 200.
- **FAIL-expected (the actual isolation proof):** same key against `GET /2010-04-01/Accounts/{PARENT_AC}/IncomingPhoneNumbers.json` → must be rejected; and against `POST /2010-04-01/Accounts/{PARENT_AC}/IncomingPhoneNumbers/{PROD_PN}.json` → must be rejected. Also `GET /2010-04-01/Accounts/{PARENT_AC}.json` → rejected.
- **FAIL-expected (key-type proof):** same key against `/2010-04-01/Accounts/{CANARY_AC}/Keys.json` → rejected for a Standard key.
- **FAIL-expected (restricted-key proof):** with a Restricted key scoped to only the canary number's voice/messaging endpoints, every call the key is *not* scoped for must be rejected.

⚠️ **UNVERIFIED:** the exact HTTP status codes Twilio returns for these denials (401 vs 403 vs 404). No doc page states them. Assert "non-2xx and no state change" rather than a specific code, and confirm the codes once by hand.
⚠️ **UNVERIFIED:** whether rotating the parent Auth Token invalidates the subaccount Auth Token (the docs describe them as separate credentials but never state the rotation semantics).

---

## Q2. Two ways to hand a Twilio call to LiveKit SIP

### (i) Programmable Voice TwiML `<Dial><Sip>` from a webhook / TwiML Bin

LiveKit's own doc for this path — https://docs.livekit.io/telephony/accepting-calls/inbound-twilio/ — uses exactly this TwiML:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip username="<sip_trunk_username>" password="<sip_trunk_password>">
      sip:<your_phone_number>@<your SIP endpoint>;transport=tcp
    </Sip>
  </Dial>
</Response>
```
…then `lk sip inbound create inbound-trunk.json --auth-user <u> --auth-pass <p>` with the **same** username/password, and a dispatch rule. (LiveKit notes this method doesn't support SIP REFER or outbound calls; use Elastic SIP Trunking for those.)

**How SIP auth to the far end is configured:** `<Sip username="…" password="…">` attributes — "Send username and password attributes for authentication to your SIP infrastructure as attributes on the `<Sip>` noun." Also `;transport=udp|tcp|tls` and `;region=us1|…` on the URI, and `x-` custom headers (≤1024 chars) / `User-to-User`, `Remote-Party-ID`, `P-Preferred-Identity`, `P-Called-Party-ID`. — https://www.twilio.com/docs/voice/twiml/sip

LiveKit's side of the same credentials are inbound-trunk auth (`auth_username`/`auth_password`), and LiveKit explicitly notes: "LiveKit supports username and password authentication for inbound trunks, but your SIP trunking provider must also support it… **Twilio Elastic SIP Trunking doesn't support it, though you can use username and password authentication with TwiML.**" — https://docs.livekit.io/telephony/accepting-calls/inbound-trunk/

**What happens when the SIP leg fails:** `<Dial>` "will end the new call if the called party does not pick up, Twilio receives a busy signal, [or] the number does not exist." Control then passes to the Dial `action` URL with `DialCallStatus` ∈ `completed | answered (conference) | busy | no-answer | failed | canceled`, plus `DialCallSid`, `DialCallDuration`, `DialBridged`. For `<Sip>`, the action callback additionally receives the SIP CallID, the invite response code, returned X-headers, `Called`, `Caller`, `SipCallId`, `SipDomain`, `SipDomainSid`, `SipHeader_*`, `SipSourceIp`. Without an `action`, TwiML continues to the next verb in the document. — https://www.twilio.com/docs/voice/twiml/dial, https://www.twilio.com/docs/voice/twiml/sip

**Yes — this path supports a Dial `action` callback and therefore fallback TwiML:** "If you specify an `action` URL for `<Dial>`, Twilio will continue the initial call after the dialed party hangs up… Any TwiML verbs included after this `<Dial>` will be unreachable, as your response to Twilio takes full control of the initial call." That is the mechanism for "second TwiML app takes over".

**Supported attributes on this path (all confirmed):**
| Attribute | Behavior | Values |
|---|---|---|
| `timeout` | "the limit in seconds that `<Dial>` will wait for the dialed party to answer… before giving up and setting `no-answer` as the `DialCallStatus`" | default 30s, min 5s, max 600s; **"Twilio always adds a five-second timeout buffer"** |
| `timeLimit` | "the maximum duration of the `<Dial>` in seconds" (auto-hangup) | default 14400s (4h) |
| `answerOnBridge` | "if `<Dial>` is the first TwiML verb… the inbound call will ring until the dialed number answers. If your inbound call is a SIP call, Twilio will send a 180 or 183 to your SIP server once it connects to Twilio. It will wait until the `<Dial>` call connects to return a 200." | `true`/`false`, default `false` |
| `record`, `hangupOnStar`, `callerId`, `method`, `sequential`, `ringTone`, `trim`, `referUrl`/`referMethod`, `recordingStatusCallback*` | as documented | — |

`statusCallback` / `statusCallbackEvent` are available **on the `<Sip>` noun**: `statusCallbackEvent` ∈ `initiated | ringing | answered | completed` (default: none), `statusCallback` = any URL, `statusCallbackMethod` GET/POST (default POST). `<Sip>` also takes `url` (call-screening TwiML run on the called party's end after answer, before bridging; may not contain `<Dial>`) and `machineDetection`. — https://www.twilio.com/docs/voice/twiml/sip

**`VoiceFallbackUrl` per-number semantics — it does NOT fire on SIP-leg failure.** Documented as:
> "VoiceFallbackUrl: The URL that we should call **when an error occurs retrieving or executing the TwiML requested by `url`**."
> — https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource

So it covers primary-webhook/TwiML *execution* errors only. A SIP leg that returns busy/no-answer is a normal `<Dial>` outcome, not a TwiML error → `VoiceFallbackUrl` is the wrong fallback hook for (b); the `action` URL + `DialCallStatus` is the right one. ✅

### (ii) Elastic SIP Trunking origination to a LiveKit SIP URI

LiveKit's primary Twilio guide — https://docs.livekit.io/telephony/start/providers/twilio/ — creates a trunk (`--domain-name "my-test-trunk.pstn.twilio.com"`), then for inbound:

```shell
twilio api trunking v1 trunks origination-urls create \
--trunk-sid <twilio_trunk_sid> \
--friendly-name "LiveKit SIP URI" \
--sip-url "sip:<your SIP endpoint>;transport=tcp" \
--weight 1 --priority 1 --enabled
```
and associates the number with `twilio api trunking v1 trunks phone-numbers create --trunk-sid … --phone-number-sid …`. LiveKit's guide also says: "For inbound calls, you can use TwiML for Programmable Voice **instead of** setting up Elastic SIP Trunking."

**SIP auth to the far end on this path:** the origination URI carries the SIP address + `transport=tls|tcp` (+ optional `region=`); Twilio's trunk **Termination** side uses Credential Lists, but for **Origination** the trunk docs describe no username/password attribute (OriginationUrl body params are exactly `Weight`, `Priority`, `Enabled`, `FriendlyName`, `SipUrl`). LiveKit states Twilio Elastic SIP Trunking does not support inbound username/password, and that LiveKit inbound trunks require either username/password **or** `allowed_addresses` when `numbers` is empty — and "The `allowed_addresses` field must be enabled for your project before you can use it. Contact LiveKit support to request access."

⚠️ **UNVERIFIED:** whether a Twilio Elastic SIP trunk origination URI can carry SIP digest credentials at all. Not documented on https://www.twilio.com/docs/sip-trunking or https://www.twilio.com/docs/sip-trunking/api/originationurl-resource. (This is what makes (d) — authenticated **or** source-restricted ingress — a LiveKit-side + enablement question on this path.)

**Failure behavior:** up to **10** origination URIs.
> "Twilio will always use the SIP URI with the lowest-numbered priority value first, and fallback to other SIP URIs of equal or higher value **if the session to that SIP URI fails**." `Priority` 0–65535 (lowest = most important); `Weight` 1–65535 (load share, only among equal priorities). `Enabled` toggles a URI out of route selection.
> "Note: If any of the following SIP status codes are returned ("2xx", "400", "404", "405", "410", "416", "482", "484", "486", "6xx"), Twilio will **not** fail over to the next origination SIP URI. **If there is no SIP response from a given server, Twilio will fail over after 4 seconds.**"
> — https://www.twilio.com/docs/sip-trunking (*Using Multiple Origination SIP URIs*), https://www.twilio.com/docs/sip-trunking/api/originationurl-resource

⚠️ **Critical for the canary:** **486 (busy) is in the no-failover list**. A busy/no-answer far end does not roll to the next origination URI — that is only about transport/session failure, not "the AI didn't answer".

**Elastic SIP Trunking has no Dial `action` callback, no `timeout`, no `statusCallback`, no `answerOnBridge`.** Those are Programmable Voice concepts; a trunked inbound call is handed to the origination URI or to the trunk's **Disaster Recovery URL**:
> "In the case of a disaster preventing your calls from being delivered to your origination SIP URI above, you can configure a **Disaster Recovery URL** pointing to an application built on… TwiML." (e.g. `http://fallback.example.com/index`; normal Twilio Voice rates apply)
> — https://www.twilio.com/docs/sip-trunking (*Disaster Recovery URL*)

⚠️ **UNVERIFIED:** the exact trigger set for the Disaster Recovery URL (does it fire on 486 / no-answer / ring-timeout, or only when *every* origination URI is unreachable?), whether it is configurable via the Trunking REST API v1 or Console-only, and its field name. The docs on that page state the condition only as "a disaster preventing your calls from being delivered".

**Additional LiveKit-side fallback:** "To add redundancy, configure more than one origination URI on your trunk and let Twilio fail over between them… use `priority` (not `weight`) to control fallback order." LiveKit's example puts a region-based endpoint at `priority 2` behind the global endpoint. LiveKit also notes Cloud already fails over between regions automatically, and calls provider-side fallbacks "an advanced option". — https://docs.livekit.io/telephony/start/providers/twilio/#inbound-fallbacks, https://docs.livekit.io/telephony/features/region-pinning/

### Which does LiveKit's own guide use?

**Both, for different things.** The main telephony quickstart (`/telephony/start/providers/twilio/`) is Elastic SIP Trunking with origination URIs + priority-based fallback. The TwiML `<Dial><Sip>` variant is a documented, first-class alternative for inbound only (`/telephony/accepting-calls/inbound-twilio/`), and it is the only one of the two that supports username/password toward LiveKit and SIP REFER-free inbound. For this canary's requirement (c) — kill switch by changing only the number's Voice handler, with `SmsUrl` untouched — the **TwiML path is the only one that works**, because of the `TrunkSid` override in Q4.

---

## Q3. Can Twilio itself enforce "no first-audio / no controller-success within N seconds"?

**Partially. No native "first audio" signal; yes to a SIP-answered deadline; yes to an external detector acting on a live call.**

What Twilio can enforce on its own:
- `<Dial timeout>` (5–600s, default 30s, +5s buffer) → sets `DialCallStatus=no-answer` and invokes the `action` URL. This is a **ring/answer** deadline, not an audio deadline.
- `<Sip statusCallbackEvent="initiated,ringing,answered,completed">` → `answered` = the SIP leg got a 200 OK. Signaling-level answer, **not** first audio. There is no documented Twilio primitive that observes RTP/first-audio (only `statusCallbackEvent` at the SIP layer and `<Dial>`'s `DialCallStatus`).
- `<Dial timeLimit>` = hard cap on call duration (not a startup deadline).

⚠️ **UNVERIFIED:** any Twilio-side notion of "first audio" / media-flow detection. Nothing in the `<Sip>`, `<Dial>`, `Calls` or SIP-trunking references describes it. This is the gap an independent detector must fill.

**Cleanest documented pattern for an independent detector** — the Calls API "Update a Call" resource, which can redirect a live call from outside the AI agent/controller:

```
POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls/{Sid}.json
```
> "Updating a Call allows you to modify an active call… Real-time call modification allows you to interrupt an in-progress call and terminate it or have it begin processing TwiML from either a new URL or from the TwiML provided with modification… you can **redirect a call that is in progress** or you can **terminate a call**."

`UpdateCallRequest` body parameters (exact names):
| Param | Notes |
|---|---|
| `Url` | "The absolute URL that returns the TwiML instructions for the call." |
| `Twiml` | "TwiML instructions for the call Twilio will use without fetching Twiml from url. **Twiml and url parameters are mutually exclusive**" |
| `Method` | `GET`/`POST` |
| `Status` | `canceled` \| `completed` (terminate) |
| `FallbackUrl`, `FallbackMethod` | "if an error occurs when requesting or executing the TwiML at `url`" |
| `StatusCallback`, `StatusCallbackMethod` | ⚠️ "To update a `StatusCallback` on a Call, it is required to set the `Url` in the same statement." |
| `TimeLimit` | "The maximum duration of the call in seconds." |

Source: https://www.twilio.com/docs/voice/api/call-resource (*Update a Call*); how-to: /docs/voice/tutorials/how-to-modify-calls-in-progress

**Recommended independent-detector pattern** (assembled from documented primitives — the *combination* is a design, not a documented recipe):
1. TwiML app on the canary number: `<Dial action="https://detector/twilio/dial-ended" timeout="N">` → `<Sip username password statusCallback="https://detector/twilio/sip-event" statusCallbackEvent="answered completed">` → LiveKit.
2. The detector is a **separate service** (its own host, its own Restricted key scoped to `/twilio/voice/calls/update` only — see Q1). It arms a timer when the SIP leg is `initiated`/`ringing`.
3. If `answered` does not arrive by the deadline, or the controller's out-of-band "success" ping never arrives, the detector fires `POST /2010-04-01/Accounts/{CanaryAC}/Calls/{CallSid}.json` with `Twiml=<fallback TwiML>` (human transfer, then voicemail) — or `Status=canceled` to drop the leg and let the `action` URL's fallback TwiML take over.
4. Independence: the detector depends only on Twilio's REST API + Twilio's SIP/status webhooks, never on the LiveKit agent or controller.

⚠️ **UNVERIFIED:** that `Url`/`Twiml` redirection is permitted on a call that originated from an inbound `<Dial><Sip>` (parent leg vs child leg — the docs refer to `parent_call_sid` but do not state which leg may be redirected). Also UNVERIFIED: minimum latency for the redirect to take effect. Both should be smoke-tested on a canary number only.

---

## Q4. IncomingPhoneNumber resource — exact field names

Source: https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource (all descriptions quoted from the published schema).

**Voice handler:**
| Field | Documented description |
|---|---|
| `VoiceUrl` | "The URL that we should call to answer a call to the new phone number. **The `voice_url` will not be called if a `voice_application_sid` or a `trunk_sid` is set.**" |
| `VoiceMethod` | GET/POST, default POST |
| `VoiceFallbackUrl` | "The URL that we should call **when an error occurs retrieving or executing the TwiML requested by `url`**." |
| `VoiceFallbackMethod` | GET/POST, default POST |
| `VoiceApplicationSid` | "If a `voice_application_sid` is present, we ignore all of the voice urls and use only those set on the application. **Setting a `voice_application_sid` will automatically delete your `trunk_sid` and vice versa.**" |
| `TrunkSid` | "The SID of the Trunk we should use to handle calls to the new phone number. **If a `trunk_sid` is present, we ignore all of the voice urls and voice applications and use only those set on the Trunk.** Setting a `trunk_sid` will automatically delete your `voice_application_sid` and vice versa." |
| also | `StatusCallback`, `StatusCallbackMethod`, `VoiceReceiveMode` (`voice`/`fax`), `VoiceCallerIdLookup` |

**Messaging handler:**
| Field | Documented description |
|---|---|
| `SmsUrl` | "The URL we should call when the new phone number receives an incoming SMS message." |
| `SmsMethod` | GET/POST, default POST |
| `SmsFallbackUrl` | "The URL that we should call when an error occurs while requesting or executing the TwiML defined by `sms_url`." |
| `SmsFallbackMethod` | GET/POST, default POST |
| `SmsApplicationSid` | "If an `sms_application_sid` is present, we ignore all of the `sms_*_url` urls and use those set on the application." |

**Does updating `VoiceUrl` alone leave `Sms*` fields untouched?**
⚠️ **UNVERIFIED from docs.** No page states that IncomingPhoneNumber updates are partial/patch semantics; the resource doc lists `Sms*` and `Voice*` as independent properties with no cross-coupling, which implies they are independent — but that is inference, not documentation. **Mitigation (documented tooling):** take a `GET` snapshot of the canary `IncomingPhoneNumber` before and after the kill-switch `POST`, and diff every `sms_*`/`voice_*` key. That is the only way to *prove* byte-identical `SmsUrl` — which is exactly the (c) requirement.

**Does `TrunkSid` override `VoiceUrl`?** ✅ **Yes, explicitly** — both quotes above. Consequences for the canary:
- With an Elastic SIP trunk attached, changing `VoiceUrl` is a **no-op**; the trunk's Origination URIs / Disaster Recovery URL decide the call. The (c) kill switch therefore **cannot** be implemented on the trunk path.
- Moving to the TwiML path requires clearing `TrunkSid` (a second field write, `TrunkSid=""`), and setting a `voice_application_sid` would additionally delete the trunk — so the canary number must be **created/kept TrunkSid-free** from the start for (c) to be a single-field operation.

---

## Q5. Moving an existing number parent → subaccount

✅ **Documented, single API call:**
```js
client.incomingPhoneNumbers('PN…').update({ accountSid: process.env.TWILIO_SUB_ACCOUNT_SID })
```
Doc heading: *"Transfer phone numbers from primary account to subaccount"* — https://www.twilio.com/docs/iam/api/subaccounts (example shows `account_sid` changing to the subaccount `AC…` while `sid`, `phone_number`, `friendly_name` stay). Because the response includes `sms_application_sid`, `sms_fallback_url`, `sms_url`, `voice_application_sid`, `voice_fallback_url`, `voice_url`, `trunk_sid`, the transfer is performed as a normal IncomingPhoneNumber **update**, i.e. unspecified fields are not sent.

⚠️ **UNVERIFIED:** that the move *preserves* the Sms/Voice config. The docs don't state preservation either way, and in the example output most voice/sms fields are `null`/empty to begin with. **Verify by diffing the IncomingPhoneNumber snapshot before and after.**
⚠️ **UNVERIFIED:** which credential may perform it (parent Auth Token vs Standard key vs Main key). `IncomingPhoneNumbers` is a v2010 resource so an API key should suffice, but the subaccounts page says its examples use the parent Account SID + Auth Token and that "Standard API keys can't access Accounts resources" — the interaction is not spelled out.

**Regulatory / A2P 10DLC — FLAG ONLY (not researched; docs give no move-specific guidance):**
- The IncomingPhoneNumber create params include `BundleSid`, `AddressSid`, `IdentitySid` ("Some regions require a Bundle to meet local Regulations"). A number that currently sends SMS is presumably attached to a US A2P 10DLC brand/campaign **on the parent account** — moving the number to a subaccount may or may not carry that registration.
- ⚠️ **UNVERIFIED:** any doc statement about (a) whether 10DLC brand/campaign registration follows a number across accounts, (b) whether a Regulatory Bundle must be re-attached post-move, (c) messaging throughput impact. Treat as a **support-ticket question before the move**, and note the canary should ideally be a **newly purchased, voice-only number in the subaccount** so no production Messaging path is ever touched.

---

## Q6. Twilio request signing (`X-Twilio-Signature`)

Source: https://www.twilio.com/docs/usage/security (*Validating requests* / *Explore the algorithm yourself*).

Documented signing procedure:
1. Serve the webhook over HTTPS (no self-signed certs; "Do not pin Twilio certificates. Twilio rotates certificates without notice.").
2. Build the string: the full request URL (scheme through end of query string) + — for `POST` — all POST fields **sorted alphabetically by name** ("using Unix-style case-sensitive sorting order"), each appended as name immediately followed by value, **with no delimiter**. For `GET`, the params arrive already appended in the query string with `&`.
3. Sign with **HMAC-SHA1** using the **AuthToken as the key** ("remember, your AuthToken's case matters!").
4. Base64-encode the hash.
5. Twilio sends it in the header `X-Twilio-Signature`.

Validation — use the SDK method rather than re-implementing:
```js
const client = require('twilio');
console.log(client.validateRequest(authToken, twilioSignature, url, params));
```
```py
from twilio.request_validator import RequestValidator
validator = RequestValidator(auth_token)
# validator.validate(url, params, twilio_signature)
```
Explicit doc warning that must shape the canary webhook implementation:
> "In practice, this MUST include all received parameters, not a hardcoded list of parameters that you receive today. New parameters may be added without notice."

Also documented: HTTP Basic/Digest is supported for TwiML URLs (`https://username:password@www.myserver.com/my_secure_document`), and the project setting *SSL Certificate Validation* enforces webhook TLS validation.

⚠️ **UNVERIFIED:** that the signing key for a webhook belonging to a **subaccount-owned number** is that subaccount's Auth Token (the docs say "your AuthToken" generically; per-account tokens are implied everywhere but never stated for cross-account cases). ⚠️ Also UNVERIFIED: whether any SHA-256 variant is offered — the page's algorithm section is SHA-1 only, with a separate "A note on HMAC-SHA1" discussion.

---

## Consolidated design implications for the canary (doc-backed)

1. **Isolation (a):** a subaccount-owned Standard or Restricted key is documented to be unable to reach `/Accounts` or sibling resources, and subaccount credentials are documented as unable to reach the main account. Prove it with the negative-authority test in Q1; the *exact* denial status codes are UNVERIFIED.
2. **Handoff (b)/(c):** use the **TwiML `<Dial><Sip>`** path (LiveKit's documented inbound-TwiML guide), **not** a TrunkSid attachment — `TrunkSid` makes `VoiceUrl` inert (Q4), which breaks the "change only VoiceUrl" kill switch. Keep `VoiceApplicationSid` and `TrunkSid` empty so the kill switch really is one field.
3. **Fallback trigger (b):** `VoiceFallbackUrl` fires only on TwiML retrieval/execution error (Q4) — the SIP-leg-failure fallback must be the Dial `action` URL keyed on `DialCallStatus`, plus a `statusCallbackEvent` hook on `<Sip>`.
4. **Deadline (b):** Twilio has no "first audio" primitive (Q3). Use an **independent detector** calling `POST /Calls/{Sid}` with `Twiml`/`Url` (documented live-call redirect), holding only the `/twilio/voice/calls/update` Restricted permission. Note the trunk path's failover list excludes **486** (Q2) — a busy far end will not roll to a backup origination URI.
5. **Sms byte-identical (c):** no doc guarantees partial updates. Capture/diff the IncomingPhoneNumber snapshot around the change.
6. **SIP ingress (d):** TwiML path supports `username`/`password` on `<Sip>` toward LiveKit (LiveKit inbound trunk `auth_username`/`auth_password`). The Elastic SIP Trunking path does **not** support inbound username/password (per LiveKit), leaving only LiveKit `allowed_addresses` — which "must be enabled for your project… Contact LiveKit support to request access." ⚠️ UNVERIFIED whether Twilio origination URIs can carry SIP credentials.
