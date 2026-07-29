/**
 * Builds the schedule_data body for the MCP update_job_schedule tool from a captured
 * template. HCP's /pro/requests/react/{id}/update_schedule payload is undocumented, so
 * the real shape was captured once via `npm run intercept` while manually scheduling
 * request 495988914 (Ratzwell Minnis) on 2026-07-29, into
 * data/schedule-payload-template.json, with these tokens:
 *   %START_ISO%    → job start, ISO string (server-local Central time offset)
 *   %END_ISO%      → job end, ISO string
 *   %START_DATE%   → job start date, YYYY-MM-DD, derived from %START_ISO%
 *   "%REQUEST_ID%" → numeric request/job id (quoted token, replaced whole, unquoted output)
 *   "%PRO_IDS%"    → JSON array of assigned pro NUMERIC ids — the captured write uses
 *                    numeric ids (e.g. 722501), NOT the "pro_..." uuids used elsewhere
 *                    (e.g. by assignTechnician) — do not confuse the two.
 */
import fs from 'fs';
import path from 'path';

const TEMPLATE_PATH = path.resolve(process.cwd(), 'data/schedule-payload-template.json');

export function buildSchedulePayload(
  requestId: string,
  startIso: string,
  endIso: string,
  proIds: number[]
): Record<string, unknown> {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  if (raw.includes('_UNCAPTURED')) {
    throw new Error(
      'schedule-payload-template.json has not been captured yet — run `npm run intercept`, ' +
      'schedule one job manually in HCP, and paste the captured update_schedule body into the template. ' +
      'See PLAN.md Manual Ops Checklist item 1.'
    );
  }
  const startDate = startIso.slice(0, 10);
  const filled = raw
    .replaceAll('%START_ISO%', startIso)
    .replaceAll('%END_ISO%', endIso)
    .replaceAll('%START_DATE%', startDate)
    .replaceAll('"%REQUEST_ID%"', String(Number(requestId)))
    .replaceAll('"%PRO_IDS%"', JSON.stringify(proIds));
  return JSON.parse(filled) as Record<string, unknown>;
}
