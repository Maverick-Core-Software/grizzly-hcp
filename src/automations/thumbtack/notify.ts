/**
 * Thumbtack Notifier — Slack + ntfy push notifications.
 *
 * Sends lead alerts and status updates so Carter knows what's happening
 * without watching a dashboard.
 */

const SLACK_WEBHOOK = process.env.SLACK_THUMBTACK_WEBHOOK || "";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const NTFY_URL = process.env.NTFY_URL || "https://ntfy.sh";

export interface LeadAlert {
  customerName: string;
  message: string;
  servicesIdentified: string[];
  estimateRange: string;
  jobId?: string;
}

export async function notifyNewLead(lead: LeadAlert): Promise<void> {
  const title = `🔌 New Thumbtack Lead: ${lead.customerName}`;
  const body = [
    `**Customer:** ${lead.customerName}`,
    `**Message:** ${lead.message.slice(0, 300)}${lead.message.length > 300 ? "…" : ""}`,
    `**Services identified:** ${lead.servicesIdentified.join(", ") || "none"}`,
    `**Estimate range:** ${lead.estimateRange}`,
    lead.jobId ? `**HCP Job:** ${lead.jobId}` : "",
  ].filter(Boolean).join("\n");

  await Promise.allSettled([
    sendSlack(title, body),
    sendNtfy(title, body),
  ]);
}

export async function notifyError(context: string, error: string): Promise<void> {
  const msg = `⚠️ Thumbtack Agent: ${context}\n\`\`\`\n${error}\n\`\`\``;
  await Promise.allSettled([
    sendSlack("Thumbtack Agent Error", msg),
    sendNtfy("Thumbtack Agent Error", msg),
  ]);
}

async function sendSlack(title: string, text: string): Promise<void> {
  if (!SLACK_WEBHOOK) return;
  try {
    await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `*${title}*\n${text}`,
      }),
    });
  } catch {
    // Fire-and-forget — don't crash the agent on notification failure
  }
}

async function sendNtfy(title: string, message: string): Promise<void> {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Title": title },
      body: message,
    });
  } catch {
    // Fire-and-forget
  }
}
