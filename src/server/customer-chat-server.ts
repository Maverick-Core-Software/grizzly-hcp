/**
 * SMS chatbot server — Twilio webhook → agent → HCP estimate delivery.
 *
 * The HTTP adapter intentionally does only signature validation, durable event
 * claiming, and an immediate empty-TwiML acknowledgement.  Customer work is
 * delegated to the injectable orchestration seam below so retries cannot
 * create a second agent/pipeline/HCP-send/final-message path.
 */
import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URLSearchParams } from 'node:url';
import twilio from 'twilio';
import { createMaverickAgent } from '../agent/index.js';
import { sendEstimate, updateEstimateNotes } from '../hcp/estimates.js';
import {
  buildSmsEstimateCompletionMessage,
  deriveSmsOperationId,
  parseSmsEstimateReady,
  type SmsAgentGenerator,
  type SmsClock,
  type SmsEstimateIntake,
  type SmsEstimateRunner,
  type SmsInboundEventClaimStore,
  type SmsSender,
} from './sms-intake.js';
import { SqliteSmsInboundEventStore } from './sms-inbound-event-store.js';

const { validateRequest } = twilio;
const PORT = Number(process.env.CUSTOMER_CHAT_PORT ?? 3012);
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? '';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://chat.grizzlyelectrical.net';
const EMPLOYEE_PHONE_NUMBER = process.env.EMPLOYEE_PHONE_NUMBER ?? '';
const ESTIMATE_READY_RE = /\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/;
const MAX_HISTORY = 20;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PIPELINE_TIMEOUT_MS = 90_000;

interface EmployeeRecord { name: string; role: string; }
interface CustomerSession {
  phone: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastActivity: number;
  estimateUuid?: string;
}

const sessions = new Map<string, CustomerSession>();
const employeeSessions = new Map<string, CustomerSession>();

function getSessionFrom(map: Map<string, CustomerSession>, phone: string): CustomerSession {
  const existing = map.get(phone);
  if (existing && Date.now() - existing.lastActivity < SESSION_TTL_MS) {
    existing.lastActivity = Date.now();
    return existing;
  }
  const fresh: CustomerSession = { phone, history: [], lastActivity: Date.now() };
  map.set(phone, fresh);
  return fresh;
}

function getSession(phone: string): CustomerSession { return getSessionFrom(sessions, phone); }
function getEmployeeSession(phone: string): CustomerSession { return getSessionFrom(employeeSessions, phone); }

function loadEmployeePhones(): Record<string, EmployeeRecord> {
  try { return JSON.parse(readFileSync('data/employee-phones.json', 'utf8')) as Record<string, EmployeeRecord>; }
  catch (error) {
    console.error('[employee] Failed to load employee allowlist:', error);
    return {};
  }
}

function trimHistory(session: CustomerSession): void {
  if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
}

export type PipelineResult = {
  success: boolean;
  estimateUrl?: string;
  estimateUuid?: string;
  reviewReason?: string;
  error?: string;
  errorCategory?: string;
  smsIntake?: { normalizedAddress?: string; leadSource?: string };
};

/** A bounded, PATH-independent runner shared with the employee estimate flow. */
export function spawnPipeline(payload: unknown, logPrefix = 'customer', timeoutMs = PIPELINE_TIMEOUT_MS): Promise<PipelineResult> {
  return new Promise(resolveResult => {
    const cliPath = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    let settled = false;
    let stdout = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: PipelineResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };

    let proc;
    try {
      proc = spawn(process.execPath, [cliPath, 'src/automations/estimates/from-chat.ts'], {
        cwd: process.cwd(),
        env: process.env as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish({ success: false, errorCategory: 'spawn_error', error: 'Could not start estimate runner.' });
      return;
    }

    proc.on('error', () => finish({ success: false, errorCategory: 'spawn_error', error: 'Could not start estimate runner.' }));
    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => process.stderr.write(`[${logPrefix}:pipeline] ${data}`));
    proc.stdin.on('error', () => finish({ success: false, errorCategory: 'stdin_error', error: 'Could not send estimate intake to runner.' }));
    proc.on('close', code => {
      if (code !== 0) {
        finish({ success: false, errorCategory: 'nonzero_exit', error: 'Estimate runner did not complete.' });
        return;
      }
      try { finish(JSON.parse(stdout) as PipelineResult); }
      catch { finish({ success: false, errorCategory: 'invalid_response', error: 'Invalid estimate runner response.' }); }
    });
    timer = setTimeout(() => {
      proc.kill();
      finish({ success: false, errorCategory: 'timeout', error: 'Estimate runner timed out.' });
    }, timeoutMs);
    try {
      proc.stdin.end(JSON.stringify(payload));
    } catch {
      finish({ success: false, errorCategory: 'stdin_error', error: 'Could not send estimate intake to runner.' });
    }
  });
}

