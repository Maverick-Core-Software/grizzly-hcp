import assert from 'node:assert/strict';
import { negativeAuthority } from './twilio-negative-authority.js';

function clientFor(parentAccount: () => Promise<{ statusCode: number }>, parentNumbers: () => Promise<{ statusCode: number }>) {
  const uris: string[] = [];
  return {
    request: async ({ uri }: { uri: string }) => { uris.push(uri); return uri.endsWith('/IncomingPhoneNumbers.json') ? parentNumbers() : parentAccount(); },
    api: { v2010: { accounts: () => ({ incomingPhoneNumbers: { list: async () => [] } }) } },
    uris,
  };
}

async function run(): Promise<void> {
  const fake = clientFor(async () => ({ statusCode: 401 }), async () => ({ statusCode: 403 }));
  const denied = await negativeAuthority(fake, 'ACsubaccount', 'ACparent');
  assert.equal(denied.pass, true); assert.equal(denied.parentAccountStatus, 401); assert.equal(denied.parentNumbersStatus, 403);
  assert.deepEqual(fake.uris, ['https://api.twilio.com/2010-04-01/Accounts/ACparent.json', 'https://api.twilio.com/2010-04-01/Accounts/ACparent/IncomingPhoneNumbers.json']);
  const notFound = await negativeAuthority(clientFor(async () => ({ statusCode: 404 }), async () => ({ statusCode: 401 })), 'ACsubaccount', 'ACparent');
  assert.equal(notFound.pass, true, 'any observed parent non-2xx response proves the negative boundary');
  const inconclusive = await negativeAuthority(clientFor(async () => { throw new Error('transport failure'); }, async () => ({ statusCode: 403 })), 'ACsubaccount', 'ACparent');
  assert.equal(inconclusive.pass, false); assert.equal(inconclusive.parentAccountStatus, null, 'generic rejections are inconclusive rather than denials'); assert.deepEqual(inconclusive.inconclusiveReasons, ['parent-account-probe-inconclusive']);
  const restException = await negativeAuthority(clientFor(async () => { throw { status: 401 }; }, async () => ({ statusCode: 403 })), 'ACsubaccount', 'ACparent');
  assert.equal(restException.pass, true, 'Twilio RestException status values prove denial');
  console.log('twilio-negative-authority.check OK');
}

void run();
