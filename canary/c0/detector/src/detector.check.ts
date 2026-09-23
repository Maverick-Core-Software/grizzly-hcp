import assert from 'node:assert/strict';
import path from 'node:path';
import { createDetector, type Marker, type MarkerFs, type TwilioCallsClient } from './detector.js';
import { fakeSid } from './fake-fixtures.js';

const now = new Date('2026-09-22T15:00:10.000Z');
const callSid = fakeSid('CA');
const syncServiceSid = fakeSid('IS');

function fakeMarkers(entries: Record<string, Marker>): MarkerFs & { readonly writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    readMarker(filePath) { return entries[filePath] ?? { exists: false, mtimeMs: null }; },
    writeRedirectMarker(filePath) {
      if (entries[filePath]?.exists) throw new Error('already marked');
      entries[filePath] = { exists: true, mtimeMs: now.getTime() };
      writes.push(filePath);
    },
  };
}

function clientFor(
  sids: readonly string[],
  redirects: string[],
  events: string[],
  syncFails: boolean = false,
): TwilioCallsClient {
  const calls = Object.assign(
    (sid: string) => ({ update: async ({ url }: { url: string }) => { events.push('redirect'); redirects.push(`${sid}:${url}`); } }),
    { list: async () => sids.map((sid) => ({ sid })) },
  );
  return {
    calls,
    sync: {
      v1: {
        services: () => ({
          documents: {
            create: async ({ uniqueName, data, ttl }) => {
              events.push('flag');
              assert.equal(uniqueName, `c0-transfer-${callSid}`);
              assert.deepEqual(data, { role: 'office', by: 'detector' });
              assert.equal(ttl, 900);
              if (syncFails) throw new Error('sync unavailable');
            },
          },
        }),
      },
    },
  };
}

async function main(): Promise<void> {
  const root = '/c0-data';
  const answered = path.join(root, 'answered', callSid);
  const firstAudio = path.join(root, 'first-audio', callSid);

  // Below-deadline silence and absent answer markers cannot redirect.
  {
    const redirects: string[] = [];
    const events: string[] = [];
    const markers = fakeMarkers({ [answered]: { exists: true, mtimeMs: now.getTime() - 5_999 } });
    const detector = createDetector({ enabled: true, canaryDid: '+15555550100', fallbackUrl: 'https://example.invalid/fallback', ntfyTopic: null, syncServiceSid: null, markerRoot: root }, {
      client: clientFor([callSid], redirects, events), clock: () => now, markerFs: markers, fetchImpl: async () => ({}), log: () => {},
    });
    await detector.tick();
    assert.deepEqual(redirects, [], 'below-deadline silence remains with the agent');
    assert.equal(markers.writes.length, 0);
  }

  // An overdue answered call redirects once even across successive ticks.
  {
    const redirects: string[] = [];
    const alerts: string[] = [];
    const events: string[] = [];
    const markers = fakeMarkers({ [answered]: { exists: true, mtimeMs: now.getTime() - 6_000 } });
    const detector = createDetector({ enabled: true, canaryDid: '+15555550100', fallbackUrl: 'https://example.invalid/fallback', ntfyTopic: 'c0-test', syncServiceSid, markerRoot: root }, {
      client: clientFor([callSid], redirects, events), clock: () => now, markerFs: markers,
      fetchImpl: async (input) => { alerts.push(input); return {}; }, log: () => {},
    });
    assert.equal((await detector.tick()).redirected, 1);
    assert.equal((await detector.tick()).redirected, 0);
    assert.equal(redirects.length, 1, 'one call receives exactly one redirect');
    assert.deepEqual(events, ['flag', 'redirect'], 'transfer intent flag is written before redirect');
    assert.match(redirects[0], /[?&]role=office/, 'detector gives the fallback Function the office role');
    assert.equal(markers.writes.length, 1, 'the persistent attempt marker dedupes restarts');
    assert.equal(alerts.length, 1, 'one redacted alert follows the redirect');
    assert.ok(!alerts[0].includes(callSid), 'the alert request has no call identifier');
  }

  // A Sync outage is redacted and cannot block the human redirect.
  {
    const redirects: string[] = [];
    const events: string[] = [];
    const logs: string[] = [];
    const markers = fakeMarkers({ [answered]: { exists: true, mtimeMs: now.getTime() - 6_000 } });
    const detector = createDetector({ enabled: true, canaryDid: '+15555550100', fallbackUrl: 'https://example.invalid/fallback', ntfyTopic: null, syncServiceSid, markerRoot: root }, {
      client: clientFor([callSid], redirects, events, true), clock: () => now, markerFs: markers, fetchImpl: async () => ({}), log: (line) => logs.push(line),
    });
    await detector.tick();
    assert.deepEqual(events, ['flag', 'redirect'], 'failed Sync attempt still precedes and permits fallback redirect');
    assert.equal(redirects.length, 1);
    assert.ok(logs.some((line) => line.includes('flag write failed')));
  }

  // A future filesystem mtime is clamped to this detector tick, not allowed to
  // delay the fail-closed deadline until an arbitrary future clock value.
  {
    const redirects: string[] = [];
    const events: string[] = [];
    const markers = fakeMarkers({ [answered]: { exists: true, mtimeMs: now.getTime() + 60_000 } });
    let tickNow = now;
    const detector = createDetector({ enabled: true, canaryDid: '+15555550100', fallbackUrl: 'https://example.invalid/fallback', ntfyTopic: null, syncServiceSid: null, markerRoot: root }, {
      client: clientFor([callSid], redirects, events), clock: () => tickNow, markerFs: markers, fetchImpl: async () => ({}), log: () => {},
    });
    await detector.tick();
    tickNow = new Date(now.getTime() + 6_000);
    await detector.tick();
    assert.equal(redirects.length, 1, 'future answered-marker mtime starts the six-second deadline at the current tick');
  }

  // Audio or no answer marker means no action.
  const markerCases: Array<Record<string, Marker>> = [
    { [answered]: { exists: true, mtimeMs: now.getTime() - 60_000 }, [firstAudio]: { exists: true, mtimeMs: now.getTime() - 59_000 } },
    {},
  ];
  for (const entries of markerCases) {
    const redirects: string[] = [];
    const events: string[] = [];
    const detector = createDetector({ enabled: true, canaryDid: '+15555550100', fallbackUrl: 'https://example.invalid/fallback', ntfyTopic: null, syncServiceSid: null, markerRoot: root }, {
      client: clientFor([callSid], redirects, events), clock: () => now, markerFs: fakeMarkers(entries), fetchImpl: async () => ({}), log: () => {},
    });
    await detector.tick();
    assert.deepEqual(redirects, []);
  }

  console.log('detector.check OK');
}

void main();
