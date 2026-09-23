import twilio from 'twilio';
import { assertApply, isApply, isEntryPoint, loadC0Env, mask, printSafe, required, safeFailureMessage, upsertC0EnvAtomically, writeEvidence, type Env } from './lib.js';

type KeyClient = { api: { v2010: { accounts: (sid: string) => { newKeys: { create: (input: { friendlyName: string }) => Promise<{ sid: string; secret: string }> } } } } };

export const CALLS_READ_UPDATE_POLICY = (accountSid: string) => ({ allow: [
  { url: `/2010-04-01/Accounts/${accountSid}/Calls`, methods: ['GET'] },
  { url: `/2010-04-01/Accounts/${accountSid}/Calls/**`, methods: ['GET', 'POST'] },
] });

export async function createRestrictedKeys(client: KeyClient, accountSid: string, apply: boolean, writeEnv: (values: Record<string, string>) => Promise<void>) {
  if (!apply) return { dryRun: true, keyType: 'standard', created: [] as string[], deviation: 'Sync Documents restricted-key permission paths are not confirmed by Twilio published permissions.' };
  // Twilio's published restricted-key product list does not confirm Sync
  // Document permission paths.  The approved fallback is a Standard key made
  // inside the canary subaccount; it cannot access a parent or sibling account.
  const key = await client.api.v2010.accounts(accountSid).newKeys.create({ friendlyName: 'grizzly-c0-runtime-standard-sync-fallback' });
  await writeEnv({ VOICE_C0_TWILIO_API_KEY_SID: key.sid, VOICE_C0_TWILIO_API_KEY_SECRET: key.secret });
  return { dryRun: false, keyType: 'standard', created: [mask(key.sid)], deviation: 'Sync Documents restricted-key permission paths are not confirmed by Twilio published permissions.' };
}

async function main(env: Env): Promise<void> {
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const accountSid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID');
  const authToken = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const result = await createRestrictedKeys(twilio(accountSid, authToken) as unknown as KeyClient, accountSid, apply, upsertC0EnvAtomically);
  await writeEvidence('twilio-restricted-keys', result);
  printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'restricted key creation')); process.exitCode = 1; });
