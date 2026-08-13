/**
 * Ops alerts — ntfy + Twilio SMS (hermes-pc-sms thread) for customer-facing
 * bookings and pipeline failures. The Jul 31–Aug 8 expired-cookie outage sat
 * unnoticed in data/pending-bookings.jsonl as failed_needs_manual records.
 *
 * Fire-and-forget per channel: an alert failure must never take down the caller.
 *
 * SMS uses a dedicated From number (OPS_SMS_FROM) so the text lands in Carter's
 * hermes-pc-sms conversation. Do NOT fall back to TWILIO_PHONE_NUMBER — that is
 * the customer voice/chat line.
 *
 * Env (read at call time):
 *   NTFY_TOPIC / OPS_NTFY_TOPIC, NTFY_URL
 *   OPS_TWILIO_ACCOUNT_SID (else TWILIO_ACCOUNT_SID)
 *   OPS_TWILIO_AUTH_TOKEN  (else TWILIO_AUTH_TOKEN)
 *   OPS_SMS_FROM, OPS_SMS_TO
 */

export const OPS_SMS_MAX_CHARS = 320;

const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';

export type OpsAlertOpts = {
  priority?: 'max' | 'urgent' | 'high' | 'default';
  tags?: string;
  fetchImpl?: typeof fetch;
};

export function formatOpsSms(title: string, message: string, max = OPS_SMS_MAX_CHARS): string {
  const body = `${title}\n${message}`.replace(/\n{3,}/g, '\n\n').trim();
  if (body.length <= max) return body;
  return `${body.slice(0, max - 1)}…`;
}

export function resolveOpsSmsConfig(env: NodeJS.ProcessEnv = process.env): {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
} | null {
  const accountSid = env.OPS_TWILIO_ACCOUNT_SID || env.TWILIO_ACCOUNT_SID || '';
  const authToken = env.OPS_TWILIO_AUTH_TOKEN || env.TWILIO_AUTH_TOKEN || '';
  const customerFrom = env.TWILIO_PHONE_NUMBER || '';
  const from = env.OPS_SMS_FROM || '';
  const to = env.OPS_SMS_TO || '';
  // Alerts must come from the hermes-pc-sms number, never the customer line.
  if (!accountSid || !authToken || !from || !to || from === customerFrom) return null;
  return { accountSid, authToken, from, to };
}

export async function sendOpsSms(
  body: string,
  opts?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv },
): Promise<{ sent: boolean; reason?: string }> {
  const cfg = resolveOpsSmsConfig(opts?.env ?? process.env);
  if (!cfg) return { sent: false, reason: 'not-configured' };
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: cfg.to,
          From: cfg.from,
          Body: String(body).slice(0, OPS_SMS_MAX_CHARS),
        }).toString(),
      },
    );
    if (!response?.ok) return { sent: false, reason: `http-${response?.status ?? 'unknown'}` };
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : 'unknown' };
  }
}

export async function sendOpsAlert(
  title: string,
  message: string,
  opts?: OpsAlertOpts,
): Promise<void> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const topic = process.env.OPS_NTFY_TOPIC || process.env.NTFY_TOPIC || '';
  const jobs: Array<Promise<void>> = [];

  if (topic) {
    jobs.push((async () => {
      try {
        await fetchImpl(`${NTFY_URL}/${topic}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            // ntfy headers are ByteStrings — emoji/non-Latin-1 in Title throws.
            Title: title.replace(/[^\x20-\xff]/g, '').trim(),
            Priority: opts?.priority ?? 'urgent',
            Tags: opts?.tags ?? 'rotating_light',
          },
          body: message,
        });
      } catch (e) {
        console.error(`[ops-alert] ntfy failed "${title}": ${e instanceof Error ? e.message : String(e)}`);
      }
    })());
  } else {
    console.error(`[ops-alert] NTFY_TOPIC not set — dropping ntfy: ${title}`);
  }

  jobs.push((async () => {
    const result = await sendOpsSms(formatOpsSms(title, message), { fetchImpl });
    if (!result.sent) {
      console.error(`[ops-alert] SMS not sent "${title}": ${result.reason}`);
    }
  })());

  await Promise.all(jobs);
}
