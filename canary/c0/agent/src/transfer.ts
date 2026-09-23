import twilio from 'twilio';
import type { CanaryRuntimeConfig } from './config.js';

export type TransferRole = 'office' | 'backup';
export type TransferOutcome =
  | { readonly ok: true; readonly role: TransferRole }
  | { readonly ok: false; readonly role: TransferRole; readonly reason: 'invalid_call_sid' | 'fallback_url_missing' | 'update_failed' };

export interface CallRedirectClient {
  calls(callSid: string): { update(options: { url: string }): Promise<unknown> };
}

export interface SyncDocumentClient {
  create(options: { uniqueName: string; data: Record<string, unknown>; ttl: number }): Promise<unknown>;
  remove?(uniqueName: string): Promise<unknown>;
}

/** Positive admission is written only after every pre-session gate succeeds. */
export async function writeAdmission(sync: SyncDocumentClient, parentCallSid: string, admittedAt: string): Promise<void> {
  if (!CALL_SID_RE.test(parentCallSid)) throw new Error('invalid_call_sid');
  await sync.create({ uniqueName: `c0-admitted-${parentCallSid}`, data: { admittedAt, by: 'agent' }, ttl: 900 });
}

export async function clearAdmission(sync: SyncDocumentClient, parentCallSid: string): Promise<void> {
  if (CALL_SID_RE.test(parentCallSid)) await sync.remove?.(`c0-admitted-${parentCallSid}`);
}

export interface C0TransferLifecycle {
  endAiLeg(): Promise<void>;
}

const CALL_SID_RE = /^CA[0-9a-f]{32}$/;

export function fallbackUrl(base: string | undefined, role: TransferRole): string | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set('role', role);
    return url.toString();
  } catch {
    return null;
  }
}

export async function redirectToFallback(
  client: CallRedirectClient,
  parentCallSid: string | undefined,
  role: TransferRole,
  baseFallbackUrl: string | undefined,
): Promise<TransferOutcome> {
  if (!parentCallSid || !CALL_SID_RE.test(parentCallSid)) return { ok: false, role, reason: 'invalid_call_sid' };
  const url = fallbackUrl(baseFallbackUrl, role);
  if (!url) return { ok: false, role, reason: 'fallback_url_missing' };
  try {
    await client.calls(parentCallSid).update({ url });
    return { ok: true, role };
  } catch {
    return { ok: false, role, reason: 'update_failed' };
  }
}

export function createTwilioTransferAdapter(config: Pick<CanaryRuntimeConfig, 'twilioAccountSid' | 'twilioApiKeySid' | 'twilioApiKeySecret' | 'fallbackUrl'>): (callSid: string | undefined, role: TransferRole) => Promise<TransferOutcome> {
  const client = createTwilioCallClient(config);
  return (callSid, role) => redirectToFallback(client, callSid, role, config.fallbackUrl);
}

export function createTwilioCallClient(config: Pick<CanaryRuntimeConfig, 'twilioAccountSid' | 'twilioApiKeySid' | 'twilioApiKeySecret'>): CallRedirectClient & { calls(callSid: string): { update(options: { url: string }): Promise<unknown>; fetch(): Promise<{ from?: string | null }> } } {
  return twilio(config.twilioApiKeySid, config.twilioApiKeySecret, { accountSid: config.twilioAccountSid });
}

/** Writes the Function-visible Sync flag before ending the SIP/AI leg. */
export async function transferWithSync(
  sync: SyncDocumentClient,
  fallbackClient: CallRedirectClient,
  lifecycle: C0TransferLifecycle,
  parentCallSid: string | undefined,
  role: TransferRole,
  baseFallbackUrl: string | undefined,
): Promise<TransferOutcome> {
  if (!parentCallSid || !CALL_SID_RE.test(parentCallSid)) return { ok: false, role, reason: 'invalid_call_sid' };
  try {
    await sync.create({ uniqueName: `c0-transfer-${parentCallSid}`, data: { role, by: 'agent' }, ttl: 900 });
    await lifecycle.endAiLeg();
    return { ok: true, role };
  } catch {
    return redirectToFallback(fallbackClient, parentCallSid, role, baseFallbackUrl);
  }
}

export function createSyncDocumentClient(config: Pick<CanaryRuntimeConfig, 'twilioAccountSid' | 'twilioApiKeySid' | 'twilioApiKeySecret' | 'syncServiceSid'>): SyncDocumentClient {
  const client = twilio(config.twilioApiKeySid, config.twilioApiKeySecret, { accountSid: config.twilioAccountSid });
  const documents = client.sync.v1.services(config.syncServiceSid).documents;
  return { create: (options) => documents.create(options), remove: (uniqueName) => documents(uniqueName).remove() };
}
