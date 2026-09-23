import { Agent, AgentSession, AgentSessionEventTypes, defineAgent, ServerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { realtime } from '@livekit/agents-plugin-openai';
import { ParticipantKind } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';
import { InMemoryC0Bridge, RealC0Bridge, type C0Bridge } from './bridge.js';
import { evaluateCanaryAdmission, type RoomServiceLike } from './admission.js';
import { markFirstPublishedAudio } from './audio.js';
import { fetchAllowedCaller, type ParentCallLookupClient } from './caller.js';
import { loadCanaryRuntimeConfig, type CanaryRuntimeConfig } from './config.js';
import { evaluateGate, waitForCallSid, type SipParticipantLike } from './gate.js';
import { DailyUsageStore, FileMarkerWriter, REPO_ROOT, resolveDataRoot, type MarkerWriter } from './runtime.js';
import { bindOrTransfer } from './mapping.js';
import { createCanaryTools } from './tools.js';
import { createSyncDocumentClient, createTwilioCallClient, transferWithSync, writeAdmission, clearAdmission, type CallRedirectClient, type SyncDocumentClient, type TransferRole } from './transfer.js';

export const AGENT_NAME = 'grizzly-c0-canary';
export const CANARY_INSTRUCTIONS = `You are the Grizzly Electrical canary intake assistant. Collect the caller's name, callback number, service address, broad scope, and preferred windows. Read the information back and obtain confirmation before recording it. Never promise a booking, price, dispatch, or availability. Say exactly: "The office will review your request and contact you." Offer a person at any time. Do not provide electrical diagnosis. For emergencies, tell the caller to hang up and call 911.`;

type Transfer = (callSid: string, role: TransferRole) => Promise<unknown>;

/**
 * Keeps a durable admission from becoming a caller hang-up if anything fails
 * before the LiveKit session is successfully started.
 */
export async function startPostAdmission<T>(
  sync: SyncDocumentClient,
  parentCallSid: string,
  transfer: Transfer,
  start: () => Promise<T> | T,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  try {
    return { ok: true, value: await start() };
  } catch {
    await clearAdmission(sync, parentCallSid).catch(() => undefined);
    await transfer(parentCallSid, 'office').catch(() => undefined);
    return { ok: false };
  }
}

export async function routePreSessionRefusal(
  parentCallSid: string | undefined,
  transfer: Transfer,
  endLeg: () => Promise<void>,
): Promise<'transferred' | 'ended'> {
  if (typeof parentCallSid === 'string' && /^CA[0-9a-f]{32}$/.test(parentCallSid)) {
    await transfer(parentCallSid, 'office');
    return 'transferred';
  }
  await endLeg();
  return 'ended';
}

interface WorkerDeps {
  readonly bridge: C0Bridge;
  readonly markers: MarkerWriter;
  readonly usage: DailyUsageStore;
  readonly rooms: RoomServiceLike & { deleteRoom(roomName: string): Promise<void> };
  readonly calls: ParentCallLookupClient & CallRedirectClient;
  readonly sync: SyncDocumentClient;
}

function participantWaiter(ctx: { room: { once(event: string, handler: () => void): unknown } }): () => Promise<void> {
  return () => new Promise((resolve) => { ctx.room.once('participant_attributes_changed', resolve); });
}

function makeDefaultDeps(config: CanaryRuntimeConfig): WorkerDeps {
  const calls = createTwilioCallClient(config);
  return {
    bridge: new RealC0Bridge(config.c0Env, REPO_ROOT, config.mappingPath),
    markers: new FileMarkerWriter(resolveDataRoot(config.dataDir)),
    usage: new DailyUsageStore(resolveDataRoot(config.dataDir)),
    rooms: new RoomServiceClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret),
    calls,
    sync: createSyncDocumentClient(config),
  };
}

function mappingInput(roomName: string, participant: SipParticipantLike & { identity?: string }) {
  return {
    childCallSid: participant.attributes['sip.twilio.callSid'],
    trunkId: participant.attributes['sip.trunkID'] ?? '',
    ruleId: participant.attributes['sip.ruleID'] ?? '',
    roomName,
    participantIdentity: participant.identity ?? '',
    sipCallIdFull: participant.attributes['sip.callID'],
  };
}

