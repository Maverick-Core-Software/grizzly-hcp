import { createC0Controller, type C0Controller } from '../../../../src/agent/voice/c0-controller.js';
import { loadC0Config, resolveOutboxPath } from '../../../../src/agent/voice/c0-config.js';
import { Outbox } from '../../../../src/agent/voice/outbox.js';
import { C0MappingStore } from '../../../../src/agent/voice/c0-mapping.js';
import type { TransferRole } from './transfer.js';
import { REPO_ROOT, resolveCanaryPath } from './runtime.js';

export interface ServiceRequest {
  readonly name: string;
  readonly callbackNumber: string;
  readonly serviceAddress: string;
  readonly scope: string;
  readonly preferredWindows: string;
  readonly callerConfirmed: true;
}

export interface C0Bridge {
  bind(input: { parentCallSid: string; childCallSid?: string; trunkId: string; ruleId: string; roomName: string; participantIdentity: string; sipCallIdFull?: string }): { readonly accepted: boolean };
  record(callSid: string, callerE164: string, request: ServiceRequest): Promise<{ readonly accepted: boolean }>;
  transferIntent(callSid: string, callerE164: string, role: TransferRole): Promise<{ readonly accepted: boolean }>;
}

export class InMemoryC0Bridge implements C0Bridge {
  readonly requests: Array<{ callSid: string; request: ServiceRequest }> = [];
  readonly transfers: Array<{ callSid: string; role: TransferRole }> = [];
  bind(): { accepted: boolean } { return { accepted: true }; }
  async record(callSid: string, _callerE164: string, request: ServiceRequest): Promise<{ accepted: boolean }> {
    this.requests.push({ callSid, request });
    return { accepted: true };
  }
  async transferIntent(callSid: string, _callerE164: string, role: TransferRole): Promise<{ accepted: boolean }> {
    this.transfers.push({ callSid, role });
    return { accepted: true };
  }
}

/** Thin seam over the current C0 controller/outbox; rewire only this class when Task A changes its contract. */
export class RealC0Bridge implements C0Bridge {
  private readonly controller: C0Controller;
  readonly mapping: C0MappingStore;
  private readonly nextSequence = new Map<string, number>();
  constructor(env: NodeJS.ProcessEnv, repoRoot: string = REPO_ROOT, mappingPath: string | null = null) {
    const config = loadC0Config(env);
    const outbox = new Outbox(resolveOutboxPath(config, repoRoot));
    this.mapping = new C0MappingStore({ path: resolveCanaryPath(mappingPath, 'data/c0/voice-c0-mapping.jsonl') });
    this.controller = createC0Controller({ config, outbox });
  }
  private sequence(callSid: string): number {
    const next = (this.nextSequence.get(callSid) ?? 0) + 1;
    this.nextSequence.set(callSid, next);
    return next;
  }
  bind(input: { parentCallSid: string; childCallSid?: string; trunkId: string; ruleId: string; roomName: string; participantIdentity: string; sipCallIdFull?: string }): { accepted: boolean } {
    return { accepted: this.mapping.bind(input).ok };
  }
  async record(callSid: string, callerE164: string, request: ServiceRequest): Promise<{ accepted: boolean }> {
    const result = this.controller.enqueueServiceIntent({
      callSid,
      callerE164,
      intentSequence: this.sequence(callSid),
      payloadVersion: 1,
      intent: {
        name: request.name,
        callbackE164: request.callbackNumber,
        serviceAddress: request.serviceAddress,
        scope: request.scope,
        preferredWindows: request.preferredWindows,
        callerConfirmed: request.callerConfirmed,
      },
    });
    return { accepted: result.status !== 'inert' };
  }
  async transferIntent(callSid: string, callerE164: string, role: TransferRole): Promise<{ accepted: boolean }> {
    const result = this.controller.enqueueTransferRequest({
      callSid,
      callerE164,
      intentSequence: this.sequence(callSid),
      role,
    });
    return { accepted: result.status !== 'inert' };
  }
}
