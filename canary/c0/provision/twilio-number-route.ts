import twilio from 'twilio';
import { assertCanaryRouteTarget, assertOnlyVoiceUrlChanged, assertApply, isApply, isEntryPoint, loadC0Env, parseFlag, printSafe, required, routeSnapshot, safeFailureMessage, writeEvidence, type Env, type TwilioNumber } from './lib.js';

type RouteClient = { api: { v2010: { accounts: (sid: string) => { incomingPhoneNumbers: (sid: string) => { fetch: () => Promise<TwilioNumber>; update: (input: { voiceUrl: string; voiceMethod: 'POST' }) => Promise<TwilioNumber> } } } } };

export async function routeCanaryNumber(client: RouteClient, accountSid: string, numberSid: string, canaryDid: string, targetUrl: string, apply: boolean) {
  const number = client.api.v2010.accounts(accountSid).incomingPhoneNumbers(numberSid);
  const beforeNumber = await number.fetch();
  assertCanaryRouteTarget(beforeNumber, canaryDid);
  const before = routeSnapshot(beforeNumber);
  if (!apply) return { dryRun: true, before, requestedVoiceUrl: targetUrl };
  const afterNumber = await number.update({ voiceUrl: targetUrl, voiceMethod: 'POST' });
  const after = routeSnapshot(afterNumber);
  assertOnlyVoiceUrlChanged(before, after);
  return { dryRun: false, before, after };
}

function targetUrl(env: Env, to: string | undefined): string {
  if (to === 'fallback') return required(env, 'VOICE_C0_FALLBACK_URL');
  if (to === 'ingress') return required(env, 'VOICE_C0_INGRESS_URL');
  throw new Error('Usage: --to fallback|ingress');
}

async function main(env: Env): Promise<void> {
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const accountSid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID');
  const authToken = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const did = required(env, 'VOICE_C0_CANARY_DID');
  const numberSid = required(env, 'VOICE_C0_CANARY_NUMBER_SID');
  const result = await routeCanaryNumber(twilio(accountSid, authToken) as unknown as RouteClient, accountSid, numberSid, did, targetUrl(env, parseFlag(process.argv, '--to')), apply);
  await writeEvidence('twilio-number-route', result);
  printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'number route')); process.exitCode = 1; });