async function enterCanary(
  ctx: Parameters<Parameters<typeof defineAgent>[0]['entry']>[0],
  participant: SipParticipantLike & { identity?: string },
  config: CanaryRuntimeConfig,
  deps: WorkerDeps,
): Promise<void> {
  const gateConfig = { enabled: config.enabled, trunkId: config.trunkId, ruleId: config.ruleId, sipKind: ParticipantKind.SIP };
  const roomName = ctx.room.name ?? '';
  const preTransfer: Transfer = (callSid, role) => transferWithSync(deps.sync, deps.calls, { endAiLeg: () => deps.rooms.deleteRoom(roomName) }, callSid, role, config.fallbackUrl);
  const initial = evaluateGate(participant, gateConfig);
  const gate = initial.ok || initial.reason !== 'call_sid_missing'
    ? initial
    : await waitForCallSid(participant, gateConfig, participantWaiter(ctx));
  if (!gate.ok) {
    const refusalSid = gate.callSid ?? participant.attributes['c0.callSid'];
    await routePreSessionRefusal(refusalSid, preTransfer, () => deps.rooms.deleteRoom(roomName)).catch(() => undefined);
    ctx.shutdown('c0_gate_refused');
    return;
  }

  const transfer: Transfer = preTransfer;
  let ending = false;
  const transferAndShutdown = async (reason: string): Promise<void> => {
    if (!ending) {
      ending = true;
      await transfer(gate.callSid, 'office').catch(() => undefined);
    }
    ctx.shutdown(reason);
  };

  const callerE164 = await fetchAllowedCaller(deps.calls, gate.callSid, config.callerAllowlist);
  if (!callerE164) return transferAndShutdown('c0_caller_refused');
  if (!await bindOrTransfer(deps.bridge, { parentCallSid: gate.callSid, ...mappingInput(roomName, participant) }, transfer)) {
    ending = true;
    return ctx.shutdown('c0_mapping_refused');
  }
  const admission = await evaluateCanaryAdmission(deps.rooms, roomName, deps.usage.usage());
  if (!admission.admit) return transferAndShutdown(`c0_admission_${admission.reason}`);
  const started = await startPostAdmission(deps.sync, gate.callSid, transfer, async () => {
    await writeAdmission(deps.sync, gate.callSid, new Date().toISOString());
    deps.markers.mark('answered', gate.callSid);
    deps.usage.append(1, 0);
    const model = new realtime.GPTLiveModel({ model: 'gpt-live-1', delegation: 'responses', apiKey: config.openaiApiKey });
    const tools = createCanaryTools(deps.bridge, gate.callSid, callerE164, transfer);
    const agent = new Agent({ instructions: CANARY_INSTRUCTIONS, llm: model, tools });
    const session = new AgentSession({ userAwayTimeout: 15 });
    await session.start({ agent, room: ctx.room, record: { logs: false, traces: false, audio: false } });
    return session;
  });
  if (!started.ok) {
    ending = true;
    ctx.shutdown('c0_post_admission_failure');
    return;
  }
  const session = started.value;
  let firstAudio = false;
  let checkedIn = false;
  let gptLiveSeconds = 0;
  session.on(AgentSessionEventTypes.AgentStateChanged, (event) => {
    if (config.rehearsalSilentStart) return;
    firstAudio = markFirstPublishedAudio(event.newState, firstAudio, deps.markers, gate.callSid);
  });
  session.on(AgentSessionEventTypes.MetricsCollected, (event) => {
    const metrics = event.metrics as { duration?: unknown };
    if (typeof metrics.duration === 'number' && Number.isFinite(metrics.duration) && metrics.duration > 0) gptLiveSeconds += metrics.duration;
  });
  session.on(AgentSessionEventTypes.UserStateChanged, async (event) => {
    if (event.newState !== 'away') return;
    if (!checkedIn) { checkedIn = true; session.say('Are you still there?'); return; }
    await transferAndShutdown('c0_silence_deadline');
  });
  const deadline = setTimeout(() => { void transferAndShutdown('c0_max_duration'); }, 480_000);
  ctx.addShutdownCallback(async () => {
    clearTimeout(deadline);
    deps.usage.append(0, gptLiveSeconds);
  });
  try {
    if (config.rehearsalSilentStart) await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
    await session.generateReply({ instructions: 'Greet briefly and offer assistance.' });
  } catch {
    await transferAndShutdown('c0_session_error');
  }
}

/** Importing this module creates only an agent definition; it never loads config or starts a server. */
export function createWorkerAgent(
  loadConfig: () => CanaryRuntimeConfig = loadCanaryRuntimeConfig,
  makeDeps: (config: CanaryRuntimeConfig) => WorkerDeps = makeDefaultDeps,
) {
  return defineAgent({ entry: async (ctx) => {
    const config = loadConfig();
    const deps = makeDeps(config);
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    await enterCanary(ctx, participant, config, deps);
  } });
}

export default createWorkerAgent();

export function createCanaryServerOptions(config: CanaryRuntimeConfig): ServerOptions {
  return new ServerOptions({
    agent: fileURLToPath(new URL('./worker.ts', import.meta.url)),
    agentName: AGENT_NAME,
    wsURL: config.livekitUrl,
    apiKey: config.livekitApiKey,
    apiSecret: config.livekitApiSecret,
  });
}

export { InMemoryC0Bridge };
