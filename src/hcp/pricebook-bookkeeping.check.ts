/**
 * Self-check for RAG-index recoverability. No test framework — run with:
 *   npx tsx src/hcp/pricebook-bookkeeping.check.ts
 *
 * Guards the footgun: when RAG indexing fails at item-creation time, the item's
 * uuid must NOT be silently lost — it must land in the pending-reindex queue and
 * be recoverable by drainReindexPending() once RAG is back.
 *
 * A tiny local HTTP server stands in for the RAG service so the check runs
 * offline: it first returns 500 (RAG "down"), then 200 (RAG "back").
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mutable RAG behaviour: 'fail' → 500, 'ok' → 200.
let mode: 'fail' | 'ok' = 'fail';
const server = http.createServer((req, res) => {
  // Drain the body so the socket closes cleanly, then answer per current mode.
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(mode === 'ok' ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

async function main() {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;

  // Point the RAG client at our stub and the pending queue at a temp file BEFORE
  // importing the modules (both capture these from env at load time).
  process.env.RAG_URL = `http://127.0.0.1:${port}`;
  const pendingPath = path.join(os.tmpdir(), `rag-reindex-pending.${process.pid}.jsonl`);
  process.env.RAG_REINDEX_PENDING_PATH = pendingPath;
  fs.rmSync(pendingPath, { force: true });

  const { indexOrQueuePricebookItem, drainReindexPending } = await import('./pricebook-bookkeeping.js');

  const item = {
    uuid: 'olit_check_123',
    name: 'Test Receptacle',
    description: 'A receptacle for the self-check',
    price: 42,
    category: 'Custom',
    unitOfMeasure: 'Each',
  };

  // 1. RAG down → indexing fails → item is queued, and the call itself never throws.
  mode = 'fail';
  await indexOrQueuePricebookItem(item); // must resolve, not reject
  assert.ok(fs.existsSync(pendingPath), 'pending queue file should be created on index failure');
  const queued = fs.readFileSync(pendingPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(queued.length, 1, 'exactly one item should be queued');
  assert.equal(queued[0].uuid, item.uuid, 'the failed item uuid must land in the pending queue');
  assert.equal(queued[0].name, item.name, 'queued entry carries the name');
  assert.equal(queued[0].price, item.price, 'queued entry carries the price');
  assert.equal(queued[0].category, item.category, 'queued entry carries the category');
  assert.equal(queued[0].unitOfMeasure, item.unitOfMeasure, 'queued entry carries the unit of measure');

  // 2. RAG still down → drain re-tries but keeps the item pending (nothing lost).
  mode = 'fail';
  const downResult = await drainReindexPending();
  assert.deepEqual(downResult, { drained: 0, remaining: 1 }, 'drain with RAG down keeps the item queued');
  assert.ok(fs.existsSync(pendingPath), 'pending queue survives a failed drain');

  // 3. RAG back → drain succeeds, item is removed, queue file is cleared away.
  mode = 'ok';
  const upResult = await drainReindexPending();
  assert.deepEqual(upResult, { drained: 1, remaining: 0 }, 'drain with RAG up recovers the queued item');
  assert.ok(!fs.existsSync(pendingPath), 'pending queue file is removed once fully drained');

  console.log('✓ pricebook-bookkeeping self-check passed — failed RAG index is queued and recoverable');
}

main()
  .catch(e => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
    fs.rmSync(process.env.RAG_REINDEX_PENDING_PATH!, { force: true });
  });