export interface CustomerSmsSessionStore {
  get(phone: string): CustomerSession;
}

export interface CustomerSmsOrchestratorDependencies {
  agent: SmsAgentGenerator;
  runner: SmsEstimateRunner;
  sender: SmsSender;
  eventStore: SmsInboundEventClaimStore;
  clock: SmsClock;
  sessions: CustomerSmsSessionStore;
  sendEstimateDelivery(input: { estimateUuid: string; phone: string; email?: string; customerName?: string }): Promise<void>;
  updateNotes?(estimateUuid: string, note: string): Promise<void>;
}

export interface CustomerSmsInboundMessage {
  messageSid: string;
  operationId: string;
  fromPhone: string;
  body: string;
}

const ADDRESS_REPAIR_MESSAGE = 'Before we prepare the estimate, please reply with your full service address, including city, state, and ZIP code.';
const ESTIMATE_FOLLOW_UP_MESSAGE = 'We could not finish sending the estimate just yet. Our team will follow up with you shortly.';

function safeVisibleReply(reply: string): string {
  return reply.replace(ESTIMATE_READY_RE, '').trim();
}

function customerPrompt(session: CustomerSession, body: string): string {
  const history = session.history
    .map(message => `${message.role === 'user' ? 'Customer' : 'Grizzly'}: ${message.content}`)
    .join('\n');
  return history ? `${history}\nCustomer: ${body}` : body;
}

/**
 * Executes exactly one claimed customer webhook event.  Callers must claim the
 * MessageSid before scheduling this work; this function only marks terminal
 * status and never reclaims the event.
 */
export function createCustomerSmsOrchestrator(deps: CustomerSmsOrchestratorDependencies) {
  async function mark(
    messageSid: string,
    status: 'completed' | 'review' | 'failed',
    reviewReason?: import('./sms-intake.js').SmsIntakeReviewReason,
  ): Promise<void> {
    try { await deps.eventStore.mark({ messageSid, status, reviewReason }); }
    catch (error) { console.error('[customer] Could not persist inbound event status:', error); }
  }

  async function send(to: string, body: string): Promise<void> {
    try { await deps.sender.send({ to, body }); }
    catch (error) { console.error('[customer] Outbound SMS failed:', error); }
  }

  return {
    async handle(input: CustomerSmsInboundMessage): Promise<void> {
      const session = deps.sessions.get(input.fromPhone);
      let agentReply = '';
      try {
        const result = await deps.agent.generate(customerPrompt(session, input.body));
        agentReply = typeof result.text === 'string' ? result.text : '';
      } catch (error) {
        console.error('[customer] Agent error:', error);
        await send(input.fromPhone, 'Sorry, something went wrong on our end. Try again in a moment!');
        await mark(input.messageSid, 'failed');
        return;
      }

      session.history.push({ role: 'user', content: input.body });
      const estimateMatch = agentReply.match(ESTIMATE_READY_RE);
      if (!estimateMatch) {
        session.history.push({ role: 'assistant', content: agentReply });
        trimHistory(session);
        await send(input.fromPhone, agentReply);
        await mark(input.messageSid, 'completed');
        return;
      }

      let rawPayload: unknown;
      try { rawPayload = JSON.parse(estimateMatch[1]); }
      catch {
        session.history.push({ role: 'assistant', content: ADDRESS_REPAIR_MESSAGE });
        trimHistory(session);
        await send(input.fromPhone, ADDRESS_REPAIR_MESSAGE);
        await mark(input.messageSid, 'review');
        return;
      }

      const intakeDecision = parseSmsEstimateReady(rawPayload, {
        trustedInboundPhone: input.fromPhone,
        operationId: input.operationId,
      });
      if (intakeDecision.kind === 'review') {
        session.history.push({ role: 'assistant', content: ADDRESS_REPAIR_MESSAGE });
        trimHistory(session);
        await send(input.fromPhone, ADDRESS_REPAIR_MESSAGE);
        try { await deps.eventStore.mark({ messageSid: input.messageSid, status: 'review', reviewReason: intakeDecision.reason }); }
        catch (error) { console.error('[customer] Could not persist review status:', error); }
        return;
      }

      const intake: SmsEstimateIntake = intakeDecision.intake;
      const visibleReply = safeVisibleReply(agentReply);
      if (visibleReply) {
        session.history.push({ role: 'assistant', content: visibleReply });
        trimHistory(session);
        await send(input.fromPhone, visibleReply);
      }

      const runnerInput = intake.siteWalk
        ? { ...intake, scope: 'Initial site assessment visit with site assessment fee waiver' }
        : intake;
      const estimate = await deps.runner.run(runnerInput);
      if (!estimate.success || !estimate.estimateUuid) {
        const isReview = Boolean(estimate.reviewReason);
        await send(input.fromPhone, isReview ? ADDRESS_REPAIR_MESSAGE : ESTIMATE_FOLLOW_UP_MESSAGE);
        await mark(input.messageSid, isReview ? 'review' : 'failed', estimate.reviewReason);
        return;
      }

      session.estimateUuid = estimate.estimateUuid;
      try {
        if (deps.updateNotes) {
          const source = intake.leadSource ? ` Lead source: ${intake.leadSource}.` : '';
          await deps.updateNotes(estimate.estimateUuid, `SMS estimate intake completed.${source}`)
            .catch(error => console.warn('[customer] Could not save SMS intake note:', error));
        }
        await deps.sendEstimateDelivery({
          estimateUuid: estimate.estimateUuid,
          phone: input.fromPhone,
          email: intake.customerEmail,
          customerName: intake.customerName,
        });
      } catch (error) {
        console.error('[customer] Estimate delivery failed:', error);
        await send(input.fromPhone, ESTIMATE_FOLLOW_UP_MESSAGE);
        await mark(input.messageSid, 'failed');
        return;
      }

      const completion = buildSmsEstimateCompletionMessage({ customerEmail: intake.customerEmail });
      session.history.push({ role: 'assistant', content: completion });
      trimHistory(session);
      await send(input.fromPhone, completion);
      await mark(input.messageSid, 'completed');
      console.log('[customer] Estimate created and delivered.');
    },
  };
}

