import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Outbox } from '../../../src/agent/voice/outbox.js';
import { createCanaryOutboxMonitor, createNodeMonitorAlertState } from './index.js';
import { fakeSid } from './fake-fixtures.js';

function hash(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c0-monitor-'));
  const outboxPath = path.join(root, 'voice-outbox.jsonl');
  const now = new Date('2026-09-22T15:00:00.000Z');
  try {
    const outbox = new Outbox({ path: outboxPath, now: () => new Date(now.getTime() - 600_000) });
    outbox.append({
      idempotencyKey: 'monitor-crossing-1', callSid: fakeSid('CA'), kind: 'note', payload: { caller: '+15555550100' },
    });
    const before = hash(outboxPath);
    const alerts: Array<{ input: string; body: string }> = [];
    const alertState = createNodeMonitorAlertState(root);
    const monitor = createCanaryOutboxMonitor(
      { enabled: true, staleAfterMs: 300_000, ntfyTopic: 'c0-test' },
      {
        listRecords: () => outbox.list(), now: () => now,
        fetchImpl: async (input, init) => { alerts.push({ input, body: init.body }); return {}; }, log: () => {}, alertState,
      },
    );

    assert.equal((await monitor.tick()).alerted, 1, 'the first stale crossing alerts once');
    assert.equal((await monitor.tick()).alerted, 0, 'the same crossing is silent on the next tick');
    assert.equal(alerts.length, 1);
    assert.ok(!alerts[0].body.includes('5555550100'), 'alert body is redacted');
    assert.equal(hash(outboxPath), before, 'monitor does not write the outbox file');

    const afterRestart = createCanaryOutboxMonitor(
      { enabled: true, staleAfterMs: 300_000, ntfyTopic: 'c0-test' },
      { listRecords: () => outbox.list(), now: () => now, fetchImpl: async (input, init) => { alerts.push({ input, body: init.body }); return {}; }, log: () => {}, alertState: createNodeMonitorAlertState(root) },
    );
    assert.equal((await afterRestart.tick()).alerted, 0, 'persisted crossing state prevents a restart re-alert');
    assert.equal(alerts.length, 1);
    assert.ok(!fs.readFileSync(alertState.filePath, 'utf8').includes('5555550100'), 'crossing state contains no caller number');

    const persistedCrossing = { id: outbox.list()[0].id, tier: 'stale' as const };
    const corruptState = createNodeMonitorAlertState(path.join(root, 'corrupt-state'));
    fs.mkdirSync(path.dirname(corruptState.filePath), { recursive: true });
    fs.writeFileSync(corruptState.filePath, `${JSON.stringify(persistedCrossing)}\nnot-json\n`, { encoding: 'utf8', mode: 0o600 });
    const corruptAlerts: string[] = [];
    const corruptLogs: string[] = [];
    const corruptMonitor = createCanaryOutboxMonitor(
      { enabled: true, staleAfterMs: 300_000, ntfyTopic: 'c0-test' },
      {
        listRecords: () => outbox.list(), now: () => now,
        fetchImpl: async (_input, init) => { corruptAlerts.push(init.body); return {}; }, log: (line) => { corruptLogs.push(line); }, alertState: corruptState,
      },
    );
    assert.equal((await corruptMonitor.tick()).alerted, 1, 'a mixed valid/corrupt state file is discarded and re-alerts');
    assert.equal(corruptAlerts.length, 1);
    assert.equal(corruptLogs.filter((line) => line.includes('discarded unavailable')).length, 1, 'the redacted state warning logs once');
    assert.equal(fs.readFileSync(corruptState.filePath, 'utf8').trim(), JSON.stringify(persistedCrossing), 'the normal save path rewrites a clean state file');

    const unreadableState = createNodeMonitorAlertState(path.join(root, 'unreadable-state'));
    fs.mkdirSync(unreadableState.filePath, { recursive: true });
    const unreadableAlerts: string[] = [];
    const unreadableLogs: string[] = [];
    const unreadableMonitor = createCanaryOutboxMonitor(
      { enabled: true, staleAfterMs: 300_000, ntfyTopic: 'c0-test' },
      {
        listRecords: () => outbox.list(), now: () => now,
        fetchImpl: async (_input, init) => { unreadableAlerts.push(init.body); return {}; }, log: (line) => { unreadableLogs.push(line); }, alertState: unreadableState,
      },
    );
    assert.equal((await unreadableMonitor.tick()).alerted, 1, 'a non-ENOENT unreadable state path re-alerts');
    assert.equal(unreadableAlerts.length, 1);
    assert.equal(unreadableLogs.filter((line) => line.includes('discarded unavailable')).length, 1, 'the unreadable-state warning logs once');

    let healthRecords: ReturnType<Outbox['list']> = [];
    const humanAlerts: string[] = [];
    const human = createCanaryOutboxMonitor(
      { enabled: true, staleAfterMs: 300_000, ntfyTopic: 'c0-test' },
      { listRecords: () => healthRecords, now: () => now, fetchImpl: async (_input, init) => { humanAlerts.push(init.body); return {}; }, log: () => {}, alertState: createNodeMonitorAlertState(path.join(root, 'human-state')) },
    );
    assert.equal((await human.tick()).alerted, 0, 'zero reconciliation-required records stay silent');
    healthRecords = [{ ...outbox.list()[0], status: 'human_reconciliation_required' }];
    assert.equal((await human.tick()).alerted, 1, 'a rise above zero sends one reconciliation-required alert');
    assert.equal((await human.tick()).alerted, 0, 'unchanged reconciliation count is deduped');
    assert.equal(humanAlerts.length, 1);
    assert.ok(!humanAlerts[0].includes('5555550100'), 'reconciliation alert is redacted');
    assert.equal(hash(outboxPath), before, 'reconciliation reporting also never writes the outbox');

    const quiet = createCanaryOutboxMonitor(
      { enabled: false, staleAfterMs: 300_000, ntfyTopic: 'c0-test' },
      { listRecords: () => outbox.list(), now: () => now, fetchImpl: async () => { throw new Error('must not notify'); }, log: () => {}, alertState },
    );
    assert.deepEqual(await quiet.tick(), { stale: 0, alerted: 0 }, 'disabled monitor does no work');
    assert.equal(hash(outboxPath), before, 'disabled monitor also leaves the file unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('index.check OK');
}

void main();
