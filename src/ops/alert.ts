/**
 * Ops alerts — ntfy push to Carter for pipeline failures that would otherwise
 * be silent (the Jul 31–Aug 8 expired-cookie outage sat unnoticed in
 * data/pending-bookings.jsonl as failed_needs_manual records).
 *
 * Fire-and-forget: an alert failure must never take down the caller.
 * Reuses the same ntfy topic Carter already subscribes to for Thumbtack
 * (NTFY_TOPIC), overridable with OPS_NTFY_TOPIC.
 */

const NTFY_TOPIC = process.env.OPS_NTFY_TOPIC || process.env.NTFY_TOPIC || '';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';

export async function sendOpsAlert(
  title: string,
  message: string,
  opts?: { priority?: 'max' | 'urgent' | 'high' | 'default'; tags?: string }
): Promise<void> {
  if (!NTFY_TOPIC) {
    console.error(`[ops-alert] NTFY_TOPIC not set — dropping alert: ${title}`);
    return;
  }
  try {
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        // ntfy headers are ByteStrings — emoji/non-Latin-1 in Title throws.
        // Emoji belongs in Tags (ntfy renders tag shortcodes as icons).
        Title: title.replace(/[^\x20-\xff]/g, '').trim(),
        Priority: opts?.priority ?? 'urgent',
        Tags: opts?.tags ?? 'rotating_light',
      },
      body: message,
    });
  } catch (e) {
    // Fire-and-forget — log locally, never throw into the caller
    console.error(`[ops-alert] failed to send "${title}": ${e instanceof Error ? e.message : String(e)}`);
  }
}
