import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  createCustomerChatWebhook,
  createCustomerSmsOrchestrator,
} from './customer-chat-server.js';
import { SqliteSmsInboundEventStore } from './sms-inbound-event-store.js';
import type {
  SmsEstimateIntake,
  SmsInboundEventClaimStore,
  SmsInboundEventStatus,
  SmsIntakeReviewReason,
} from './sms-intake.js';

const FROM = '+14695551212';
const baseReady = {
  scope: 'Install a dedicated 50A EV charger circuit.',
  customerName: 'Test Customer',
  customerPhone: FROM,
  customerAddress: '123 Main Street, Dallas, TX 75201',
};

// The production store has an atomic unique-SID claim and retains terminal
// state after a fresh instance opens the same safe-ID-only database.
{
  const dbPath = 'data/sms-inbound-event-store.check.sqlite';
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(path, { force: true });
  const first = new SqliteSmsInboundEventStore(dbPath);
  const claimInput = { messageSid: 'SMsqlitereplay00001', operationId: 'sms-SMsqlitereplay00001', receivedAt: new Date() };
  const claims = await Promise.all([first.claim(claimInput), first.claim(claimInput)]);
  assert.equal(claims.filter(claim => claim.claimed).length, 1, 'one concurrent claim wins');
  await first.mark({ messageSid: claimInput.messageSid, status: 'completed' });
  first.close();
  const restarted = new SqliteSmsInboundEventStore(dbPath);
  assert.deepEqual(await restarted.claim(claimInput), {
    claimed: false,
    status: 'completed',
    operationId: claimInput.operationId,
  });
  restarted.close();
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(path, { force: true });
}

class FakeEventStore implements SmsInboundEventClaimStore {
  readonly events = new Map<string, { operationId: string; status: SmsInboundEventStatus; reason?: string }>();

  async claim(input: { messageSid: string; operationId: string }): Promise<
    | { claimed: true }
    | { claimed: false; status: SmsInboundEventStatus; operationId: string }
  > {
    const existing = this.events.get(input.messageSid);
    if (existing) return { claimed: false, status: existing.status, operationId: existing.operationId };
    this.events.set(input.messageSid, { operationId: input.operationId, status: 'claimed' });
    return { claimed: true };
  }

