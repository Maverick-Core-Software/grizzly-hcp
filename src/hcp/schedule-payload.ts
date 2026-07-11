/**
 * Builds the schedule_data body for the MCP update_job_schedule tool from a captured
 * template. HCP's /pro/requests/react/{id}/update_schedule payload is undocumented, so
 * the real shape is captured once via `npm run intercept` into
 * data/schedule-payload-template.json with three tokens:
 *   %START_ISO%   → job start, ISO string (server-local Central time offset)
 *   %END_ISO%     → job end, ISO string
 *   "%PRO_UUIDS%" → JSON array of assigned pro uuids (quoted token, replaced whole)
 */
import fs from 'fs';
import path from 'path';

const TEMPLATE_PATH = path.resolve(process.cwd(), 'data/schedule-payload-template.json');

export function buildSchedulePayload(
  startIso: string,
  endIso: string,
  proUuids: string[]
): Record<string, unknown> {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  if (raw.includes('_UNCAPTURED')) {
    throw new Error(
      'schedule-payload-template.json has not been captured yet — run `npm run intercept`, ' +
      'schedule one job manually in HCP, and paste the captured update_schedule body into the template. ' +
      'See PLAN.md Manual Ops Checklist item 1.'
    );
  }
  const filled = raw
    .replaceAll('%START_ISO%', startIso)
    .replaceAll('%END_ISO%', endIso)
    .replaceAll('"%PRO_UUIDS%"', JSON.stringify(proUuids));
  return JSON.parse(filled) as Record<string, unknown>;
}
