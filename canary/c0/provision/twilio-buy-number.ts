import twilio from 'twilio';
import { assertApply, isApply, isEntryPoint, loadC0Env, mask, parseFlag, printSafe, required, safeFailureMessage, upsertC0EnvAtomically, writeEvidence, type Env } from './lib.js';

type BuyClient = { availablePhoneNumbers: (country: string) => { local: { list: (input: { voiceEnabled: boolean; phoneNumber: string; limit: number }) => Promise<Array<{ phoneNumber: string }>> } }; incomingPhoneNumbers: { create: (input: { phoneNumber: string }) => Promise<{ sid: string; phoneNumber: string }> } };

export async function buyCanaryNumber(client: BuyClient, e164: string, apply: boolean, writeEnv: (values: Record<string, string>) => Promise<void> = async () => {}) {
  if (!apply) return { dryRun: true, requested: mask(e164) };
  const candidates = await client.availablePhoneNumbers('US').local.list({ voiceEnabled: true, phoneNumber: e164, limit: 1 });
  const candidate = candidates.find((item) => item.phoneNumber === e164);
  if (!candidate) throw new Error('Requested voice number is not currently available');
  const purchased = await client.incomingPhoneNumbers.create({ phoneNumber: e164 });
  if (purchased.phoneNumber !== e164) throw new Error('Purchased number did not match --confirm-purchase value');
  await writeEnv({ VOICE_C0_CANARY_DID: purchased.phoneNumber, VOICE_C0_CANARY_NUMBER_SID: purchased.sid });
  return { dryRun: false, sid: mask(purchased.sid), phoneNumber: mask(purchased.phoneNumber) };
}

async function main(env: Env): Promise<void> {
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const confirmed = parseFlag(process.argv, '--confirm-purchase');
  if (!confirmed) throw new Error('Refusing purchase without --confirm-purchase <E164>');
  const accountSid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID');
  const authToken = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const result = await buyCanaryNumber(twilio(accountSid, authToken) as unknown as BuyClient, confirmed, apply, upsertC0EnvAtomically);
  await writeEvidence('twilio-buy-number', result);
  printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'number purchase')); process.exitCode = 1; });
