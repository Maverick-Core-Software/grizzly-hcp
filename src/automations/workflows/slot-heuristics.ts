/** Jobs that need a board slot (no start time, active pipeline). */
export function needsScheduling(row: {
  schedule_start: string | null;
  work_status: string;
}): boolean {
  if (row.schedule_start) return false;
  const s = row.work_status.toLowerCase();
  if (s.includes('complete') || s.includes('cancel')) return false;
  if (s.includes('estimate') && !s.includes('needs scheduling')) return false;
  return s === 'needs scheduling' || s.includes('needs scheduling') || s === 'scheduled';
}

export type SlotWindow = { label: string; day: string; startIso: string; endIso: string };

const TZ = 'America/Chicago';

function ctDateParts(d: Date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), label: fmt.format(d) };
}

function makeWindow(day: Date, hourStart: number, durationHours: number): SlotWindow {
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const d = day.getUTCDate();
  // Approximate CT as UTC-5 (POC; DST edge cases acceptable for demo)
  const start = new Date(Date.UTC(y, m, d, hourStart + 5, 0, 0));
  const end = new Date(start.getTime() + durationHours * 3600000);
  const { label } = ctDateParts(day);
  const ampm = hourStart < 12 ? '9–11 AM' : '1–3 PM';
  return {
    label: `${label} ${ampm}`,
    day: label,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

/** Heuristic: 2–3 low-load weekday windows in the next 7 business days. */
export function proposeSlots(
  scheduledStarts: string[],
  count = 3,
): SlotWindow[] {
  const load = new Map<string, number>();
  for (const iso of scheduledStarts) {
    if (!iso) continue;
    const d = new Date(iso);
    const key = d.toISOString().slice(0, 10);
    load.set(key, (load.get(key) ?? 0) + 1);
  }

  const candidates: { day: Date; load: number }[] = [];
  const cursor = new Date();
  cursor.setUTCHours(12, 0, 0, 0);

  for (let i = 0; i < 21 && candidates.length < 14; i++) {
    const d = new Date(cursor);
    d.setUTCDate(cursor.getUTCDate() + i);
    const wd = d.getUTCDay();
    if (wd === 0) continue; // skip Sunday POC
    const key = d.toISOString().slice(0, 10);
    candidates.push({ day: d, load: load.get(key) ?? 0 });
  }

  candidates.sort((a, b) => a.load - b.load);
  const pickedDays = candidates.slice(0, Math.ceil(count / 2));
  const slots: SlotWindow[] = [];
  for (const { day } of pickedDays) {
    if (slots.length < count) slots.push(makeWindow(day, 9, 2));
    if (slots.length < count) slots.push(makeWindow(day, 13, 2));
  }
  return slots.slice(0, count);
}

export function draftScheduleSms(
  customerName: string,
  jobLabel: string,
  slots: SlotWindow[],
): string {
  const first = customerName.split(' ')[0] || 'there';
  const opts = slots.map((s) => s.label).join(' or ');
  return (
    `Hi ${first}, Grizzly Electrical here — ready to get "${jobLabel.slice(0, 60)}" on the calendar. ` +
    `We have ${opts}. Which works best? Reply with your pick or call (469) 863-9804.`
  );
}