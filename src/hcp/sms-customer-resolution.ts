/**
 * Safe customer and service-address selection for SMS estimate intake.
 *
 * This module deliberately knows no HCP transport details.  The estimate
 * runner supplies a direct or MCP adapter explicitly, which keeps a missing
 * capability from silently falling back to a different HCP path.
 */
import { normalizeSmsPhone } from '../server/sms-intake.js';
import type { ResolvedAddress } from './geocode.js';

export type HcpAdapterMode = 'direct' | 'mcp';

export interface HcpServiceAddress {
  id: string;
  street: string;
  city?: string;
  state?: string;
  zip: string;
  streetLine2?: string | null;
}

export interface HcpCustomerCandidate {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  /** Candidate-query addresses may corroborate identity, but are not trusted for a write decision. */
  addresses?: HcpServiceAddress[];
}

export interface SmsCustomerResolutionCapabilities {
  findCandidates: boolean;
  createCustomer: boolean;
  listAddresses: boolean;
  resolveNumericCustomerId: boolean;
  addCustomerAddress: boolean;
}

/**
 * S4 binds this interface to either direct HCP helpers or MCP tools.  Both
 * modes must expose every operation: a partial MCP daemon is review-only.
 */
export interface SmsCustomerResolutionAdapters {
  mode: HcpAdapterMode;
  capabilities: SmsCustomerResolutionCapabilities;
  geocode(rawAddress: string): Promise<ResolvedAddress | null>;
  findCandidates(name: string): Promise<HcpCustomerCandidate[]>;
  createCustomer(input: { name: string; phone: string; email?: string }): Promise<{ id: string }>;
  listAddresses(customerId: string): Promise<HcpServiceAddress[]>;
  resolveNumericCustomerId(customerId: string): Promise<string>;
  addCustomerAddress(input: {
    numericCustomerId: string;
    address: NormalizedSmsServiceAddress;
  }): Promise<string>;
}

export interface SmsCustomerResolutionInput {
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerAddress: string;
}

export interface NormalizedSmsServiceAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
  latitude: number;
  longitude: number;
  streetLine2?: string;
  /** A stable, comparison-only form; it is not an HCP address ID. */
  normalizedAddress: string;
}

export type SmsCustomerResolutionReviewReason =
  | 'invalid_address'
  | 'address_unresolved'
  | 'customer_ambiguous'
  | 'lookup_failed'
  | 'address_lookup_failed'
  | 'adapter_unavailable'
  | 'customer_create_failed'
  | 'customer_id_lookup_failed'
  | 'address_create_failed';

export type SmsCustomerResolution =
  | {
    kind: 'resolved';
    customerId: string;
    addressId: string;
    normalizedAddress: NormalizedSmsServiceAddress;
    metadata: {
      mode: HcpAdapterMode;
      customerSource: 'existing' | 'created';
      matchingSignals: Array<'phone' | 'email' | 'address'>;
    };
  }
  | {
    kind: 'needs_review';
    reason: SmsCustomerResolutionReviewReason;
    metadata: { mode: HcpAdapterMode | 'unknown' };
  };

const REQUIRED_CAPABILITIES: Array<keyof SmsCustomerResolutionCapabilities> = [
  'findCandidates',
  'createCustomer',
  'listAddresses',
  'resolveNumericCustomerId',
  'addCustomerAddress',
];

function isKnownMode(mode: unknown): mode is HcpAdapterMode {
  return mode === 'direct' || mode === 'mcp';
}

function hasRequiredCapabilities(adapters: SmsCustomerResolutionAdapters): boolean {
  return REQUIRED_CAPABILITIES.every(capability => adapters.capabilities[capability] === true);
}

