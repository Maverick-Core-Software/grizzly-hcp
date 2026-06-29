/**
 * Decides whether an inbound Slack message should be handled by Maverick.
 *
 * Maverick answers in two places:
 *   - the configured ops channel (SLACK_CHANNEL_ID), and
 *   - 1:1 DMs (so Carter can talk to Maverick like a person).
 * The operator filter applies to both, so only Carter's messages get through.
 */
export function shouldHandleMessage(
  channel: string,
  channelType: string | undefined,
  user: string,
  opts: { channelId: string; operatorUserId: string },
): boolean {
  // DM channels report channel_type 'im'; their IDs also start with 'D' (belt + suspenders).
  const isDM = channelType === 'im' || channel.startsWith('D');
  if (opts.channelId && !isDM && channel !== opts.channelId) return false;
  if (opts.operatorUserId && user !== opts.operatorUserId) return false;
  return true;
}