export interface CustomerChatWebhookDependencies {
  validateSignature(input: { signature: string; params: Record<string, string> }): boolean;
  eventStore: SmsInboundEventClaimStore;
  customer: ReturnType<typeof createCustomerSmsOrchestrator>;
  handleEmployee(fromPhone: string, messageBody: string): Promise<void>;
  employeePhoneNumber?: string;
  clock: SmsClock;
  schedule(work: () => Promise<void>): void;
}

export type TwilioWebhookOutcome = { status: 200 | 403; twiml: string };
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/** Thin, testable signed-webhook adapter.  The event claim occurs before schedule(). */
export function createCustomerChatWebhook(deps: CustomerChatWebhookDependencies) {
  return {
    async handle(input: { signature: string; params: Record<string, string> }): Promise<TwilioWebhookOutcome> {
      if (!deps.validateSignature(input)) return { status: 403, twiml: '' };
      const fromPhone = input.params.From ?? '';
      const body = (input.params.Body ?? '').trim();
      if (!fromPhone || !body) return { status: 200, twiml: EMPTY_TWIML };

      if (deps.employeePhoneNumber && input.params.To === deps.employeePhoneNumber) {
        deps.schedule(() => deps.handleEmployee(fromPhone, body));
        return { status: 200, twiml: EMPTY_TWIML };
      }

      const messageSid = input.params.MessageSid?.trim() ?? '';
      const operationId = deriveSmsOperationId(messageSid);
      if (!operationId) {
        console.warn('[customer] Missing or invalid signed MessageSid; customer work not started.');
        return { status: 200, twiml: EMPTY_TWIML };
      }

      let claim;
      try {
        claim = await deps.eventStore.claim({ messageSid, operationId, receivedAt: deps.clock.now() });
      } catch (error) {
        console.error('[customer] Could not claim inbound event; customer work not started:', error);
        return { status: 200, twiml: EMPTY_TWIML };
      }
      if (!claim.claimed) return { status: 200, twiml: EMPTY_TWIML };

      deps.schedule(() => deps.customer.handle({ messageSid, operationId, fromPhone, body }));
      return { status: 200, twiml: EMPTY_TWIML };
    },
  };
}

