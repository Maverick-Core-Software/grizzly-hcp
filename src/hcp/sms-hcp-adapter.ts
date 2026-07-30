/**
 * Production transport binding for the SMS customer/address resolver.
 *
 * Keep this separate from sms-customer-resolution.ts: the resolver owns the
 * safety decision, while this file owns the direct/MCP wire shapes.  Neither
 * mode ever selects the first search result.
 */
import { HCP_VIA_MCP, addCustomerAddress, createCustomer } from './gateway.js';
import { hcpGet } from './client.js';
import { resolveNumericCustomerId } from './estimates.js';
import { resolveAddress } from './geocode.js';
import { apiGet, getCustomerV2 } from './mcp-client.js';
import type {
  HcpAdapterMode,
  HcpCustomerCandidate,
  HcpServiceAddress,
  SmsCustomerResolutionAdapters,
  SmsCustomerResolutionCapabilities,
} from './sms-customer-resolution.js';

type UnknownRecord = Record<string, unknown>;

interface HcpCustomerDetail extends UnknownRecord {
  id?: string;
  display_name?: string;
  name?: string;
  addresses?: { data?: unknown[] } | unknown[];
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return undefined;
}

function nested(value: UnknownRecord | undefined, key: string): UnknownRecord | undefined {
  return record(value?.[key]);
}

function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const valueRecord = record(value);
  return Array.isArray(valueRecord?.data) ? valueRecord.data : [];
}

function contactValue(detail: UnknownRecord, keys: string[]): string | undefined {
  const contact = nested(detail, 'contact_info');
  for (const key of keys) {
    const direct = firstText(detail[key], contact?.[key]);
    if (direct) return direct;
  }

  const plural = keys.some(key => key.includes('email')) ? ['emails', 'email_addresses'] : ['phones', 'phone_numbers'];
  for (const key of plural) {
    for (const candidate of collection(detail[key])) {
      const candidateRecord = record(candidate);
      const found = firstText(candidateRecord?.value, candidateRecord?.email, candidateRecord?.email_address, candidateRecord?.number, candidateRecord?.phone_number, candidateRecord?.phone);
      if (found) return found;
    }
  }
  return undefined;
}

function mapAddress(value: unknown): HcpServiceAddress | undefined {
  const address = record(value);
  const id = firstText(address?.id, address?.uuid);
  const street = firstText(address?.street, address?.street_line_1, address?.address1);
  const zip = firstText(address?.zip, address?.postal_code);
  if (!id || !street || !zip) return undefined;
  return {
    id,
    street,
    zip,
    ...(firstText(address?.city) ? { city: firstText(address?.city) } : {}),
    ...(firstText(address?.state) ? { state: firstText(address?.state) } : {}),
    ...(firstText(address?.street_line_2, address?.address2) ? { streetLine2: firstText(address?.street_line_2, address?.address2) } : {}),
  };
}

function mapAddresses(detail: UnknownRecord): HcpServiceAddress[] {
  return collection(detail.addresses).map(mapAddress).filter((address): address is HcpServiceAddress => Boolean(address));
}

function mapCandidate(detail: HcpCustomerDetail): HcpCustomerCandidate | undefined {
  const id = firstText(detail.id, detail.uuid);
  const name = firstText(detail.display_name, detail.name);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    ...(contactValue(detail, ['phone_number', 'phone']) ? { phone: contactValue(detail, ['phone_number', 'phone']) } : {}),
    ...(contactValue(detail, ['email', 'email_address']) ? { email: contactValue(detail, ['email', 'email_address']) } : {}),
    addresses: mapAddresses(detail),
  };
}

function customerSearchPath(name: string): string {
  const params = new URLSearchParams({
    q: name,
    page: '1',
    page_size: '10',
    contractor: 'false',
    has_email: 'false',
    sort_by: 'display_name',
    sort_direction: 'asc',
    for_franchise: 'false',
  });
  return `/alpha/customers?${params}`;
}

function customerDetailPath(customerId: string): string {
  return `/alpha/customers/${encodeURIComponent(customerId)}?expand[]=addresses`;
}

async function hydrateCandidates(
  name: string,
  apiGet: <T>(path: string) => Promise<T>,
): Promise<HcpCustomerCandidate[]> {
  const result = await apiGet<{ data?: unknown[] }>(customerSearchPath(name));
  const summaries = (result.data ?? []).slice(0, 10).map(record).filter((item): item is UnknownRecord => Boolean(item));
  const hydrated = await Promise.all(summaries.map(async summary => {
    const id = firstText(summary.id, summary.uuid);
    if (!id) return undefined;
    // The alpha detail endpoint is authoritative for service addresses.  The
    // search response is only a candidate list and must not drive a write.
    const detail = await apiGet<HcpCustomerDetail>(customerDetailPath(id));
    return mapCandidate(detail);
  }));
  return hydrated.filter((candidate): candidate is HcpCustomerCandidate => Boolean(candidate));
}

export interface SmsHcpAdapterOptions {
  /** Offline checks may exercise either transport without opening a connection. */
  mode?: HcpAdapterMode;
  /** Tests may deliberately disable a capability; production uses the defaults. */
  capabilityOverrides?: Partial<SmsCustomerResolutionCapabilities>;
}

/**
 * Creates the only production adapter accepted by the SMS resolver.  The mode
 * is fixed from the gateway setting so reads and writes cannot silently split
 * across direct and MCP transports.
 */
export function createSmsHcpAdapter(options: SmsHcpAdapterOptions = {}): SmsCustomerResolutionAdapters {
  const mode: HcpAdapterMode = options.mode ?? (HCP_VIA_MCP ? 'mcp' : 'direct');
  const mcpConfigured = Boolean(process.env.HCP_MCP_URL && process.env.HCP_MCP_TOKEN);
  const capabilities: SmsCustomerResolutionCapabilities = {
    findCandidates: mode === 'direct' || mcpConfigured,
    createCustomer: mode === 'direct' || mcpConfigured,
    listAddresses: mode === 'direct' || mcpConfigured,
    resolveNumericCustomerId: mode === 'direct' || mcpConfigured,
    addCustomerAddress: mode === 'direct' || mcpConfigured,
    ...options.capabilityOverrides,
  };

  const read = mode === 'mcp' ? apiGet : hcpGet;
  return {
    mode,
    capabilities,
    geocode: resolveAddress,
    findCandidates: name => hydrateCandidates(name, read),
    createCustomer: async input => {
      const customer = await createCustomer({ name: input.name, phone: input.phone, email: input.email ?? '' });
      return { id: customer.id };
    },
    listAddresses: async customerId => {
      const detail = await read<HcpCustomerDetail>(customerDetailPath(customerId));
      return mapAddresses(detail);
    },
    resolveNumericCustomerId: async customerId => {
      if (mode === 'mcp') {
        const detail = await getCustomerV2(customerId);
        const contact = record(detail.contact_info);
        const numericId = firstText(contact?.id, detail.id);
        if (!numericId) throw new Error('MCP customer detail did not include a numeric id');
        return numericId;
      }
      return resolveNumericCustomerId(customerId);
    },
    // Writes always use the existing gateway, which is pinned to the same
    // HCP_VIA_MCP mode selected above.
    addCustomerAddress: async ({ numericCustomerId, address }) => addCustomerAddress(numericCustomerId, address),
  };
}
