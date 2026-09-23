import path from 'node:path';
import { fileURLToPath } from 'node:url';
import twilio from 'twilio';
import { resolveDetectorRepoRoot } from './data-root.js';
import { DETECTOR_INTERVAL_MS, createDetector, createNodeMarkerFs, loadDetectorConfig, type TwilioCallsClient } from './detector.js';
import { loadDetectorEnv, type C0Env } from './env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveDetectorRepoRoot(here);
const env = loadDetectorEnv(path.resolve(here, '../../.env.c0'));

function createClient(env: C0Env): TwilioCallsClient | null {
  const accountSid = env.VOICE_C0_TWILIO_ACCOUNT_SID;
  if (!accountSid) return null;
  if (env.VOICE_C0_TWILIO_API_KEY_SID && env.VOICE_C0_TWILIO_API_KEY_SECRET) {
    return twilio(env.VOICE_C0_TWILIO_API_KEY_SID, env.VOICE_C0_TWILIO_API_KEY_SECRET, { accountSid }) as unknown as TwilioCallsClient;
  }
  if (!env.VOICE_C0_TWILIO_AUTH_TOKEN) return null;
  return twilio(accountSid, env.VOICE_C0_TWILIO_AUTH_TOKEN) as unknown as TwilioCallsClient;
}

const config = loadDetectorConfig(env, repoRoot);
const detector = createDetector(config, {
  client: config.enabled ? createClient(env) : null,
  clock: () => new Date(),
  markerFs: createNodeMarkerFs(),
  fetchImpl: fetch as never,
  log: (line) => console.log(line),
});

void detector.tick();
setInterval(() => { void detector.tick(); }, DETECTOR_INTERVAL_MS);
console.log('[c0-detector] outbound detector started');
