/**
 * Booking approval poller — PM2 process `booking-approval-poller`.
 *
 * Every BOOKING_POLL_INTERVAL_MS (default 60s), for each pending booking:
 *
 *  1. HCP notes — when Carter/Jaime adds a note starting with SCHEDULE …
 *  2. Ops SMS — when Carter replies to the ops booking alert with:
 *        SCHEDULE <estimateId> MM/DD h:mm am - h:mm pm
 *     (or SCHEDULE MM/DD … if only one pending booking)
 *
 * On match: update_job_schedule via MCP, mark pending "scheduled", confirm note
 * on the estimate, optional ops SMS ack.
 *
 * Times are server-local America/Chicago (PC Central).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getJobNotes, updateJobSchedule } from '../../hcp/mcp-client.js';
import { buildSchedulePayload } from '../../hcp/schedule-payload.js';
import { updateEstimateNotes } from '../../hcp/estimates.js';
import { sendOpsSms } from '../../ops/alert.js';
import { fetchRecentOpsInboundSms } from '../../ops/ops-sms-inbound.js';
import {
  parseScheduleCommand,
  SCHEDULE_ANY_RE,
  toOffsetIso,
  type ParsedScheduleCommand,
} from './schedule-command.js';

const PENDING_FILE = path.resolve(process.cwd(), 'data/pending-bookings.jsonl');
const SEEN_SMS_FILE = path.resolve(process.cwd(), 'data/ops-sms-schedule-seen.json');
const INTERVAL_MS = Number(process.env.BOOKING_POLL_INTERVAL_MS ?? 60000);
const PRO_IDS = [process.env.CARTER_PRO_ID, process.env.JAIME_PRO_ID]
  .filter((u): u is string => Boolean(u))
  .map(Number);

interface PendingBooking {
  estimateUuid: string;
  estimateId: number;
  kind: string;
  customerName: string;
  status: string;
  createdAt: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  scheduledAt?: string;
  approvedVia?: string;
  [k: string]: unknown;
}

function readPending(): PendingBooking[] {
  if (!fs.existsSync(PENDING_FILE)) return [];
  return fs
    .readFileSync(PENDING_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as PendingBooking; } catch { return null; }
    })
    .filter((b): b is PendingBooking => b !== null);
}

function writePending(all: PendingBooking[]) {
  const tmp = PENDING_FILE + '.tmp';
  fs.writeFileSync(tmp, all.map((b) => JSON.stringify(b)).join('\n') + (all.length ? '\n' : ''));
  fs.renameSync(tmp, PENDING_FILE);
}

function readSeenSms(): Set<string> {
  try {
    if (!fs.existsSync(SEEN_SMS_FILE)) return new Set();
    const raw = JSON.parse(fs.readFileSync(SEEN_SMS_FILE, 'utf-8')) as { sids?: string[] };
    return new Set(raw.sids ?? []);
  } catch {
    return new Set();
  }
}

function writeSeenSms(sids: Set<string>) {
  // Cap growth — keep the newest ~500 SIDs.
  const list = [...sids].slice(-500);
  const tmp = SEEN_SMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ sids: list }, null, 0));
  fs.renameSync(tmp, SEEN_SMS_FILE);
}

/** Pull note text strings out of whatever shape HCP returns. */
function extractNoteTexts(raw: unknown): string[] {
  const texts: string[] = [];
  const visit = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.content === 'string') texts.push(o.content);
      if (typeof o.note === 'string') texts.push(o.note);
      if (typeof o.body === 'string') texts.push(o.body);
      Object.values(o).forEach(visit);
    }
  };
  visit(raw);
  return texts;
}

function resolveBookingForCommand(
  cmd: ParsedScheduleCommand,
  pending: PendingBooking[],
): PendingBooking | null {
  const open = pending.filter((b) => b.status === 'pending');
  if (cmd.estimateId != null) {
    return open.find((b) => Number(b.estimateId) === Number(cmd.estimateId)) ?? null;
  }
  // No id: only auto-match when exactly one pending booking.
  if (open.length === 1) return open[0];
  return null;
}

