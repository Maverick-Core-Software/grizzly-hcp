import assert from 'node:assert/strict';
import { fallbackUrl, redirectToFallback, transferWithSync } from './transfer.js';
import { fakeSid } from './fake-fixtures.js';

const callSid = fakeSid('CA');
const calls: Array<{ sid: string; url: string }> = [];
const client = { calls: (sid: string) => ({ update: async ({ url }: { url: string }) => { calls.push({ sid, url }); } }) };

assert.equal(fallbackUrl('https://fallback.example/path?ignored=yes', 'office'), 'https://fallback.example/path?ignored=yes&role=office');
assert.deepEqual(await redirectToFallback(client, callSid, 'backup', 'https://fallback.example/path'), { ok: true, role: 'backup' });
assert.equal(calls.length, 1);
assert.equal(calls[0].sid, callSid);
assert.equal(calls[0].url, 'https://fallback.example/path?role=backup');
assert.deepEqual(await redirectToFallback(client, undefined, 'office', 'https://fallback.example/path'), { ok: false, role: 'office', reason: 'invalid_call_sid' });
assert.equal(calls.length, 1);
const order: string[] = [];
const sync = { create: async (value: { uniqueName: string; data: unknown; ttl: number }) => { order.push(`sync:${value.uniqueName}`); assert.deepEqual(value.data, { role: 'office', by: 'agent' }); assert.equal(value.ttl, 900); } };
const end = { endAiLeg: async () => { order.push('end'); } };
assert.deepEqual(await transferWithSync(sync, client, end, callSid, 'office', 'https://fallback.example/path'), { ok: true, role: 'office' });
assert.deepEqual(order, [`sync:c0-transfer-${callSid}`, 'end'], 'Sync flag is durable before the room is ended');
const failingSync = { create: async () => { throw new Error('offline'); } };
assert.deepEqual(await transferWithSync(failingSync, client, end, callSid, 'backup', 'https://fallback.example/path'), { ok: true, role: 'backup' });
assert.equal(calls.at(-1)?.url, 'https://fallback.example/path?role=backup', 'Sync failure falls back to a parent redirect');
console.log('transfer.check OK');
