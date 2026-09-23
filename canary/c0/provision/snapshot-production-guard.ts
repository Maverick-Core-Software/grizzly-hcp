import twilio from 'twilio';
import { isEntryPoint, loadC0Env, mask, parseFlag, printSafe, required, safeFailureMessage, sha256, writeEvidence, type Env } from './lib.js';

type GuardClient = { api: { v2010: { accounts: (sid: string) => { incomingPhoneNumbers: (sid: string) => { fetch: () => Promise<{ voiceUrl?: string; smsUrl?: string }> } } } } };

export async function snapshotProductionGuard(client: GuardClient, accountSid: string, productionNumberSid: string) {
  const number = await client.api.v2010.accounts(accountSid).incomingPhoneNumbers(productionNumberSid).fetch();
  return { production_number_sid: mask(productionNumberSid), voice_url_sha256: sha256(number.voiceUrl), sms_url_sha256: sha256(number.smsUrl) };
}

async function main(env: Env): Promise<void> {
  const productionNumberSid = parseFlag(process.argv, '--production-number-sid');
  if (!productionNumberSid) throw new Error('Usage: --production-number-sid <SID>');
  const accountSid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID');
  const authToken = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const result = await snapshotProductionGuard(twilio(accountSid, authToken) as unknown as GuardClient, accountSid, productionNumberSid);
  await writeEvidence('snapshot-production-guard', result);
  printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'production guard')); process.exitCode = 1; });
