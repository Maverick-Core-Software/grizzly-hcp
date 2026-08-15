/**
 * US Census Bureau geocoder — free, no API key, US-only.
 * Turns a spoken street-and-city string into structured address fields.
 * Independent module: knows nothing about HCP, bookings, or the voice agent.
 *
 * Census returns ALL CAPS; we title-case street/city before returning so HCP
 * service addresses are not stored as "703 BUCKBOARD ST".
 */

import { normalizeState, titleCaseAddressPart } from "./contact-normalize.js";

export interface ResolvedAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
  latitude: number;
  longitude: number;
}

const GEOCODE_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export async function resolveAddress(
  freeText: string,
): Promise<ResolvedAddress | null> {
  if (!freeText || freeText.trim().length === 0) return null;

  try {
    const url = `${GEOCODE_URL}?address=${encodeURIComponent(freeText)}&benchmark=Public_AR_Current&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      result?: {
        addressMatches?: Array<{
          matchedAddress: string;
          coordinates: { x: number; y: number };
          addressComponents: {
            city?: string;
            state?: string;
            zip?: string;
          };
        }>;
      };
    };

    const match = data.result?.addressMatches?.[0];
    if (!match) return null;

    const rawStreet = (match.matchedAddress ?? "").split(",")[0]?.trim() ?? "";
    const rawCity = match.addressComponents?.city ?? "";
    const rawState = match.addressComponents?.state ?? "";
    const zip = (match.addressComponents?.zip ?? "").trim();

    return {
      street: titleCaseAddressPart(rawStreet),
      city: titleCaseAddressPart(rawCity),
      state: normalizeState(rawState),
      zip,
      latitude: match.coordinates.y,
      longitude: match.coordinates.x,
    };
  } catch {
    return null;
  }
}