function normalizeEmail(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeUnit(value?: string | null): string | undefined {
  const normalized = value
    ?.toUpperCase()
    .replace(/\b(APARTMENT|APT|UNIT|SUITE|STE)\b/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();
  return normalized || undefined;
}

function normalizeStreet(value: string): string {
  const replacements: Record<string, string> = {
    AVENUE: 'AVE', BOULEVARD: 'BLVD', CIRCLE: 'CIR', COURT: 'CT', DRIVE: 'DR',
    EAST: 'E', HIGHWAY: 'HWY', LANE: 'LN', NORTH: 'N', NORTHEAST: 'NE',
    NORTHWEST: 'NW', PARKWAY: 'PKWY', PLACE: 'PL', ROAD: 'RD', SOUTH: 'S',
    SOUTHEAST: 'SE', SOUTHWEST: 'SW', STREET: 'ST', TERRACE: 'TER', TRAIL: 'TRL',
    WEST: 'W',
  };
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(token => replacements[token] ?? token)
    .join(' ');
}

function normalizedAddressKey(address: {
  street: string;
  city?: string;
  state?: string;
  zip: string;
  streetLine2?: string | null;
}): string {
  return [
    normalizeStreet(address.street),
    normalizeStreet(address.city ?? ''),
    normalizeStreet(address.state ?? ''),
    address.zip.replace(/\D/g, '').slice(0, 5),
    normalizeUnit(address.streetLine2) ?? '',
  ].join('|');
}

function extractStreetLine2(rawAddress: string): string | undefined {
  const unit = rawAddress.match(/(?:,|\s)\s*(?:APT(?:ARTMENT)?|UNIT|SUITE|STE|#)\s*([A-Z0-9-]+)\b/i)?.[1];
  return unit ? `UNIT ${unit.toUpperCase()}` : undefined;
}

function normalizeResolvedAddress(rawAddress: string, resolved: ResolvedAddress | null): NormalizedSmsServiceAddress | undefined {
  if (!resolved) return undefined;
  const street = resolved.street?.trim();
  const city = resolved.city?.trim();
  const state = resolved.state?.trim().toUpperCase();
  const zip = resolved.zip?.trim();
  if (!street || !city || !state || !zip || !Number.isFinite(resolved.latitude) || !Number.isFinite(resolved.longitude)) {
    return undefined;
  }
  const streetLine2 = extractStreetLine2(rawAddress);
  const address: NormalizedSmsServiceAddress = {
    street,
    city,
    state,
    zip,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    ...(streetLine2 ? { streetLine2 } : {}),
    normalizedAddress: '',
  };
  return { ...address, normalizedAddress: normalizedAddressKey(address) };
}

function addressMatches(existing: HcpServiceAddress, wanted: NormalizedSmsServiceAddress): boolean {
  return normalizedAddressKey(existing) === wanted.normalizedAddress;
}

function matchingSignals(candidate: HcpCustomerCandidate, input: SmsCustomerResolutionInput, address: NormalizedSmsServiceAddress): Array<'phone' | 'email' | 'address'> {
  const signals: Array<'phone' | 'email' | 'address'> = [];
  const phone = normalizeSmsPhone(input.customerPhone);
  if (phone && normalizeSmsPhone(candidate.phone ?? '') === phone) signals.push('phone');

  const email = normalizeEmail(input.customerEmail);
  if (email && normalizeEmail(candidate.email) === email) signals.push('email');

  if ((candidate.addresses ?? []).some(existing => addressMatches(existing, address))) signals.push('address');
  return signals;
}

function review(reason: SmsCustomerResolutionReviewReason, mode: HcpAdapterMode | 'unknown'): SmsCustomerResolution {
  return { kind: 'needs_review', reason, metadata: { mode } };
}

/**
 * Resolves the only customer/address pair that is safe to give to the estimate
 * workflow.  Review results make no address or estimate writes; callers must
 * stop rather than falling back to a customer's default address.
 */
export async function resolveSmsCustomerAndAddress(
  input: SmsCustomerResolutionInput,
  adapters: SmsCustomerResolutionAdapters,
): Promise<SmsCustomerResolution> {
  const mode = isKnownMode(adapters.mode) ? adapters.mode : 'unknown';
  if (mode === 'unknown' || !hasRequiredCapabilities(adapters)) {
    return review('adapter_unavailable', mode);
  }

  let geocoded: ResolvedAddress | null;
  try {
    geocoded = await adapters.geocode(input.customerAddress);
  } catch {
    return review('address_unresolved', mode);
  }
  const address = normalizeResolvedAddress(input.customerAddress, geocoded);
  if (!address) return review(geocoded ? 'invalid_address' : 'address_unresolved', mode);

  let candidates: HcpCustomerCandidate[];
  try {
    candidates = await adapters.findCandidates(input.customerName);
  } catch {
    return review('lookup_failed', mode);
  }

  const strongCandidates = candidates
    .map(candidate => ({ candidate, signals: matchingSignals(candidate, input, address) }))
    .filter(({ signals }) => signals.length > 0);

  let customerId: string;
  let customerSource: 'existing' | 'created';
  let signals: Array<'phone' | 'email' | 'address'>;
  if (candidates.length === 0) {
    try {
      const created = await adapters.createCustomer({
        name: input.customerName,
        phone: input.customerPhone,
        ...(normalizeEmail(input.customerEmail) ? { email: normalizeEmail(input.customerEmail) } : {}),
      });
      if (!created.id) return review('customer_create_failed', mode);
      customerId = created.id;
    } catch {
      return review('customer_create_failed', mode);
    }
    customerSource = 'created';
    signals = [];
  } else if (strongCandidates.length === 1) {
    customerId = strongCandidates[0].candidate.id;
    customerSource = 'existing';
    signals = strongCandidates[0].signals;
  } else {
    // A name-only candidate is never enough, and neither are two phone/email/address matches.
    return review('customer_ambiguous', mode);
  }

  let existingAddresses: HcpServiceAddress[];
  try {
    // This successful read is the guard against duplicate writes and default-address fallback.
    existingAddresses = await adapters.listAddresses(customerId);
  } catch {
    return review('address_lookup_failed', mode);
  }

  const existing = existingAddresses.find(candidateAddress => addressMatches(candidateAddress, address));
  if (existing) {
    return {
      kind: 'resolved',
      customerId,
      addressId: existing.id,
      normalizedAddress: address,
      metadata: { mode, customerSource, matchingSignals: signals },
    };
  }

  let numericCustomerId: string;
  try {
    numericCustomerId = await adapters.resolveNumericCustomerId(customerId);
    if (!numericCustomerId) return review('customer_id_lookup_failed', mode);
  } catch {
    return review('customer_id_lookup_failed', mode);
  }

  try {
    const addressId = await adapters.addCustomerAddress({ numericCustomerId, address });
    if (!addressId) return review('address_create_failed', mode);
    return {
      kind: 'resolved',
      customerId,
      addressId,
      normalizedAddress: address,
      metadata: { mode, customerSource, matchingSignals: signals },
    };
  } catch {
    return review('address_create_failed', mode);
  }
}
