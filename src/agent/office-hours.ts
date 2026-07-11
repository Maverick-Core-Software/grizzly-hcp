/**
 * Office hours for the Maverick voice line — America/Chicago.
 * Mon–Fri 08:00–18:00, Sat 08:00–14:00, Sun closed (matches the website schema).
 * ponytail: hours are constants here — edit this file to change them.
 */
export function officeStatus(now: Date = new Date()): 'OPEN' | 'CLOSED' {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday');
  const hour = Number(get('hour')) % 24; // some engines report midnight as "24"
  const minutes = hour * 60 + Number(get('minute'));
  if (day === 'Sun') return 'CLOSED';
  if (day === 'Sat') return minutes >= 8 * 60 && minutes < 14 * 60 ? 'OPEN' : 'CLOSED';
  return minutes >= 8 * 60 && minutes < 18 * 60 ? 'OPEN' : 'CLOSED';
}
