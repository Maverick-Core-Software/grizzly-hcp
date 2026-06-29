/**
 * Verifies the Slack message filter: Maverick answers Carter in the ops channel
 * and in 1:1 DMs, and ignores everything else. Run: npx tsx scripts/check-slack-dm-filter.ts
 */
import assert from 'node:assert';
import { shouldHandleMessage } from '../src/automations/slack/filter.js';

const opts = { channelId: 'C0BDU7PQ12M', operatorUserId: 'U0BBM2M69DK' };

// Operator in the configured ops channel → handled
assert.equal(shouldHandleMessage('C0BDU7PQ12M', 'channel', 'U0BBM2M69DK', opts), true);
// Operator DM (channel_type 'im') → handled
assert.equal(shouldHandleMessage('D0123ABCD', 'im', 'U0BBM2M69DK', opts), true);
// Operator DM detected by 'D' prefix even if channel_type is missing → handled
assert.equal(shouldHandleMessage('D0123ABCD', undefined, 'U0BBM2M69DK', opts), true);
// Some other public channel, even from the operator → ignored (stays channel-scoped)
assert.equal(shouldHandleMessage('C9999OTHER', 'channel', 'U0BBM2M69DK', opts), false);
// DM from a non-operator → ignored (Maverick is Carter-only)
assert.equal(shouldHandleMessage('D0123ABCD', 'im', 'USOMEONE', opts), false);

console.log('✓ slack filter: operator DMs + configured channel allowed, everything else dropped');
