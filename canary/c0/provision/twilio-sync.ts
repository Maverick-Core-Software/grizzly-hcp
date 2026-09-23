import twilio from 'twilio';
import { assertApply, isApply, isEntryPoint, loadC0Env, mask, printSafe, required, safeFailureMessage, upsertC0EnvAtomically, writeEvidence, type Env } from './lib.js';

export const SYNC_SERVICE_NAME = 'grizzly-c0-canary';
export type SyncClient = { sync: { v1: { services: { list: () => Promise<Array<{ sid: string; friendlyName?: string; uniqueName?: string }>>; create: (input: { friendlyName: string; uniqueName: string }) => Promise<{ sid: string }> } } } };

export async function ensureSyncService(client: SyncClient, apply: boolean, writeEnv: (values: Record<string, string>) => Promise<void>) {
  const existing = (await client.sync.v1.services.list()).find((service) => service.uniqueName === SYNC_SERVICE_NAME || service.friendlyName === SYNC_SERVICE_NAME);
  if (!apply) return { dryRun: true, action: existing ? 'reuse' : 'create', serviceSid: existing ? mask(existing.sid) : null };
  const service = existing ?? await client.sync.v1.services.create({ friendlyName: SYNC_SERVICE_NAME, uniqueName: SYNC_SERVICE_NAME });
  await writeEnv({ VOICE_C0_SYNC_SERVICE_SID: service.sid });
  return { dryRun: false, action: existing ? 'reused' : 'created', serviceSid: mask(service.sid) };
}

async function main(env: Env): Promise<void> {
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const accountSid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID'); const authToken = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const result = await ensureSyncService(twilio(accountSid, authToken) as unknown as SyncClient, apply, upsertC0EnvAtomically);
  await writeEvidence('twilio-sync', result); printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'Twilio Sync provisioning')); process.exitCode = 1; });