  async mark(input: { messageSid: string; status: Exclude<SmsInboundEventStatus, 'claimed'>; reviewReason?: SmsIntakeReviewReason }): Promise<void> {
    const current = this.events.get(input.messageSid);
    assert.ok(current, 'only claimed events can be marked');
    current.status = input.status;
    current.reason = input.reviewReason;
  }
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(options: {
  agentReply: string;
  runnerResult?: { success: boolean; estimateUuid?: string; reviewReason?: SmsIntakeReviewReason; errorCategory?: string };
  signatureValid?: boolean;
  eventStore?: FakeEventStore;
}): {
  webhook: ReturnType<typeof createCustomerChatWebhook>;
  runScheduled(): Promise<void>;
  agentCalls: number;
  runnerInputs: SmsEstimateIntake[];
  messages: string[];
  deliveries: number;
  store: FakeEventStore;
} {
  let agentCalls = 0;
  const runnerInputs: SmsEstimateIntake[] = [];
  const messages: string[] = [];
  const queued: Array<() => Promise<void>> = [];
  let deliveries = 0;
  const store = options.eventStore ?? new FakeEventStore();
  const sessions = new Map<string, { phone: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; lastActivity: number; estimateUuid?: string }>();
  const customer = createCustomerSmsOrchestrator({
    agent: { generate: async () => { agentCalls += 1; return { text: options.agentReply }; } },
    runner: {
      run: async intake => {
        runnerInputs.push(intake);
        return options.runnerResult ?? { success: true, estimateUuid: 'estimate-1' };
      },
    },
    sender: { send: async input => { messages.push(input.body); } },
    eventStore: store,
    clock: { now: () => new Date('2026-07-30T00:00:00.000Z') },
    sessions: {
      get: phone => {
        let session = sessions.get(phone);
        if (!session) {
          session = { phone, history: [], lastActivity: Date.now() };
          sessions.set(phone, session);
        }
        return session;
      },
    },
    sendEstimateDelivery: async () => { deliveries += 1; },
  });
  const webhook = createCustomerChatWebhook({
    validateSignature: () => options.signatureValid ?? true,
    eventStore: store,
    customer,
    handleEmployee: async () => { throw new Error('employee path should not run'); },
    clock: { now: () => new Date('2026-07-30T00:00:00.000Z') },
    schedule: work => { queued.push(work); },
  });
  return {
    webhook,
    async runScheduled() { while (queued.length) await queued.shift()!(); },
    get agentCalls() { return agentCalls; },
    runnerInputs,
    messages,
    get deliveries() { return deliveries; },
    store,
  };
}

function request(messageSid: string, body = 'Yes, please send the estimate.') {
  return { signature: 'validated', params: { From: FROM, To: '+14695550000', Body: body, MessageSid: messageSid } };
}

// Invalid signatures never claim or schedule customer work.
{
  const h = makeHarness({ agentReply: 'Hello', signatureValid: false });
  assert.equal((await h.webhook.handle(request('SMinvalidsignature001'))).status, 403);
  await h.runScheduled();
  assert.equal(h.agentCalls, 0);
  assert.equal(h.store.events.size, 0);
}

// Price decline is ordinary conversational copy, not a runner/HCP path.
{
  const h = makeHarness({ agentReply: 'No problem — reach out whenever you are ready.' });
  const result = await h.webhook.handle(request('SMpricedecision00001', 'That is more than I expected.'));
  assert.equal(result.twiml.includes('<Response/>'), true);
  await h.runScheduled();
  assert.equal(h.runnerInputs.length, 0);
  assert.equal(h.deliveries, 0);
  assert.equal(h.messages.length, 1);
  assert.equal(h.store.events.get('SMpricedecision00001')?.status, 'completed');
}

// Malformed blocks and runner address-review results get one repair message and no delivery.
for (const scenario of [
  { sid: 'SMmalformedblock0001', reply: '[ESTIMATE_READY]{oops}[/ESTIMATE_READY]', runnerResult: undefined },
  { sid: 'SMaddressreview0001', reply: `[ESTIMATE_READY]${JSON.stringify(baseReady)}[/ESTIMATE_READY]`, runnerResult: { success: false, reviewReason: 'invalid_estimate_ready' as const } },
]) {
  const h = makeHarness({ agentReply: scenario.reply, runnerResult: scenario.runnerResult });
  await h.webhook.handle(request(scenario.sid));
  await h.runScheduled();
  assert.equal(h.deliveries, 0);
  assert.equal(h.messages.length, 1, `${scenario.sid} sends one repair message`);
  assert.match(h.messages[0], /full service address/i);
  assert.equal(h.store.events.get(scenario.sid)?.status, 'review');
}

// Standard and site-walk successful paths validate first, deliver once, and use channel-true completion copy.
for (const [sid, payload, expectedDelivery] of [
  ['SMstandardsuccess001', baseReady, /by text\./],
  ['SMsitewalksuccess001', { ...baseReady, customerEmail: 'test@example.com', siteWalk: true }, /by text and email\./],
] as const) {
  const h = makeHarness({ agentReply: `[ESTIMATE_READY]${JSON.stringify(payload)}[/ESTIMATE_READY]` });
  await h.webhook.handle(request(sid));
  await h.runScheduled();
  assert.equal(h.runnerInputs.length, 1);
  assert.equal(h.runnerInputs[0].operationId, `sms-${sid}`);
  assert.equal(h.runnerInputs[0].siteWalk ?? false, sid === 'SMsitewalksuccess001');
  if (sid === 'SMsitewalksuccess001') assert.match(h.runnerInputs[0].scope, /site assessment/i);
  assert.equal(h.deliveries, 1);
  assert.equal(h.messages.length, 1, 'no pre-validation building SMS is sent');
  assert.match(h.messages[0], expectedDelivery);
  assert.doesNotMatch(h.messages[0], /on the books/i);
  assert.equal(h.store.events.get(sid)?.status, 'completed');
}

// Runner launch errors and timeouts fail closed: no HCP delivery or success copy.
for (const category of ['spawn_error', 'timeout'] as const) {
  const h = makeHarness({
    agentReply: `[ESTIMATE_READY]${JSON.stringify(baseReady)}[/ESTIMATE_READY]`,
    runnerResult: { success: false, errorCategory: category },
  });
  const sid = `SM${category}failure001`;
  await h.webhook.handle(request(sid));
  await h.runScheduled();
  assert.equal(h.deliveries, 0);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /could not finish sending/i);
  assert.equal(h.store.events.get(sid)?.status, 'failed');
}

// A shared durable store suppresses serial, concurrent, and restart replay before the agent can run.
{
  const store = new FakeEventStore();
  const h = makeHarness({ agentReply: `[ESTIMATE_READY]${JSON.stringify(baseReady)}[/ESTIMATE_READY]`, eventStore: store });
  const sid = 'SMdedupeconcurrent001';
  await Promise.all([h.webhook.handle(request(sid)), h.webhook.handle(request(sid))]);
  await h.webhook.handle(request(sid));
  await h.runScheduled();
  assert.equal(h.agentCalls, 1);
  assert.equal(h.runnerInputs.length, 1);
  assert.equal(h.deliveries, 1);
  assert.equal(h.messages.length, 1, 'duplicate events do not send duplicate completion SMS');

  const restarted = makeHarness({ agentReply: 'This must not run', eventStore: store });
  await restarted.webhook.handle(request(sid));
  await restarted.runScheduled();
  assert.equal(restarted.agentCalls, 0, 'durable replay after restart is ignored');
  assert.equal(restarted.messages.length, 0);
}

console.log('customer-chat-server checks passed');
