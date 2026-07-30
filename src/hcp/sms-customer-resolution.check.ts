import assert from 'node:assert/strict';
import {
  resolveSmsCustomerAndAddress,
  type HcpCustomerCandidate,
  type HcpServiceAddress,
  type SmsCustomerResolutionAdapters,
} from './sms-customer-resolution.js';
import type { ResolvedAddress } from './geocode.js';

const resolvedAddress: ResolvedAddress = {
  street: '1600 Pennsylvania Avenue NW',
  city: 'Washington',
  state: 'DC',
  zip: '20500',
  latitude: 38.8977,
  longitude: -77.0365,
};

const input = {
  customerName: 'Avery Customer',
  customerPhone: '+1 (202) 555-0101',
  customerEmail: 'avery@example.com',
  customerAddress: '1600 Pennsylvania Avenue NW, Washington, DC 20500',
};

class FakeAdapters {
  mode: 'direct' | 'mcp' = 'direct';
  capabilities = {
    findCandidates: true,
    createCustomer: true,
    listAddresses: true,
    resolveNumericCustomerId: true,
    addCustomerAddress: true,
  };
  geocodeResult: ResolvedAddress | null = resolvedAddress;
  candidates: HcpCustomerCandidate[] = [];
  addresses = new Map<string, HcpServiceAddress[]>();
  throwListAddresses = false;
  calls = { geocode: 0, find: 0, create: 0, list: 0, numeric: 0, add: 0 };
  added: Array<{ numericCustomerId: string; streetLine2?: string }> = [];

  asAdapters(): SmsCustomerResolutionAdapters {
    return {
      mode: this.mode,
      capabilities: this.capabilities,
      geocode: async () => {
        this.calls.geocode += 1;
        return this.geocodeResult;
      },
      findCandidates: async () => {
        this.calls.find += 1;
        return this.candidates;
      },
      createCustomer: async () => {
        this.calls.create += 1;
        return { id: 'cus-created' };
      },
      listAddresses: async customerId => {
        this.calls.list += 1;
        if (this.throwListAddresses) throw new Error('read failed');
        return this.addresses.get(customerId) ?? [];
      },
      resolveNumericCustomerId: async () => {
        this.calls.numeric += 1;
        return '4001';
      },
      addCustomerAddress: async ({ numericCustomerId, address }) => {
        this.calls.add += 1;
        this.added.push({ numericCustomerId, streetLine2: address.streetLine2 });
        return 'adr-added';
      },
    };
  }
}

function existingAddress(id = 'adr-existing', streetLine2?: string): HcpServiceAddress {
  return {
    id,
    street: '1600 PENNSYLVANIA AVE NW',
    city: 'Washington',
    state: 'DC',
    zip: '20500-0003',
    ...(streetLine2 ? { streetLine2 } : {}),
  };
}

// No candidates means a new customer is created, then its successfully-read address list permits one add.
{
  const fake = new FakeAdapters();
  const result = await resolveSmsCustomerAndAddress(input, fake.asAdapters());
  assert.equal(result.kind, 'resolved');
  assert.equal(result.metadata.customerSource, 'created');
  assert.equal(result.addressId, 'adr-added');
  assert.equal(fake.calls.create, 1);
  assert.equal(fake.calls.list, 1);
  assert.equal(fake.calls.add, 1);
}

// A single phone-correlated candidate is safe, and the canonical address is reused.
{
  const fake = new FakeAdapters();
  fake.candidates = [{ id: 'cus-existing', name: input.customerName, phone: '202-555-0101' }];
  fake.addresses.set('cus-existing', [existingAddress()]);
  const result = await resolveSmsCustomerAndAddress(input, fake.asAdapters());
  assert.deepEqual(result.kind === 'resolved' ? result.metadata.matchingSignals : [], ['phone']);
  assert.equal(result.kind === 'resolved' ? result.addressId : undefined, 'adr-existing');
  assert.equal(fake.calls.create, 0);
  assert.equal(fake.calls.add, 0);
}

