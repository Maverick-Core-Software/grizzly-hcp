# C0 Twilio Functions deployment

This isolated service is deployed only after a separately approved canary change. Do not deploy it from this repository as part of local verification.

From this directory, load the approved environment values from `../.env.c0` into the deployment shell without printing them, then deploy with one of these supported commands:

```powershell
twilio serverless:deploy
```

```powershell
npx @twilio-labs/serverless-api deploy
```

The deployed service must route `/ingress` to `functions/ingress.protected.js` so Twilio validates the incoming request signature. Every Twilio-invoked route is protected (`ingress`, `dial-action`, `fallback`, `fallback-next`, `whisper`, and `voicemail-done`), while the route paths remain unchanged. Configure all destinations and credentials through the C0 environment; do not place values in source or command lines.

Before deploying, confirm the canary number's Voice handler points at `/ingress` and its application/trunk settings remain empty. Deployment itself, number routing, and environment changes are live operations and require explicit approval.

## Sync lease and transfer state

Set `C0_SYNC_SERVICE_SID` to the isolated C0 Sync Service. The restricted key used by the Functions must be permitted to create, fetch, conditionally update, and delete Sync Documents in that service; Functions require the same document operations for the `c0-lease` admission lease, short-lived `c0-transfer-<ParentCallSid>` handoff flags, and short-lived `c0-admitted-<ParentCallSid>` positive-admission flags. The ingress lease expires after `C0_TIME_LIMIT_S + 120` seconds, while transfer and admission flags expire after 900 seconds.

`/dial-action` consumes a transfer flag first. Otherwise it hangs up a completed Dial only when the matching positive-admission document exists; a missing admission document or any Sync read failure goes to office fallback. This keeps a SIP leg that disconnects before canary admission from being mistaken for completed service.

The rehearsal should still observe the parent-call redirect and `<Dial action>` ordering, but it is no longer correctness-critical: the transfer document is written before the agent terminates or redirects its AI leg, and `/dial-action` consumes that flag before considering a successful Dial outcome.

## SIP transport and media encryption

The default is `C0_SIP_TRANSPORT=tcp` and `C0_SIP_SECURE=false`. This is the documented interoperability default: LiveKit's Twilio programmable-voice guide uses the exact TwiML SIP URI form `;transport=tcp` for an inbound LiveKit trunk ([LiveKit Twilio Voice integration](https://docs.livekit.io/telephony/accepting-calls/inbound-twilio/)); it must be exercised in the approved canary rehearsal before any stricter setting is relied on.

Twilio documents that `<Sip>` supports `UDP`, `TCP`, and `TLS`, and that TLS is signaling encryption ([TwiML `<Sip>`](https://www.twilio.com/docs/voice/twiml/sip)). Twilio's general SIP URI guidance states that `transport=tls` encrypts signaling only and that `;secure=true` is needed to use SRTP with encrypted signaling ([Making SIP Calls](https://www.twilio.com/docs/voice/api/sip-making-calls)); however, the `<Dial><Sip>` reference does not itself document `secure=true`, so its behavior on this exact TwiML path is **UNVERIFIED** until the canary rehearsal proves it.

If the approved rehearsal is explicitly testing secure media, set `C0_SIP_TRANSPORT=tls` and `C0_SIP_SECURE=true`; the resulting URI has `;transport=tls;secure=true` before its query string. The provisioning script must set the LiveKit **inbound** trunk's non-deprecated `media.encryption` to `SIP_MEDIA_ENCRYPT_ALLOW`, which LiveKit defines as using encryption when available ([LiveKit SIP API](https://docs.livekit.io/reference/telephony/sip-api/)); LiveKit's secure-trunking guide says secure calls require provider-side SRTP/TLS, TLS SIP URIs, and media encryption, and shows `SIP_MEDIA_ENCRYPT_ALLOW` for an inbound trunk ([Secure trunking](https://docs.livekit.io/telephony/features/secure-trunking/)). `SIP_MEDIA_ENCRYPT_REQUIRE` is a stricter later choice, not the initial interoperability setting, because it rejects non-encrypted media.

The `X-C0-Call` syntax is documented: custom SIP headers are query parameters on the `<Sip>` URI and must use the `x-` prefix; Twilio allows a URI under 255 characters and headers under 1024 characters, and its examples URL-encode reserved header values ([TwiML `<Sip>` custom headers](https://www.twilio.com/docs/voice/twiml/sip/)). The handler therefore emits `?X-C0-Call=${encodeURIComponent(CallSid)}` after the SIP URI parameters; do not URL-encode the header name, and do not add values that exceed those limits.
