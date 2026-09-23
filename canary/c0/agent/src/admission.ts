import { ParticipantKind } from '@livekit/rtc-node';
import { evaluateAdmission, type C0AdmissionResult } from '../../../../src/agent/voice/c0-limits.js';
import type { DailyUsage } from './runtime.js';

export interface RoomServiceLike {
  listRooms(): Promise<Array<{ name?: string }>>;
  listParticipants(roomName: string): Promise<Array<{ kind?: ParticipantKind | number }>>;
}

/** Counts other active C0 rooms: this call occupies its room before its gate runs. */
export async function activeSipCanaryCalls(client: RoomServiceLike, currentRoomName: string): Promise<number | null> {
  try {
    const rooms = await client.listRooms();
    let activeCalls = 0;
    for (const room of rooms) {
      if (!room.name?.startsWith('c0-') || room.name === currentRoomName) continue;
      const participants = await client.listParticipants(room.name);
      if (participants.some((participant) => participant.kind === ParticipantKind.SIP)) activeCalls += 1;
    }
    return activeCalls;
  } catch {
    return null;
  }
}

export async function evaluateCanaryAdmission(client: RoomServiceLike, currentRoomName: string, usage: DailyUsage | null): Promise<C0AdmissionResult> {
  return evaluateAdmission({
    activeCalls: await activeSipCanaryCalls(client, currentRoomName),
    todayCalls: usage?.todayCalls ?? null,
    todayGptLiveMinutes: usage?.todayGptLiveMinutes ?? null,
  });
}