async function applySchedule(
  booking: PendingBooking,
  cmd: ParsedScheduleCommand,
  via: string,
): Promise<void> {
  const payload = buildSchedulePayload(
    String(booking.estimateId),
    toOffsetIso(cmd.start),
    toOffsetIso(cmd.end),
    PRO_IDS,
  );
  await updateJobSchedule(String(booking.estimateId), payload);
  booking.status = 'scheduled';
  booking.scheduledStart = cmd.start.toISOString();
  booking.scheduledEnd = cmd.end.toISOString();
  booking.scheduledAt = new Date().toISOString();
  booking.approvedVia = via;

  const when = `${cmd.start.toLocaleString('en-US', { timeZone: 'America/Chicago' })} – ${cmd.end.toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })}`;
  console.log(`[poller] ✅ Scheduled ${booking.customerName} (#${booking.estimateId}) ${when} via ${via}`);

  try {
    await updateEstimateNotes(
      booking.estimateUuid,
      `✅ MAVERICK: scheduled ${when} (via ${via}). HCP will notify the customer.\nCommand: ${cmd.raw}`,
    );
  } catch (e) {
    console.error(`[poller] confirmation note failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }

  try {
    await sendOpsSms(
      `✅ Scheduled #${booking.estimateId} ${booking.customerName}\n${when}`,
    );
  } catch (e) {
    console.error(`[poller] ops SMS ack failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}

async function processHcpNotes(all: PendingBooking[]): Promise<boolean> {
  let changed = false;
  for (const booking of all) {
    if (booking.status !== 'pending') continue;
    try {
      const raw = await getJobNotes(booking.estimateUuid);
      const noteTexts = extractNoteTexts(raw).filter((t) => !t.includes('MAVERICK'));
      const scheduleNote = noteTexts.find((t) => SCHEDULE_ANY_RE.test(t) && parseScheduleCommand(t));
      if (!scheduleNote) continue;

      const cmd = parseScheduleCommand(scheduleNote);
      if (!cmd) {
        console.error(`[poller] ${booking.estimateUuid}: SCHEDULE note found but unparseable: ${scheduleNote.slice(0, 80)}`);
        continue;
      }
      // Note is on this estimate already — ignore mismatched embedded id if any.
      if (cmd.estimateId != null && Number(cmd.estimateId) !== Number(booking.estimateId)) {
        console.error(
          `[poller] ${booking.estimateUuid}: SCHEDULE note id ${cmd.estimateId} != booking ${booking.estimateId}`,
        );
        continue;
      }
      await applySchedule(booking, cmd, 'hcp-note');
      changed = true;
    } catch (e) {
      console.error(`[poller] hcp-note ${booking.estimateUuid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return changed;
}

async function processOpsSms(all: PendingBooking[]): Promise<boolean> {
  let changed = false;
  let messages;
  try {
    messages = await fetchRecentOpsInboundSms();
  } catch (e) {
    console.error(`[poller] ops-sms fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (messages.length === 0) return false;

  const seen = readSeenSms();
  let seenDirty = false;

  // Oldest first so sequential approvals apply in order.
  const ordered = [...messages].reverse();

  for (const msg of ordered) {
    if (seen.has(msg.sid)) continue;
    const cmd = parseScheduleCommand(msg.body);
    if (!cmd) {
      // Not a schedule command — mark seen so we don't re-scan forever.
      // Only skip mark if body is empty.
      if (msg.body) {
        seen.add(msg.sid);
        seenDirty = true;
      }
      continue;
    }

    const booking = resolveBookingForCommand(cmd, all);
    if (!booking) {
      console.error(
        `[poller] ops-sms ${msg.sid}: no pending booking for ${cmd.estimateId ?? 'single-pending'} — ${msg.body.slice(0, 80)}`,
      );
      try {
        await sendOpsSms(
          cmd.estimateId
            ? `❌ No pending booking #${cmd.estimateId}. Check estimate id.`
            : `❌ Need estimate id when multiple pending. Reply: SCHEDULE <id> MM/DD h:mm am - h:mm pm`,
        );
      } catch { /* non-fatal */ }
      seen.add(msg.sid);
      seenDirty = true;
      continue;
    }

    if (booking.status !== 'pending') {
      seen.add(msg.sid);
      seenDirty = true;
      continue;
    }

    try {
      await applySchedule(booking, cmd, `ops-sms:${msg.sid}`);
      changed = true;
    } catch (e) {
      console.error(`[poller] ops-sms apply failed: ${e instanceof Error ? e.message : String(e)}`);
      try {
        await sendOpsSms(`❌ Schedule failed for #${booking.estimateId}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
      } catch { /* non-fatal */ }
    }
    seen.add(msg.sid);
    seenDirty = true;
  }

  if (seenDirty) writeSeenSms(seen);
  return changed;
}

async function tick() {
  const all = readPending();
  const noteChanged = await processHcpNotes(all);
  const smsChanged = await processOpsSms(all);
  if (noteChanged || smsChanged) writePending(all);
}

console.log(`[poller] Booking approval poller started — every ${INTERVAL_MS / 1000}s, pros: ${PRO_IDS.length} (HCP notes + ops SMS)`);
await tick();
setInterval(() => { void tick(); }, INTERVAL_MS);
