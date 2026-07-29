/**
 * Booking approval poller — PM2 process `booking-approval-poller`.
 *
 * Every BOOKING_POLL_INTERVAL_MS (default 60s): for each pending booking in
 * data/pending-bookings.jsonl, read the estimate's HCP notes (MCP get_job_notes).
 * When Carter or Jaime adds a note starting with SCHEDULE, parse the date/time,
 * build the schedule payload from the captured template, and call
 * update_job_schedule — HCP then notifies the customer. Entry → status "scheduled".
 *
 * Approval note format (documented in the booking note itself):
 *   SCHEDULE MM/DD h:mm am - h:mm pm        (current year assumed)
 *   SCHEDULE MM/DD/YYYY h:mm am - h:mm pm
 * Times are server-local (America/Chicago — the PC runs Central).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getJobNotes, updateJobSchedule } from '../../hcp/mcp-client.js';
import { buildSchedulePayload } from '../../hcp/schedule-payload.js';
import { updateEstimateNotes } from '../../hcp/estimates.js';

const PENDING_FILE = path.resolve(process.cwd(), 'data/pending-bookings.jsonl');
const INTERVAL_MS = Number(process.env.BOOKING_POLL_INTERVAL_MS ?? 60000);
// update_job_schedule needs numeric pro ids, not the "pro_..." uuids used for dispatch
// (assignTechnician) — see src/hcp/schedule-payload.ts for the captured contract.
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
  [k: string]: unknown;
}

const SCHEDULE_RE =
  /^\s*SCHEDULE\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*(?:-|to)\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/im;

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

function to24h(h: number, ampm: string): number {
  const hh = h % 12;
  return ampm.toLowerCase() === 'pm' ? hh + 12 : hh;
}

function parseScheduleNote(text: string): { start: Date; end: Date } | null {
  const m = text.match(SCHEDULE_RE);
  if (!m) return null;
  const [, moS, dayS, yearS, h1S, m1S, ap1, h2S, m2S, ap2] = m;
  const year = yearS ? Number(yearS) : new Date().getFullYear();
  const month = Number(moS) - 1;
  const day = Number(dayS);
  const start = new Date(year, month, day, to24h(Number(h1S), ap1), Number(m1S));
  const end = new Date(year, month, day, to24h(Number(h2S), ap2), Number(m2S));
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null;
  return { start, end };
}

/**
 * ISO 8601 with an explicit local UTC offset (e.g. "...-05:00"), matching the format
 * HCP's own update_schedule request uses. Date.toISOString() always emits "Z"/UTC,
 * which rolls the calendar date forward for any Central evening time — wrong for the
 * start_date field HCP derives from this. Relies on the process running in
 * America/Chicago (documented assumption for this poller).
 */
function toOffsetIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

async function tick() {
  const all = readPending();
  let changed = false;

  for (const booking of all) {
    if (booking.status !== 'pending') continue;
    try {
      const raw = await getJobNotes(booking.estimateUuid);
      const noteTexts = extractNoteTexts(raw).filter((t) => !t.includes('MAVERICK'));
      const scheduleNote = noteTexts.find((t) => SCHEDULE_RE.test(t));
      if (!scheduleNote) continue;

      const parsed = parseScheduleNote(scheduleNote);
      if (!parsed) {
        console.error(`[poller] ${booking.estimateUuid}: SCHEDULE note found but unparseable: ${scheduleNote.slice(0, 80)}`);
        continue;
      }

      const payload = buildSchedulePayload(
        String(booking.estimateId),
        toOffsetIso(parsed.start),
        toOffsetIso(parsed.end),
        PRO_IDS
      );
      await updateJobSchedule(String(booking.estimateId), payload);
      booking.status = 'scheduled';
      booking.scheduledStart = parsed.start.toISOString();
      booking.scheduledEnd = parsed.end.toISOString();
      booking.scheduledAt = new Date().toISOString();
      changed = true;
      console.log(`[poller] ✅ Scheduled ${booking.customerName} (${booking.estimateUuid}) ${parsed.start.toLocaleString()}`);

      try {
        await updateEstimateNotes(
          booking.estimateUuid,
          `✅ MAVERICK: scheduled ${parsed.start.toLocaleString('en-US', { timeZone: 'America/Chicago' })} – ${parsed.end.toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })}. HCP will notify the customer.`
        );
      } catch (e) {
        console.error(`[poller] confirmation note failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    } catch (e) {
      console.error(`[poller] ${booking.estimateUuid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (changed) writePending(all);
}

console.log(`[poller] Booking approval poller started — every ${INTERVAL_MS / 1000}s, pros: ${PRO_IDS.length}`);
await tick();
setInterval(() => { void tick(); }, INTERVAL_MS);
