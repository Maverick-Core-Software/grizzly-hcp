/**
 * Preflight auth check for the HCP sync entry points.
 *
 * One cheap authenticated read through hcpGet. Never throws — a thrown error
 * becomes { ok: false, detail }. The route used (daemon vs cookies) is read
 * from the same HCP_VIA_MCP flag hcpGet routes on, so `via` reports the path
 * that was actually taken.
 *
 * ponytail: one request, no retries, no backoff. The preflight must add well
 * under a second to a healthy run; if the session is dead we want to know now,
 * not after three attempts. Upgrade path: add a short AbortController timeout
 * if a hung TCP connection is ever observed in practice.
 */
import { hcpGet } from "./client.js";

export type AuthVia = "daemon" | "cookies";

export interface PreflightAuthResult {
  ok: boolean;
  via: AuthVia;
  detail: string;
}

/**
 * Lightest authenticated read on the HCP allowlist — non-paginated, tiny
 * payload (a handful of industries). A dead session 401s here.
 */
const PROBE_PATH = "/alpha/pricebook/industries";

export async function checkHcpAuth(): Promise<PreflightAuthResult> {
  const via: AuthVia = process.env.HCP_VIA_MCP === "true" ? "daemon" : "cookies";
  try {
    await hcpGet<unknown>(PROBE_PATH);
    return { ok: true, via, detail: `authenticated via ${via} (GET ${PROBE_PATH})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, via, detail: message };
  }
}
