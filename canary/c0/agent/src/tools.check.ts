import assert from 'node:assert/strict';
import { InMemoryC0Bridge } from './bridge.js';
import type { C0Bridge } from './bridge.js';
import { createCanaryTools, serviceRequestSchema } from './tools.js';
import { fakeSid } from './fake-fixtures.js';

const callSid = fakeSid('CA');
const bridge = new InMemoryC0Bridge();
const transfers: Array<{ sid: string; role: string }> = [];
const tools = createCanaryTools(bridge, callSid, '+15551230001', async (sid, role) => { transfers.push({ sid, role }); return { ok: true }; });
assert.equal(tools.length, 2);
assert.throws(() => serviceRequestSchema.parse({ name: '', callbackNumber: 'not-a-number', serviceAddress: '', scope: '', preferredWindows: '', callerConfirmed: false }));
const record = tools[0] as { execute(args: unknown, ctx: unknown): Promise<unknown> };
const transfer = tools[1] as { execute(args: unknown, ctx: unknown): Promise<unknown> };
assert.deepEqual(await record.execute({ name: 'Caller', callbackNumber: '+14695550123', serviceAddress: 'Street', scope: 'Light', preferredWindows: 'Morning', callerConfirmed: true }, {}), { status: 'recorded' });
assert.equal(bridge.requests.length, 1);
assert.deepEqual(await transfer.execute({ role: 'office' }, {}), { status: 'requested', transferred: true });
assert.deepEqual(transfers, [{ sid: callSid, role: 'office' }]);
const refusing: C0Bridge = {
  bind: () => ({ accepted: true }),
  record: async () => ({ accepted: true }),
  transferIntent: async () => ({ accepted: false }),
};
const transferOnRefusal: Array<{ sid: string; role: string }> = [];
const refusalTool = createCanaryTools(refusing, callSid, '+15551230001', async (sid, role) => { transferOnRefusal.push({ sid, role }); return { ok: true }; })[1] as { execute(args: unknown, ctx: unknown): Promise<unknown> };
assert.deepEqual(await refusalTool.execute({ role: 'backup' }, {}), { status: 'requested', transferred: true });
assert.deepEqual(transferOnRefusal, [{ sid: callSid, role: 'backup' }], 'a refused transfer intent still reaches the adapter');
console.log('tools.check OK');
