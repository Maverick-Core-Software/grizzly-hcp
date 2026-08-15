/**
 * Read recent inbound SMS on the ops (hermes-pc-sms) line.
 *
 * Outbound booking alerts use OPS_SMS_FROM → OPS_SMS_TO. Carter's replies are
 * inbound messages To=OPS_SMS_FROM From=OPS_SMS_TO. Hermes may also receive
 * those; we still process SCHEDULE commands here via the Twilio REST log so
 * approval does not depend on Hermes tools.
 */
import { resolveOpsSmsConfig } from './alert.js';

export type OpsInboundSms = {
  sid: string;
  body: string;
  from: string;
  to: string;
  dateSent: string;
};

export async function fetchRecentOpsInboundSms(opts?: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** How far back to look (default 48h). */
  lookbackMs?: number;
  pageSize?: number;
}): Promise<OpsInboundSms[]> {
  const env = opts?.env ?? process.env;
  const cfg = resolveOpsSmsConfig(env);
  if (!cfg) return [];

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const pageSize = opts?.pageSize ?? 30;
  const params = new URLSearchParams({
    To: cfg.from,
    From: cfg.to,
    PageSize: String(pageSize),
  });

  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json?${params}`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Twilio list messages HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    messages?: Array<{
      sid?: string;
      body?: string;
      from?: string;
      to?: string;
      date_sent?: string;
      direction?: string;
    }>;
  };

  const lookbackMs = opts?.lookbackMs ?? 48 * 60 * 60 * 1000;
  const cutoff = Date.now() - lookbackMs;

  return (data.messages ?? [])
    .filter((m) => {
      // Inbound to the ops line only.
      if (m.direction && !/inbound/i.test(m.direction)) return false;
      const sent = m.date_sent ? Date.parse(m.date_sent) : NaN;
      if (Number.isFinite(sent) && sent < cutoff) return false;
      return Boolean(m.sid && m.body);
    })
    .map((m) => ({
      sid: String(m.sid),
      body: String(m.body ?? '').trim(),
      from: String(m.from ?? ''),
      to: String(m.to ?? ''),
      dateSent: String(m.date_sent ?? ''),
    }));
}
