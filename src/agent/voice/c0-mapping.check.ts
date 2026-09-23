import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { C0MappingStore } from './c0-mapping.js';

const PARENT = `CA${'a'.repeat(32)}`;
const CHILD = `CA${'b'.repeat(32)}`;

function binding(overrides: Record<string, unknown> = {}) {
  return {
    parentCallSid: PARENT,
    childCallSid: CHILD,
    trunkId: 'trunk-c0',
    ruleId: 'rule-c0',
    roomName: 'c0-room',
    participantIdentity: 'participant-c0',
    sipCallIdFull: 'sip-call-id-full',
    ...overrides,
  };
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'voice-c0-mapping-'));
  try {
    const file = join(dir, 'mapping.jsonl');
    const store = new C0MappingStore({ path: file });
    assert.deepEqual(store.bind(binding()), {
      ok: true,
      mapping: { ...binding(), terminal: null },
    });
    const firstBody = readFileSync(file, 'utf-8');
    assert.deepEqual(store.bind(binding()), { ok: true, mapping: { ...binding(), terminal: null } });
    assert.equal(readFileSync(file, 'utf-8'), firstBody, 'identical rebind is idempotent and append-free');
    assert.deepEqual(store.get(PARENT), { ...binding(), terminal: null });

    // Mutation-style negative control: a changed binding must fail closed.
    assert.deepEqual(store.bind(binding({ roomName: 'mutated-room' })), {
      ok: false, reason: 'mapping_conflict',
    });
    assert.deepEqual(store.bind(binding({ trunkId: 'other-trunk' })), {
      ok: false, reason: 'mapping_conflict',
    });
    assert.deepEqual(store.bind(binding({ parentCallSid: 'CAUPPERCASE' })), {
      ok: false, reason: 'mapping_invalid',
    });
    assert.deepEqual(store.bind(binding({ ruleId: '' })), { ok: false, reason: 'mapping_incomplete' });

    assert.deepEqual(store.markTerminal(PARENT, 'transferred'), { ...binding(), terminal: 'transferred' });
    assert.deepEqual(store.markTerminal(PARENT, 'transferred'), { ...binding(), terminal: 'transferred' });
    assert.equal(store.markTerminal(PARENT, 'failed'), null, 'terminal state is immutable');
    assert.equal(store.markTerminal(`CA${'c'.repeat(32)}`, 'ended'), null, 'unknown parent is not created');

    const snapshot = store.snapshot();
    assert.equal(snapshot.redacted, true);
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.terminalCounts.transferred, 1);
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(PARENT));
    assert.ok(!serialized.includes(CHILD));
    assert.ok(!serialized.includes('sip-call-id-full'));
    assert.equal(readFileSync(file, 'utf-8').trim().split('\n').length, 2, 'bind + terminal are append-only events');

    // A missing file is the sole empty-store condition.
    const absent = new C0MappingStore({ path: join(dir, 'absent.jsonl') });
    assert.equal(absent.bind(binding()).ok, true, 'ENOENT admits the initial durable bind');

    // A malformed first event is unavailable, not an empty mapping history.
    const corruptFirstFile = join(dir, 'corrupt-first.jsonl');
    writeFileSync(corruptFirstFile, 'not valid json\n', 'utf-8');
    const corruptFirst = new C0MappingStore({ path: corruptFirstFile });
    const corruptFirstBody = readFileSync(corruptFirstFile, 'utf-8');
    assert.deepEqual(corruptFirst.bind(binding()), { ok: false, reason: 'mapping_unavailable' });
    assert.deepEqual(corruptFirst.get(PARENT), { ok: false, reason: 'mapping_unavailable' });
    assert.deepEqual(corruptFirst.markTerminal(PARENT, 'ended'), { ok: false, reason: 'mapping_unavailable' });
    assert.equal(readFileSync(corruptFirstFile, 'utf-8'), corruptFirstBody, 'unavailable history is never appended');

    // A malformed event between valid events invalidates the complete history.
    const corruptMiddleFile = join(dir, 'corrupt-middle.jsonl');
    const middleWriter = new C0MappingStore({ path: corruptMiddleFile });
    assert.equal(middleWriter.bind(binding()).ok, true);
    assert.deepEqual(middleWriter.markTerminal(PARENT, 'ended'), { ...binding(), terminal: 'ended' });
    const [bindLine, terminalLine] = readFileSync(corruptMiddleFile, 'utf-8').trim().split('\n');
    writeFileSync(corruptMiddleFile, `${bindLine}\nnot valid json\n${terminalLine}\n`, 'utf-8');
    const corruptMiddle = new C0MappingStore({ path: corruptMiddleFile });
    assert.deepEqual(corruptMiddle.get(PARENT), { ok: false, reason: 'mapping_unavailable' });
    assert.deepEqual(corruptMiddle.bind(binding()), { ok: false, reason: 'mapping_unavailable' });

    // Read errors other than ENOENT close every mapping action and cannot append.
    const unreadableError = new Error('permission denied') as NodeJS.ErrnoException;
    unreadableError.code = 'EACCES';
    const unreadable = new C0MappingStore({
      path: join(dir, 'unreadable.jsonl'),
      filesystem: {
        readFileSync: () => { throw unreadableError; },
        mkdirSync: () => undefined,
        appendFileSync: () => { throw new Error('must not append unavailable mapping'); },
      } as unknown as typeof import('node:fs'),
    });
    assert.deepEqual(unreadable.bind(binding()), { ok: false, reason: 'mapping_unavailable' });
    assert.deepEqual(unreadable.get(PARENT), { ok: false, reason: 'mapping_unavailable' });
    assert.deepEqual(unreadable.markTerminal(PARENT, 'ended'), { ok: false, reason: 'mapping_unavailable' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('c0-mapping.check OK');
}

main();