// Unit identifiers are part of the normalized identity: Apartment 3 must not reuse Apartment 2.
{
  const fake = new FakeAdapters();
  fake.candidates = [{ id: 'cus-unit', name: input.customerName, phone: '+12025550101' }];
  fake.addresses.set('cus-unit', [existingAddress('adr-unit-2', 'Unit 2')]);
  const result = await resolveSmsCustomerAndAddress({ ...input, customerAddress: '1600 Pennsylvania Avenue NW Apt 3, Washington, DC 20500' }, fake.asAdapters());
  assert.equal(result.kind, 'resolved');
  assert.equal(result.kind === 'resolved' ? result.addressId : undefined, 'adr-added');
  assert.equal(fake.calls.add, 1);
  assert.equal(fake.added[0].streetLine2, 'UNIT 3');
}

// Same-name results without corroborating phone, email, or address are review-only.
{
  const fake = new FakeAdapters();
  fake.candidates = [
    { id: 'cus-a', name: input.customerName },
    { id: 'cus-b', name: input.customerName },
  ];
  const result = await resolveSmsCustomerAndAddress(input, fake.asAdapters());
  assert.deepEqual(result, { kind: 'needs_review', reason: 'customer_ambiguous', metadata: { mode: 'direct' } });
  assert.equal(fake.calls.create, 0);
  assert.equal(fake.calls.list, 0);
  assert.equal(fake.calls.add, 0);
}

// Geocode failures stop before any HCP lookup or write.
{
  const fake = new FakeAdapters();
  fake.geocodeResult = null;
  const result = await resolveSmsCustomerAndAddress(input, fake.asAdapters());
  assert.deepEqual(result, { kind: 'needs_review', reason: 'address_unresolved', metadata: { mode: 'direct' } });
  assert.equal(fake.calls.find, 0);
  assert.equal(fake.calls.create, 0);
  assert.equal(fake.calls.add, 0);
}

// A failed authoritative address read cannot be treated as an absent address.
{
  const fake = new FakeAdapters();
  fake.candidates = [{ id: 'cus-read-fail', name: input.customerName, email: input.customerEmail }];
  fake.throwListAddresses = true;
  const result = await resolveSmsCustomerAndAddress(input, fake.asAdapters());
  assert.deepEqual(result, { kind: 'needs_review', reason: 'address_lookup_failed', metadata: { mode: 'direct' } });
  assert.equal(fake.calls.numeric, 0);
  assert.equal(fake.calls.add, 0);
}

// MCP is accepted only when it provides the complete capability set; it follows the same safe reuse path.
{
  const fake = new FakeAdapters();
  fake.mode = 'mcp';
  fake.candidates = [{ id: 'cus-mcp', name: input.customerName, phone: '+12025550101' }];
  fake.addresses.set('cus-mcp', [existingAddress('adr-mcp')]);
  const result = await resolveSmsCustomerAndAddress(input, fake.asAdapters());
  assert.equal(result.kind === 'resolved' ? result.metadata.mode : undefined, 'mcp');
  assert.equal(fake.calls.add, 0);
}

// Missing MCP capabilities and an unknown mode are review-only; neither starts a lookup or write.
{
  const fake = new FakeAdapters();
  fake.mode = 'mcp';
  fake.capabilities.listAddresses = false;
  const result = await resolveSmsCustomerAndAddress(input, fake.asAdapters());
  assert.deepEqual(result, { kind: 'needs_review', reason: 'adapter_unavailable', metadata: { mode: 'mcp' } });
  assert.equal(fake.calls.geocode, 0);
  assert.equal(fake.calls.create, 0);

  const unknownMode = new FakeAdapters();
  const adapters = unknownMode.asAdapters();
  (adapters as { mode: string }).mode = 'unsupported';
  const unknownResult = await resolveSmsCustomerAndAddress(input, adapters);
  assert.deepEqual(unknownResult, { kind: 'needs_review', reason: 'adapter_unavailable', metadata: { mode: 'unknown' } });
  assert.equal(unknownMode.calls.geocode, 0);
}

console.log('sms-customer-resolution checks passed');
