import twilio from 'twilio';
import { isEntryPoint, loadC0Env, parseFlag, printSafe, required, safeFailureMessage, writeEvidence, type Env } from './lib.js';

type AuthorityClient = { request: (request: { method: string; uri: string }) => Promise<{ statusCode: number }>; api: { v2010: { accounts: (sid: string) => { incomingPhoneNumbers: { list: (options?: object) => Promise<any[]> } } } } };

type ParentProbe = PromiseSettledResult<{ statusCode: number }>;

export function probeStatus(result: ParentProbe): number | null {
  if (result.status === 'fulfilled') return Number.isInteger(result.value.statusCode) ? result.value.statusCode : null;
  const reason = result.reason as { status?: unknown; statusCode?: unknown } | undefined;
  const candidate = reason?.statusCode ?? reason?.status;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : null;
}

export function isProvenNonSuccess(result: ParentProbe): boolean {
  const status = probeStatus(result);
  return status !== null && (status < 200 || status >= 300);
}

export async function negativeAuthority(client: AuthorityClient, subaccountSid: string, parentSid: string) {
  const [parentAccount, parentNumbers, ownNumbers] = await Promise.allSettled([
    Promise.resolve().then(() => client.request({ method: 'GET', uri: `https://api.twilio.com/2010-04-01/Accounts/${parentSid}.json` })),
    Promise.resolve().then(() => client.request({ method: 'GET', uri: `https://api.twilio.com/2010-04-01/Accounts/${parentSid}/IncomingPhoneNumbers.json` })),
    Promise.resolve().then(() => client.api.v2010.accounts(subaccountSid).incomingPhoneNumbers.list({ limit: 1 })),
  ]);
  const parentAccountStatus = probeStatus(parentAccount);
  const parentNumbersStatus = probeStatus(parentNumbers);
  const parentAccountDenied = isProvenNonSuccess(parentAccount);
  const parentNumbersDenied = isProvenNonSuccess(parentNumbers);
  const pass = parentAccountDenied && parentNumbersDenied && ownNumbers.status === 'fulfilled';
  const inconclusiveReasons = [
    ...(parentAccountDenied ? [] : ['parent-account-probe-inconclusive']),
    ...(parentNumbersDenied ? [] : ['parent-number-list-probe-inconclusive']),
    ...(ownNumbers.status === 'fulfilled' ? [] : ['subaccount-positive-control-inconclusive']),
  ];
  return { pass, parentAccountDenied, parentNumbersDenied, parentAccountStatus, parentNumbersStatus, ownSubaccountPositiveControl: ownNumbers.status === 'fulfilled', inconclusiveReasons };
}

async function main(env: Env): Promise<void> {
  const parentSid = parseFlag(process.argv, '--parent-sid');
  if (!parentSid) throw new Error('Usage: --parent-sid <parent account SID>');
  const sid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID');
  const token = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const result = await negativeAuthority(twilio(sid, token) as unknown as AuthorityClient, sid, parentSid);
  await writeEvidence('twilio-negative-authority', result);
  printSafe({ pass: result.pass });
  if (!result.pass) process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'authority check')); process.exitCode = 1; });
