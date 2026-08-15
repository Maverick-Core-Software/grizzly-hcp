/**
 * Shared contact/address normalization for voice + SMS HCP writes.
 * Pure helpers only — no network, no HCP I/O.
 */

/** US-centric phone normalize for HCP customer create (mobile_number wants 10 digits). */
export function normalizeUsPhone(value?: string | null): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  // Non-US E.164: keep full digit string if long enough to be a real phone
  if (digits.length >= 8 && digits.length <= 15) return digits;
  return undefined;
}

/**
 * Title-case a street or city segment. Census geocoder returns ALL CAPS;
 * HCP looks better with normal casing. Directional abbreviations stay upper.
 */
export function titleCaseAddressPart(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      if (/^(nw|ne|se|sw)$/i.test(tok)) return tok.toUpperCase();
      // Keep pure number tokens (house numbers, unit digits) as-is
      if (/^\d+[a-z]?$/i.test(tok)) return tok;
      // Alphanumeric like 35th → 35th
      if (/^\d/.test(tok)) return tok;
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join(' ');
}

/** State stays 2-letter upper when possible. */
export function normalizeState(value: string): string {
  const t = value.trim();
  if (t.length === 2) return t.toUpperCase();
  return titleCaseAddressPart(t);
}

export function formatDisplayAddress(parts: {
  street: string;
  city: string;
  state: string;
  zip: string;
  streetLine2?: string;
}): string {
  const line1 = parts.streetLine2
    ? `${parts.street}, ${parts.streetLine2}`
    : parts.street;
  return `${line1}, ${parts.city}, ${parts.state} ${parts.zip}`.replace(/\s+/g, ' ').trim();
}
