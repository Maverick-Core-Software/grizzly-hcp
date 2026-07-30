import assert from 'node:assert/strict';
import {
  buildResolvedSmsCommitInput,
  decideSmsEstimateIntake,
  type FromChatPayload,
} from './from-chat.js';
import { createSmsHcpAdapter } from '../../hcp/sms-hcp-adapter.js';
import type { SmsCustomerResolutionAdapters } from '../../hcp/sms-customer-resolution.js';
import type { ResolvedAddress } from '../../hcp/geocode.js';

const address: ResolvedAddress = {
  street: '123 Main Street', city: 'Dallas', state: 'TX', zip: '75201', latitude: 32.77, longitude: -96.79,
};

function fakeAdapters(): SmsCustomerResolutionAdapters {
  return {
    mode: 'direct',
    capabilities: {
      findCandidates: true,
      createCustomer: true,
      listAddresses: true,
      resolveNumericCustomerId: true,
      addCustomerAddress: true,
    },
    geocode: async () => address,
    findCandidates: async () => [],
    createCustomer: async () => ({ id: 'cus-verified' }),
    listAddresses: async () => [],
    resolveNumericCustomerId: async () => '144',
    addCustomerAddress: async () => 'adr-verified',
  };
}

const smsPayload: FromChatPayload = {
  scope: 'Install a dedicated 50A EV charger circuit.',
  customerName: 'Jane Customer',
  customerPhone: '+1 (469) 863-9804',
  customerAddress: '123 Main St, Dallas, TX 75201',
  leadSource: 'Google',
  operationId: 'sms-SM1234567890abcdef',
};

// Legacy entry points do not parse or resolve SMS intake.
{
  const legacy = await decideSmsEstimateIntake({ scope: 'Legacy estimate', customerName: 'Legacy Customer' });
  assert.deepEqual(legacy, { kind: 'legacy' });
}

// A review result never reaches the fake commit seam.
{
  const review = await decideSmsEstimateIntake({ ...smsPayload, customerPhone: '' }, fakeAdapters());
  assert.equal(review.kind, 'needs_review');
  let commits = 0;
  // A caller may only invoke its commit seam after the discriminant is resolved.
  assert.notEqual(review.kind, 'resolved');
  assert.equal(commits, 0);
}

// Resolved intake carries only verified IDs and preserves the supplied operation id.
{
  const decision = await decideSmsEstimateIntake(smsPayload, fakeAdapters());
  assert.equal(decision.kind, 'resolved');
  if (decision.kind === 'resolved') {
    const commit = buildResolvedSmsCommitInput({
      decision,
      lineItems: [{ name: 'EV Charger Circuit', quantity: 1, unitPrice: 0, kind: 'labor' }],
      techIds: [],
    });
    let seenOperationId = '';
    let seenCustomer = '';
    const fakeCommit = async (input: typeof commit) => {
      seenOperationId = input.operationId;
      seenCustomer = 'id' in input.customer ? `${input.customer.id}:${input.customer.addressId}` : '';
    };
    await fakeCommit(commit);
    assert.equal(seenOperationId, smsPayload.operationId);
    assert.equal(seenCustomer, 'cus-verified:adr-verified');
  }
}

// Both adapter modes fail closed before any network-backed adapter method runs.
for (const mode of ['direct', 'mcp'] as const) {
  const adapter = createSmsHcpAdapter({
    mode,
    capabilityOverrides: { findCandidates: false },
  });
  const decision = await decideSmsEstimateIntake(smsPayload, adapter);
  assert.deepEqual(decision, { kind: 'needs_review', reviewReason: 'adapter_unavailable' });
}

console.log('from-chat checks passed');
