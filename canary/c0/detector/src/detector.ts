import fs from 'node:fs';
import path from 'node:path';
import { resolveC0DataRoot } from './data-root.js';
import { FIRST_AUDIO_DEADLINE_MS, firstAudioOverdue } from './policy.js';

export const DETECTOR_INTERVAL_MS = 2_000;
const SAFE_CALL_SID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface TwilioCall {
  readonly sid: string;
}

export interface TwilioCallsClient {
  readonly calls: {
    list(options: { status: 'in-progress'; to: string }): Promise<readonly TwilioCall[]>;
    (callSid: string): { update(options: { url: string }): Promise<unknown> };
  };
  readonly sync: {
    readonly v1: {
      services(serviceSid: string): {
        readonly documents: {
          create(options: { uniqueName: string; data: { role: 'office'; by: 'detector' }; ttl: number }): Promise<unknown>;
        };
      };
    };
  };
}

export interface Marker {
  readonly exists: boolean;
  readonly mtimeMs: number | null;
}

/** Small injectable marker surface; it never reads an environment or network. */
export interface MarkerFs {
  readMarker(filePath: string): Marker;
  writeRedirectMarker(filePath: string): void;
}

export interface DetectorFetch {
  (input: string, init: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<unknown>;
}

export interface DetectorConfig {
  readonly enabled: boolean;
  readonly canaryDid: string | null;
  readonly fallbackUrl: string | null;
  readonly ntfyTopic: string | null;
  readonly syncServiceSid: string | null;
  readonly markerRoot: string;
}

export interface DetectorDeps {
  readonly client: TwilioCallsClient | null;
  readonly clock: () => Date;
  readonly markerFs: MarkerFs;
  readonly fetchImpl: DetectorFetch;
  readonly log: (line: string) => void;
}

export interface DetectorTickResult {
  readonly status: 'disabled' | 'ready' | 'ran';
  readonly callsSeen: number;
  readonly redirected: number;
}

function markerPath(root: string, kind: 'answered' | 'first-audio' | 'redirected', callSid: string): string {
  return path.join(root, kind, callSid);
}

function safeText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function officeFallbackUrl(fallbackUrl: string): string {
  const parsed = new URL(fallbackUrl);
  parsed.searchParams.set('role', 'office');
  return parsed.toString();
}

/** Node implementation intentionally reads marker contents without logging them. */
export function createNodeMarkerFs(): MarkerFs {
  return {
    readMarker(filePath) {
      try {
        const stat = fs.statSync(filePath);
        fs.readFileSync(filePath, 'utf8');
        return { exists: true, mtimeMs: stat.mtimeMs };
      } catch {
        return { exists: false, mtimeMs: null };
      }
    },
    writeRedirectMarker(filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'redirect-attempted\n', { encoding: 'utf8', flag: 'wx' });
    },
  };
}

/**
 * Detector is outbound-only: it only lists Calls, optionally updates one Call,
 * and posts a redacted notification. It creates no listener and does not depend
 * on the LiveKit or agent processes.
 */
