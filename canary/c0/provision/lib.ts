import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

export type Env = Record<string, string | undefined>;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const C0_ENV_KEY = /^(VOICE_C0_|VOICE_OUTBOX_)/;

const SECRET_KEY = /(secret|token|password|auth|api[_-]?key)/i;

export function scriptEnvPath(): string {
  return resolve(SCRIPT_DIR, '..', '.env.c0');
}

/**
 * Parses the C0-only configuration into an isolated object. Inherited process
 * values are inspected solely to reject conflicting C0/Outbox values; they
 * never supply configuration to a provisioning action.
 */
export function parseC0Env(source: string, inherited: NodeJS.ProcessEnv = process.env): Env {
  const parsed = dotenv.parse(source);
  const env: Env = Object.fromEntries(Object.entries(parsed).filter(([name]) => C0_ENV_KEY.test(name)));
  for (const [name, inheritedValue] of Object.entries(inherited)) {
    if (C0_ENV_KEY.test(name) && inheritedValue !== env[name]) {
      throw new Error(`Refusing inherited canary configuration conflict: ${name}`);
    }
  }
  return env;
}

/** The only configuration file these scripts ever load. */
export function loadC0Env(envPath: string = scriptEnvPath(), inherited: NodeJS.ProcessEnv = process.env): Env {
  try {
    return parseC0Env(readFileSync(envPath, 'utf8'), inherited);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing inherited canary configuration conflict:')) throw error;
    throw new Error('Unable to load canary/c0/.env.c0');
  }
}

export function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required canary configuration: ${name}`);
  return value;
}

export function valueOr(env: Env, name: string, fallback: string): string {
  return env[name]?.trim() || fallback;
}

export function mask(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.length <= 8 ? '[masked]' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function maskPhone(value: string | undefined): string | undefined {
  if (!value) return value;
  const digits = value.replace(/\D/g, '');
  return digits.length < 8 ? '[masked]' : `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (/(sid|id)$/i.test(key) && typeof value === 'string') return mask(value);
  // Protobuf Duration fields use bigint seconds. Evidence and CLI output must
  // stay JSON serializable even when a provider object reaches this boundary.
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export const CANONICAL_C0_ENV = [
  'VOICE_C0_TWILIO_ACCOUNT_SID', 'VOICE_C0_TWILIO_AUTH_TOKEN', 'VOICE_C0_TWILIO_API_KEY_SID', 'VOICE_C0_TWILIO_API_KEY_SECRET', 'VOICE_C0_SYNC_SERVICE_SID',
  'VOICE_C0_CANARY_DID', 'VOICE_C0_CANARY_NUMBER_SID', 'VOICE_C0_INGRESS_URL', 'VOICE_C0_FALLBACK_URL',
  'VOICE_C0_LIVEKIT_URL', 'VOICE_C0_LIVEKIT_API_KEY', 'VOICE_C0_LIVEKIT_API_SECRET', 'VOICE_C0_LIVEKIT_SIP_HOST', 'VOICE_C0_LIVEKIT_TRUNK_ID', 'VOICE_C0_LIVEKIT_RULE_ID', 'VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION',
  'VOICE_C0_SIP_USERNAME', 'VOICE_C0_SIP_PASSWORD', 'VOICE_C0_SIP_TRANSPORT', 'VOICE_C0_OPENAI_API_KEY', 'VOICE_C0_ALLOWED_CALLERS', 'VOICE_C0_OFFICE_NUMBER', 'VOICE_C0_BACKUP_NUMBER', 'VOICE_C0_NTFY_TOPIC', 'VOICE_C0_ENABLED', 'VOICE_C0_ALLOWLIST',
] as const;

export function sha256(value: string | undefined): string {
  return createHash('sha256').update(value ?? '').digest('hex');
}

export function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function isEntryPoint(moduleUrl: string): boolean {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === moduleUrl;
}

export function isApply(argv: string[]): boolean {
  return argv.includes('--apply');
}

export function assertApply(argv: string[]): void {
  if (!isApply(argv)) throw new Error('Refusing to mutate without --apply (dry-run is the default)');
}

export async function writeEvidence(script: string, evidence: Record<string, unknown>, baseDir = SCRIPT_DIR): Promise<string> {
  const evidenceDir = resolve(baseDir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(evidenceDir, `${stamp}-${script}.json`);
  await writeFile(path, `${JSON.stringify(redact(evidence), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

/**
 * Used only by the explicitly applied restricted-key script.  It reads and
 * writes the canary-only file, replaces named lines, then atomically renames
 * the fully written temporary file.  No value is logged or included in evidence.
 */
export async function upsertC0EnvAtomically(values: Record<string, string>, envPath = scriptEnvPath()): Promise<void> {
  let existing = '';
  try { existing = await readFile(envPath, 'utf8'); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const remaining = existing.split(/\r?\n/).filter((line) => !Object.keys(values).some((key) => line.startsWith(`${key}=`)));
  const body = [...remaining.filter(Boolean), ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ''].join('\n');
  const temporary = `${envPath}.${process.pid}.tmp`;
  await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, envPath);
}

export function printSafe(value: unknown): void {
  console.log(JSON.stringify(redact(value)));
}

/** Provider error bodies can echo credentials; CLI diagnostics never do. */
export function safeFailureMessage(_error: unknown, operation: string): string {
  return `${operation} failed; provider diagnostics were intentionally not printed`;
}

export type TwilioNumber = Record<string, any>;
const ROUTE_SNAPSHOT_FIELDS = [
  ['voice_url', 'voiceUrl'], ['voice_method', 'voiceMethod'], ['voice_fallback_url', 'voiceFallbackUrl'], ['voice_fallback_method', 'voiceFallbackMethod'], ['voice_application_sid', 'voiceApplicationSid'], ['trunk_sid', 'trunkSid'],
  ['sms_url', 'smsUrl'], ['sms_method', 'smsMethod'], ['sms_fallback_url', 'smsFallbackUrl'], ['sms_fallback_method', 'smsFallbackMethod'], ['sms_application_sid', 'smsApplicationSid'],
] as const;

export function routeSnapshot(number: TwilioNumber): Record<string, unknown> {
  return Object.fromEntries(ROUTE_SNAPSHOT_FIELDS.map(([wireName, sdkName]) => [wireName, number[sdkName] ?? null]));
}

export function assertCanaryRouteTarget(number: TwilioNumber, canaryDid: string): void {
  if (number.phoneNumber !== canaryDid) throw new Error('Refusing to route a number other than VOICE_C0_CANARY_DID');
  if (number.trunkSid || number.voiceApplicationSid) throw new Error('Refusing to route a trunk- or application-attached number');
  if (String(number.voiceMethod || '').toUpperCase() !== 'POST') throw new Error('Refusing to change voice_method; canary number must already use POST');
}

export function assertOnlyVoiceUrlChanged(before: Record<string, unknown>, after: Record<string, unknown>): void {
  const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
  if (changed.length !== 1 || changed[0] !== 'voice_url') throw new Error(`Unsafe route update: expected only voice_url to change, saw ${changed.join(', ') || 'none'}`);
}