const agent = createMaverickAgent('customer');
const employeeAgent = createMaverickAgent('employee');
const twilioClient = new twilio.Twilio(process.env.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function sendSms(to: string, body: string, from = TWILIO_PHONE_NUMBER): Promise<void> {
  await twilioClient.messages.create({ from, to, body });
}

async function handleEmployee(fromPhone: string, messageBody: string): Promise<void> {
  const record = loadEmployeePhones()[fromPhone];
  if (!record) {
    await sendSms(fromPhone, "This number isn't authorized to use the Grizzly employee assistant. Contact Carter to request access.", EMPLOYEE_PHONE_NUMBER).catch(() => {});
    return;
  }
  const session = getEmployeeSession(fromPhone);
  const context = session.history.map(message => `${message.role === 'user' ? record.name : 'Maverick'}: ${message.content}`).join('\n');
  let reply = '';
  try {
    const result = await employeeAgent.generate(context ? `${context}\n${record.name}: ${messageBody}` : messageBody);
    reply = typeof result.text === 'string' ? result.text : '';
  } catch {
    await sendSms(fromPhone, 'Something went wrong. Try again in a moment.', EMPLOYEE_PHONE_NUMBER).catch(() => {});
    return;
  }
  session.history.push({ role: 'user', content: messageBody });
  const match = reply.match(ESTIMATE_READY_RE);
  if (!match) {
    session.history.push({ role: 'assistant', content: reply });
    trimHistory(session);
    await sendSms(fromPhone, reply, EMPLOYEE_PHONE_NUMBER).catch(() => {});
    return;
  }
  const visible = safeVisibleReply(reply) || 'Building the estimate now ⚡';
  session.history.push({ role: 'assistant', content: visible });
  trimHistory(session);
  await sendSms(fromPhone, visible, EMPLOYEE_PHONE_NUMBER).catch(() => {});
  try {
    const estimate = await spawnPipeline(JSON.parse(match[1]), 'employee');
    if (!estimate.success || !estimate.estimateUuid) throw new Error(estimate.error ?? 'Pipeline failed');
    session.estimateUuid = estimate.estimateUuid;
    try {
      appendFileSync('data/employee-sessions.jsonl', JSON.stringify({ name: record.name, role: record.role, estimateUuid: estimate.estimateUuid, ts: Date.now() }) + '\n');
    } catch { /* non-fatal */ }
    const transcript = session.history
      .map(message => `[${message.role === 'user' ? record.name : 'Maverick'}] ${message.content}`)
      .join('\n');
    await updateEstimateNotes(estimate.estimateUuid, `=== Employee SMS Transcript (${record.name}) ===\n${transcript}`)
      .catch(error => console.warn('[employee] Could not save transcript:', error));
    await sendSms(fromPhone, `Estimate created ✅ UUID: ${estimate.estimateUuid}${estimate.estimateUrl ? `\n${estimate.estimateUrl}` : ''}`, EMPLOYEE_PHONE_NUMBER).catch(() => {});
  } catch (error) {
    console.error('[employee] Pipeline failed:', error);
    await sendSms(fromPhone, 'Pipeline failed — check the server logs.', EMPLOYEE_PHONE_NUMBER).catch(() => {});
  }
}

const eventStore = new SqliteSmsInboundEventStore();
const customer = createCustomerSmsOrchestrator({
  agent,
  runner: {
    run: async input => {
      const result = await spawnPipeline(input);
      return {
        ...result,
        // The subprocess reports resolver reasons too; they are intentionally
        // handled as a generic review by this boundary.
        reviewReason: result.reviewReason as import('./sms-intake.js').SmsIntakeReviewReason | undefined,
      };
    },
  },
  sender: { send: input => sendSms(input.to, input.body, input.from) },
  eventStore,
  clock: { now: () => new Date() },
  sessions: { get: getSession },
  sendEstimateDelivery: input => sendEstimate(input.estimateUuid, { phone: input.phone, email: input.email, customerName: input.customerName }),
  updateNotes: updateEstimateNotes,
});
const webhook = createCustomerChatWebhook({
  validateSignature: ({ signature, params }) => validateRequest(TWILIO_AUTH_TOKEN, signature, `${PUBLIC_URL}/webhook/twilio`, params),
  eventStore,
  customer,
  handleEmployee,
  employeePhoneNumber: EMPLOYEE_PHONE_NUMBER,
  clock: { now: () => new Date() },
  schedule: work => { setImmediate(() => { void work(); }); },
});

export const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('customer-chat-server ok\n');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/webhook/twilio') {
    res.writeHead(404); res.end(); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const params = Object.fromEntries(new URLSearchParams(body));
  const outcome = await webhook.handle({
    signature: (req.headers['x-twilio-signature'] as string) ?? '',
    params,
  });
  if (outcome.status === 403) { res.writeHead(403); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end(outcome.twiml);
});

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/customer-chat-server.ts')) {
  server.listen(PORT, () => console.log(`[server] SMS chatbot listening on port ${PORT}`));
}
