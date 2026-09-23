import type { C0Bridge } from './bridge.js';
import type { TransferRole } from './transfer.js';

export interface CanaryMappingInput {
  readonly parentCallSid: string;
  readonly childCallSid?: string;
  readonly trunkId: string;
  readonly ruleId: string;
  readonly roomName: string;
  readonly participantIdentity: string;
  readonly sipCallIdFull?: string;
}

/** A mapping conflict is never retried in-call; it immediately routes to office. */
export async function bindOrTransfer(
  bridge: C0Bridge,
  input: CanaryMappingInput,
  transfer: (callSid: string, role: TransferRole) => Promise<unknown>,
): Promise<boolean> {
  try {
    if (bridge.bind(input).accepted) return true;
  } catch {
    // Treat storage or validation faults as a conflict: the caller still reaches office.
  }
  await transfer(input.parentCallSid, 'office');
  return false;
}
