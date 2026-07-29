/**
 * US Census Bureau geocoder — free, no API key, US-only.
 * Turns a spoken street-and-city string into structured address fields.
 * Independent module: knows nothing about HCP, bookings, or the voice agent.
 */

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

    const street = (match.matchedAddress ?? "").split(",")[0]?.trim() ?? "";

    return {
      street,
      city: match.addressComponents?.city ?? "",
      state: match.addressComponents?.state ?? "",
      zip: match.addressComponents?.zip ?? "",
      latitude: match.coordinates.y,
      longitude: match.coordinates.x,
    };
  } catch {
    return null;
  }
}
