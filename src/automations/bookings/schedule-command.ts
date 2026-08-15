/**
 * Shared SCHEDULE command parsing for HCP notes and ops-SMS replies.
 *
 * Formats (America/Chicago assumed by the poller process):
 *   SCHEDULE MM/DD h:mm am - h:mm pm
 *   SCHEDULE MM/DD/YYYY h:mm am - h:mm pm
 *   SCHEDULE <estimateId> MM/DD h:mm am - h:mm pm
 *   SCHEDULE #<estimateId> MM/DD h:mm am - h:mm pm
 */

export const SCHEDULE_WITH_ID_RE =
  /^\s*SCHEDULE\s+#?(\d{5,12})\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*(?:-|to)\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/im;

export const SCHEDULE_NO_ID_RE =
  /^\s*SCHEDULE\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*(?:-|to)\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/im;

/** Detect any SCHEDULE line (for HCP note scanning). */
export const SCHEDULE_ANY_RE =
  /^\s*SCHEDULE\s+/im;

export type ParsedScheduleCommand = {
  estimateId?: number;
  start: Date;
  end: Date;
  raw: string;
};

function to24h(h: number, ampm: string): number {
  const hh = h % 12;
  return ampm.toLowerCase() === 'pm' ? hh + 12 : hh;
}

function buildRange(
  moS: string,
  dayS: string,
  yearS: string | undefined,
  h1S: string,
  m1S: string,
  ap1: string,
  h2S: string,
  m2S: string,
  ap2: string,
): { start: Date; end: Date } | null {
  const year = yearS ? Number(yearS) : new Date().getFullYear();
  const month = Number(moS) - 1;
  const day = Number(dayS);
  const start = new Date(year, month, day, to24h(Number(h1S), ap1), Number(m1S));
  const end = new Date(year, month, day, to24h(Number(h2S), ap2), Number(m2S));
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null;
  return { start, end };
}

/**
 * Parse a single SCHEDULE command string.
 * Returns null if the text is not a valid schedule command.
 */
export function parseScheduleCommand(text: string): ParsedScheduleCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const withId = trimmed.match(SCHEDULE_WITH_ID_RE);
  if (withId) {
    const [, idS, moS, dayS, yearS, h1S, m1S, ap1, h2S, m2S, ap2] = withId;
    const range = buildRange(moS, dayS, yearS, h1S, m1S, ap1, h2S, m2S, ap2);
    if (!range) return null;
    return { estimateId: Number(idS), start: range.start, end: range.end, raw: withId[0].trim() };
  }

  const noId = trimmed.match(SCHEDULE_NO_ID_RE);
  if (noId) {
    const [, moS, dayS, yearS, h1S, m1S, ap1, h2S, m2S, ap2] = noId;
    const range = buildRange(moS, dayS, yearS, h1S, m1S, ap1, h2S, m2S, ap2);
    if (!range) return null;
    return { start: range.start, end: range.end, raw: noId[0].trim() };
  }

  return null;
}

/**
 * ISO 8601 with an explicit local UTC offset (e.g. "...-05:00").
 * Date.toISOString() always emits Z and rolls Central evening dates forward.
 */
export function toOffsetIso(date: Date): string {
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

/** Short ops-SMS reply recipe for a pending booking. */
export function formatScheduleReplyHint(estimateId: number | string): string {
  return `Reply: SCHEDULE ${estimateId} MM/DD h:mm am - h:mm pm`;
}
