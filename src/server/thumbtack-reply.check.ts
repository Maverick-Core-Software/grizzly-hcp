import assert from 'node:assert/strict';
import { createThumbtackReplyHandler, isLoopbackAddress } from './thumbtack-reply.js';

{
  const handle = createThumbtackReplyHandler(async prompt => {
    assert.match(prompt, /Alex/);
    assert.match(prompt, /EV charger/);
    return { text: 'Hi Alex — is this a new EV charger circuit?' };
  });
  const result = await handle({
    customerName: 'Alex R',
    category: 'Electrician',
    text: 'Need a 50 amp EV charger',
    history: [],
  });
  assert.deepEqual(result, { success: true, reply: 'Hi Alex — is this a new EV charger circuit?' });
}

{
  const handle = createThumbtackReplyHandler(async () => ({ text: '  ' }));
  const result = await handle({ text: 'hello' });
  assert.equal(result.success, false);
}

{
  const handle = createThumbtackReplyHandler(async () => { throw new Error('down'); });
  const result = await handle({ text: 'hello' });
  assert.equal(result.error, 'Agent unavailable.');
}

assert.equal(isLoopbackAddress('127.0.0.1'), true);
assert.equal(isLoopbackAddress('::1'), true);
assert.equal(isLoopbackAddress('8.8.8.8'), false);
console.log('ok thumbtack-reply');
