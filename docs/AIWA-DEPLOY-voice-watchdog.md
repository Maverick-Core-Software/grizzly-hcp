# AIWA Deployment — Voice Line Watchdog

> Every server action in this document requires Carter's explicit approval before it is performed. This repository supplies the reviewed source and unit files; use the gated Orca AIWA runtime for every live action.

## Purpose

`voice-watchdog` runs every two minutes. It finds failed inbound calls and relevant Twilio ConversationRelay errors, then sends Carter a private ops alert with the full caller number so the customer can be called back. It also probes the public Funnel address over public DNS (both A and AAAA records) and records Tailscale Funnel ingress-rule drops from `tailscaled`.

Each invocation has a 70-second application deadline (inside the unit's 90-second limit). Every Twilio read, DNS lookup, probe, journal collection, and alert delivery is bounded. Normal Twilio reads start ten minutes before the saved watermark; bounded SID/incident dedupe prevents duplicate callback alerts, and the watermark advances only after both complete Twilio collections (including any Monitor resource lookups) finish successfully.

The watchdog does not handle calls and does not restart `voice-server`. It is a detector and recovery notification path for the case where Twilio cannot establish the ConversationRelay WebSocket and therefore never invokes the normal `<Connect action>` callback.

## Preflight

Before installation, through the approved Orca AIWA environment, confirm the reviewed commit is checked out in `/opt/grizzly-hcp` and that the target has the absolute Node and tsx paths used by the unit:

```bash
command -v node
test -f /opt/grizzly-hcp/node_modules/tsx/dist/cli.mjs
```

The existing `/opt/grizzly-hcp/.env` must already contain the production `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `VOICE_PUBLIC_URL`, and the existing ops-alert variables. Add watchdog variables only if an override is wanted:

- `VOICE_WATCHDOG_ENABLED` — defaults to enabled when unset.
- `VOICE_WATCHDOG_TEST_CALLERS` — optional comma-separated E.164 line-check callers.
- `VOICE_WATCHDOG_PUBLIC_URL` — optional override; otherwise `VOICE_PUBLIC_URL` is used.

Do not copy secrets into this repository or a command transcript.

## Dry run

Use dry run to inspect a past or current failure window without sending Carter an alert or changing the watchdog state. It reads Twilio calls and monitor alerts, queries public DNS, runs the TwiML and WebSocket handshakes, and reads the `tailscaled` journal when available. A journal collection failure is reported as `drops: null` with `journal: unavailable`; it is never represented as zero drops.

Export the required Twilio and voice environment values in the operator shell first—this program never loads `.env` itself—then run one of:

```bash
npx tsx src/ops/voice-watchdog.ts --dry-run
npx tsx src/ops/voice-watchdog.ts --dry-run --since 2026-09-23T00:00:00.000Z
VOICE_WATCHDOG_DRY_RUN=true npx tsx src/ops/voice-watchdog.ts
```

`--since` is accepted only with `--dry-run`. Output is exactly one redacted JSON object containing the watermark, masked call identifier, caller last four digits, Central-time failure label, would-send alert titles, per-address probe result, and ingress-drop count; dry run sends no alert and writes neither `voice-watchdog-state.json` nor the heartbeat file.

## Install and enable

After approval, copy the units and enable the timer. The service is `Type=oneshot`; enable the timer, not the service.

```bash
sudo cp deploy/aiwa/voice-watchdog.service /etc/systemd/system/
sudo cp deploy/aiwa/voice-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now voice-watchdog.timer
```

## Verify

Wait for one scheduled run, then inspect the timer, its service journal, and the local heartbeat. A healthy service normally becomes `inactive (dead)` between runs because it is oneshot; `Result=success` and the heartbeat are the useful signals.

```bash
sudo systemctl list-timers --all | grep voice-watchdog
sudo journalctl -u voice-watchdog.service -n 80 --no-pager
sudo systemctl show voice-watchdog.service -p Result -p ActiveState
sudo cat /opt/grizzly-hcp/data/voice-watchdog-heartbeat.json
```

The heartbeat contains the last run time, per-address TwiML/WebSocket result and status, failures found, ingress-drop count, and source statuses for `calls`, `alerts`, `probe`, and `journal` (`ok`, `failed`, `unavailable`, or `incomplete`). It also records redacted `unattributedAlerts` (relevant Monitor records that had no `resource_sid`), `undeliverableAlerts`, and the last SMS/ntfy channel statuses; it contains no credentials or full destination numbers. An IPv6 address that cannot be connected from AIWA because of `ENETUNREACH`, `EHOSTUNREACH`, or `EADDRNOTAVAIL` is shown as `untestable`, not as a public outage; IPv4 failures and IPv6 addresses that returned a wrong HTTP status remain public-path failures. The state file is atomic and keeps bounded Twilio dedupe IDs and at most 100 pending alert retries; if it is corrupt, the watchdog starts fresh but considers only the most recent 30 minutes so it does not replay old missed-call alerts.

A `Result=failed` run means a Twilio collection failed or was incomplete, a Monitor resource lookup could not establish the caller, the 70-second application deadline was reached, or no configured alert channel accepted a required alert. It deliberately does not imply that a customer callback was sent; inspect the heartbeat source statuses and `lastDelivery` before retrying or investigating the named dependency. Journal unavailability and a detected public-path outage are visible in the heartbeat but do not by themselves make the unit fail.

## Alerts and operator response

| Alert | Meaning | Carter's action |
| --- | --- | --- |
| `Voice line: missed call` | Twilio reported an inbound terminal failure, completed zero-duration call, or a matching ConversationRelay/public-webhook monitor error. Related parent/child legs (and same-caller/same-number legs within five seconds) plus the Monitor Alert `resource_sid` are one incident, so the alert includes any relay error code once. | Use the full number in the private ops alert to call the customer back. A `line check` label means any leg in the incident used the configured test caller. |
| `Voice line: public path failing` | At least two consecutive runs had a failed TwiML or WebSocket check for an IPv4 public-DNS address, or an IPv6 address that connected and returned a wrong status. Local IPv6-unavailable addresses are heartbeat-only `untestable`. The alert includes ingress-drop context. | Call any missed customers back, then investigate Funnel/tailscaled ingress and the public listener. Do not assume the normal `/handoff` callback ran. |
| `Voice line: recovered` | All public-DNS-address checks are healthy after a previously alerted path failure. | Record recovery; still call back customers identified by earlier missed-call alerts. |

Missed-call incidents are persisted only after SMS or ntfy accepts them. If neither accepts, the individual incident is retried after 2, 4, 8, 16, and then 32 minutes, with no replay of any sibling incident that already delivered. After the sixth failed attempt it is marked given-up, counted as `undeliverableAlerts`, and logged with a redacted incident key; the retry list is capped at 100 entries. A relevant Monitor Alert with no `resource_sid` is instead deduped by its alert SID, counted as `unattributedAlerts` with its Twilio error code, and never generates an unknown-caller callback alert.

## Disable and rollback

To stop new watchdog runs while retaining the unit files for quick recovery:

```bash
sudo systemctl disable --now voice-watchdog.timer
```

To remove the installed units entirely after approval:

```bash
sudo rm /etc/systemd/system/voice-watchdog.timer
sudo rm /etc/systemd/system/voice-watchdog.service
sudo systemctl daemon-reload
```

This changes monitoring only. It does not change the Twilio number webhook, Funnel, `tailscaled`, PM2 `voice-server`, or existing call handling.
