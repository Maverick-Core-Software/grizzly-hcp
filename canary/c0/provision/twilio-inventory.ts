import twilio from 'twilio';
import { isEntryPoint, loadC0Env, mask, maskPhone, printSafe, required, safeFailureMessage, writeEvidence, type Env } from './lib.js';

export type TwilioInventoryClient = {
  api: { v2010: { accounts: (sid: string) => { fetch: () => Promise<any>; incomingPhoneNumbers: { list: () => Promise<any[]> } } } };
  serverless: { v1: { services: { list: () => Promise<any[]> } } };
};

export async function inventory(client: TwilioInventoryClient, accountSid: string) {
  const account = client.api.v2010.accounts(accountSid);
  const [identity, numbers, services] = await Promise.all([account.fetch(), account.incomingPhoneNumbers.list(), client.serverless.v1.services.list()]);
  const listedNumbers = numbers.map((number) => ({
    sid: mask(number.sid), phone_number: maskPhone(number.phoneNumber), voice_url: number.voiceUrl ?? null,
    voice_application_sid: mask(number.voiceApplicationSid), trunk_sid: mask(number.trunkSid), sms_url: number.smsUrl ?? null,
    sms_application_sid: mask(number.smsApplicationSid), unsafe_voice_attachment: Boolean(number.trunkSid || number.voiceApplicationSid),
  }));
  return { subaccount: { sid: mask(identity.sid), friendly_name: identity.friendlyName ?? null, status: identity.status ?? null }, numbers: listedNumbers, serverless_services: services.map((service) => ({ sid: mask(service.sid), friendly_name: service.friendlyName ?? null })), unsafe_numbers: listedNumbers.filter((number) => number.unsafe_voice_attachment).map((number) => number.sid) };
}

async function main(env: Env): Promise<void> {
  const accountSid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID');
  const authToken = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const result = await inventory(twilio(accountSid, authToken) as unknown as TwilioInventoryClient, accountSid);
  await writeEvidence('twilio-inventory', result);
  printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'inventory')); process.exitCode = 1; });