export function createDetector(config: DetectorConfig, deps: DetectorDeps) {
  const attempted = new Set<string>();
  const observedAnswerTimes = new Map<string, number>();
  let ticking = false;

  async function notify(title: string): Promise<void> {
    if (!config.ntfyTopic) return;
    try {
      await deps.fetchImpl(`https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`, {
        method: 'POST',
        headers: { Title: title, Priority: 'urgent', Tags: 'warning,telephone_receiver' },
        body: 'C0 detector redirected an overdue canary call to the canary fallback. No caller details are included.',
      });
    } catch {
      deps.log('[c0-detector] redacted ntfy delivery failed');
    }
  }

  async function tick(): Promise<DetectorTickResult> {
    if (!config.enabled) return { status: 'disabled', callsSeen: 0, redirected: 0 };
    if (!config.canaryDid || !config.fallbackUrl || !deps.client) {
      deps.log('[c0-detector] enabled but required canary configuration is absent');
      return { status: 'ready', callsSeen: 0, redirected: 0 };
    }
    if (ticking) return { status: 'ready', callsSeen: 0, redirected: 0 };
    ticking = true;
    try {
      const calls = await deps.client.calls.list({ status: 'in-progress', to: config.canaryDid });
      let redirected = 0;
      for (const call of calls) {
        if (!SAFE_CALL_SID_RE.test(call.sid)) {
          deps.log('[c0-detector] ignored invalid call identifier');
          continue;
        }
        if (attempted.has(call.sid)) continue;

        const redirectedMarker = markerPath(config.markerRoot, 'redirected', call.sid);
        if (deps.markerFs.readMarker(redirectedMarker).exists) {
          attempted.add(call.sid);
          continue;
        }

        const answered = deps.markerFs.readMarker(markerPath(config.markerRoot, 'answered', call.sid));
        const firstAudio = deps.markerFs.readMarker(markerPath(config.markerRoot, 'first-audio', call.sid));
        // The shared first-audio policy is fail-closed for unobservable answer
        // times. The detector's contract is narrower: no answer marker means
        // no proof of SIP answer, therefore no redirect action.
        if (!answered.exists) continue;
        const nowMs = deps.clock().getTime();
        // Filesystem clock skew must not extend a caller's deadline: a future
        // marker begins the six-second window at this detector tick.
        const observedAnswerAtMs = answered.mtimeMs === null ? null : Math.min(answered.mtimeMs, nowMs);
        const answeredAtMs = observedAnswerAtMs === null
          ? null
          : (observedAnswerTimes.get(call.sid) ?? observedAnswerAtMs);
        if (answeredAtMs !== null) observedAnswerTimes.set(call.sid, answeredAtMs);
        if (!firstAudioOverdue({
          answeredAtMs,
          firstAudioAtMs: firstAudio.exists ? firstAudio.mtimeMs : null,
          nowMs,
        }, FIRST_AUDIO_DEADLINE_MS)) continue;

        // Persist the single attempt before crossing the provider boundary.
        try {
          deps.markerFs.writeRedirectMarker(redirectedMarker);
        } catch {
          deps.log('[c0-detector] could not persist redirect attempt marker');
          continue;
        }
        attempted.add(call.sid);
        // Sync is an intent handoff for the Function's fallback path. It must
        // precede the redirect, but it is intentionally best-effort: human
        // fallback is never held hostage by a Sync service outage.
        if (config.syncServiceSid) {
          try {
            await deps.client.sync.v1.services(config.syncServiceSid).documents.create({
              uniqueName: `c0-transfer-${call.sid}`,
              data: { role: 'office', by: 'detector' },
              ttl: 900,
            });
          } catch {
            deps.log('[c0-detector] transfer intent flag write failed; continuing to human fallback');
          }
        } else {
          deps.log('[c0-detector] transfer intent flag service is unavailable; continuing to human fallback');
        }
        try {
          await deps.client.calls(call.sid).update({ url: officeFallbackUrl(config.fallbackUrl) });
          redirected += 1;
          deps.log('[c0-detector] redirected overdue answered canary call');
          await notify('C0 detector redirected overdue call');
        } catch {
          // The marker intentionally remains: a redirect is attempted at most once per call.
          deps.log('[c0-detector] redirect attempt failed; no call or caller detail logged');
          await notify('C0 detector redirect attempt failed');
        }
      }
      return { status: 'ran', callsSeen: calls.length, redirected };
    } finally {
      ticking = false;
    }
  }

  return { tick };
}

export function loadDetectorConfig(env: Readonly<Record<string, string | undefined>>, repoRoot: string = process.cwd()): DetectorConfig {
  return {
    enabled: env.VOICE_C0_ENABLED === 'true',
    canaryDid: safeText(env.VOICE_C0_CANARY_DID),
    fallbackUrl: safeText(env.VOICE_C0_FALLBACK_URL),
    ntfyTopic: safeText(env.VOICE_C0_NTFY_TOPIC),
    syncServiceSid: safeText(env.VOICE_C0_SYNC_SERVICE_SID),
    markerRoot: resolveC0DataRoot(env, repoRoot),
  };
}
