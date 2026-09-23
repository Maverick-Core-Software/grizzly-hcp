import { llm } from '@livekit/agents';
import { z } from 'zod';
import type { C0Bridge, ServiceRequest } from './bridge.js';
import type { TransferRole } from './transfer.js';

const nonEmpty = z.string().trim().min(1).max(500);
const callback = z.string().trim().regex(/^\+[1-9]\d{7,14}$/);

export const serviceRequestSchema = z.object({
  name: nonEmpty,
  callbackNumber: callback,
  serviceAddress: nonEmpty,
  scope: nonEmpty,
  preferredWindows: nonEmpty,
  callerConfirmed: z.literal(true),
});
export const transferSchema = z.object({ role: z.enum(['office', 'backup']) });

export function createCanaryTools(
  bridge: C0Bridge,
  callSid: string,
  callerE164: string,
  transfer: (callSid: string, role: TransferRole) => Promise<unknown>,
) {
  return [
    llm.tool({
      name: 'record_service_request',
      description: 'Record a request only after the caller confirmed the complete read-back.',
      parameters: serviceRequestSchema,
      execute: async (args) => {
        const request: ServiceRequest = args;
        const result = await bridge.record(callSid, callerE164, request);
        return result.accepted ? { status: 'recorded' } : { status: 'refused' };
      },
    }),
    llm.tool({
      name: 'request_transfer',
      description: 'Transfer only to the office or backup role; never select or expose a number.',
      parameters: transferSchema,
      execute: async ({ role }) => {
        // A refused durable intent must never strand a caller who requested a person.
        await bridge.transferIntent(callSid, callerE164, role).catch(() => ({ accepted: false }));
        const result = await transfer(callSid, role);
        return { status: 'requested', transferred: Boolean((result as { ok?: boolean }).ok) };
      },
    }),
  ] as const;
}
