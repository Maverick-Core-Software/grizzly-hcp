import twilio from 'twilio';
import { assertApply, isApply, isEntryPoint, loadC0Env, mask, maskPhone, parseFlag, printSafe, required, safeFailureMessage, upsertC0EnvAtomically, writeEvidence, type Env } from './lib.js';

export type CanaryNumber = { sid: string; phoneNumber: string; trunkSid?: string | null; voiceApplicationSid?: string | null };
export type NumberSelectionClient = { incomingPhoneNumbers: { list: (input: { phoneNumber: string; limit: number }) => Promise<CanaryNumber[]> } };

function assertE164(value: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error('Usage: --did <E164>');
  return value;
}

export async function selectCanaryNumber(client: NumberSelectionClient, did: string, apply: boolean, writeEnv: (values: Record<string, string>) => Promise<void>, productionSid?: string) {
  const requested = assertE164(did);
  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: requested, limit: 20 });
  const selected = numbers.find((number) => number.phoneNumber === requested);
  if (!selected) throw new Error('Canary number was not found in the configured subaccount');
  if (selected.trunkSid) throw new Error('Refusing trunk-attached canary number');
  if (selected.voiceApplicationSid) throw new Error('Refusing application-attached canary number');
  if (productionSid && selected.sid === productionSid) throw new Error('Refusing production number as canary');
  const values = { VOICE_C0_CANARY_DID: selected.phoneNumber, VOICE_C0_CANARY_NUMBER_SID: selected.sid };
  if (apply) await writeEnv(values);
  return { dryRun: !apply, canaryDid: maskPhone(selected.phoneNumber), numberSid: mask(selected.sid), written: apply ? Object.keys(values).sort() : [] };
}

async function main(env: Env): Promise<void> {
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const did = parseFlag(process.argv, '--did'); if (!did) throw new Error('Usage: --did <E164> [--production-sid <SID>] [--apply]');
  const accountSid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID'); const authToken = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const result = await selectCanaryNumber(twilio(accountSid, authToken) as unknown as NumberSelectionClient, did, apply, upsertC0EnvAtomically, parseFlag(process.argv, '--production-sid'));
  await writeEvidence('select-canary-number', result); printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'canary number selection')); process.exitCode = 1; });
