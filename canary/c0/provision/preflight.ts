import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_C0_ENV, isEntryPoint, loadC0Env, parseFlag, printSafe, safeFailureMessage, valueOr, writeEvidence, type Env } from './lib.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PREFLIGHT_STAGES = ['inventory', 'functions', 'livekit', 'agent', 'enable'] as const;
export type PreflightStage = typeof PREFLIGHT_STAGES[number];

const REQUIRED: Record<PreflightStage, readonly string[]> = {
  inventory: ['VOICE_C0_TWILIO_ACCOUNT_SID', 'VOICE_C0_TWILIO_AUTH_TOKEN'],
  functions: ['VOICE_C0_TWILIO_ACCOUNT_SID', 'VOICE_C0_TWILIO_AUTH_TOKEN', 'VOICE_C0_SYNC_SERVICE_SID', 'VOICE_C0_CANARY_DID', 'VOICE_C0_CANARY_NUMBER_SID', 'VOICE_C0_LIVEKIT_SIP_HOST', 'VOICE_C0_SIP_USERNAME', 'VOICE_C0_SIP_PASSWORD', 'VOICE_C0_ALLOWED_CALLERS', 'VOICE_C0_OFFICE_NUMBER', 'VOICE_C0_BACKUP_NUMBER', 'VOICE_C0_NTFY_TOPIC'],
  livekit: ['VOICE_C0_LIVEKIT_URL', 'VOICE_C0_LIVEKIT_API_KEY', 'VOICE_C0_LIVEKIT_API_SECRET', 'VOICE_C0_CANARY_DID', 'VOICE_C0_SIP_USERNAME', 'VOICE_C0_SIP_PASSWORD', 'VOICE_C0_ALLOWED_CALLERS'],
  agent: ['VOICE_C0_TWILIO_API_KEY_SID', 'VOICE_C0_TWILIO_API_KEY_SECRET', 'VOICE_C0_LIVEKIT_URL', 'VOICE_C0_LIVEKIT_API_KEY', 'VOICE_C0_LIVEKIT_API_SECRET', 'VOICE_C0_LIVEKIT_TRUNK_ID', 'VOICE_C0_LIVEKIT_RULE_ID', 'VOICE_C0_OPENAI_API_KEY', 'VOICE_C0_NTFY_TOPIC', 'VOICE_C0_ENABLED', 'VOICE_C0_ALLOWLIST'],
  enable: CANONICAL_C0_ENV,
};

const E164 = /^\+[1-9]\d{7,14}$/;
const CSV_E164 = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean).length > 0 && value.split(',').map((item) => item.trim()).filter(Boolean).every((item) => E164.test(item));

export function validateCanonical(name: string, value: string | undefined): boolean {
  if (!value) return ['VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION', 'VOICE_C0_SIP_TRANSPORT'].includes(name);
  switch (name) {
    case 'VOICE_C0_TWILIO_ACCOUNT_SID': return /^AC[a-f\d]{32}$/i.test(value);
    case 'VOICE_C0_TWILIO_AUTH_TOKEN': return /^[a-f\d]{32}$/i.test(value);
    case 'VOICE_C0_TWILIO_API_KEY_SID': return /^SK[a-f\d]{32}$/i.test(value);
    case 'VOICE_C0_TWILIO_API_KEY_SECRET': return /^[A-Za-z\d_-]{24,}$/.test(value);
    case 'VOICE_C0_SYNC_SERVICE_SID': return /^IS[a-f\d]{32}$/i.test(value);
    case 'VOICE_C0_CANARY_DID': case 'VOICE_C0_OFFICE_NUMBER': case 'VOICE_C0_BACKUP_NUMBER': return E164.test(value);
    case 'VOICE_C0_CANARY_NUMBER_SID': return /^PN[a-f\d]{32}$/i.test(value);
    case 'VOICE_C0_ALLOWED_CALLERS': case 'VOICE_C0_ALLOWLIST': return CSV_E164(value);
    case 'VOICE_C0_INGRESS_URL': case 'VOICE_C0_FALLBACK_URL': return /^https:\/\/[^\s]+\/(ingress|fallback)(?:[/?].*)?$/i.test(value);
    case 'VOICE_C0_LIVEKIT_URL': return /^wss:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(value);
    case 'VOICE_C0_LIVEKIT_API_KEY': return /^API[A-Za-z\d_-]{8,}$/.test(value);
    case 'VOICE_C0_LIVEKIT_API_SECRET': return /^[A-Za-z\d_-]{24,}$/.test(value);
    case 'VOICE_C0_LIVEKIT_SIP_HOST': return /^[a-z\d](?:[a-z\d.-]*[a-z\d])?(?::\d{1,5})?$/i.test(value);
    case 'VOICE_C0_LIVEKIT_TRUNK_ID': return /^ST_[A-Za-z0-9]{6,64}$/.test(value);
    case 'VOICE_C0_LIVEKIT_RULE_ID': return /^SDR_[A-Za-z0-9]{6,64}$/.test(value);
    case 'VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION': return ['SIP_MEDIA_ENCRYPT_ALLOW', 'SIP_MEDIA_ENCRYPT_REQUIRE', 'SIP_MEDIA_ENCRYPT_DISABLE'].includes(value);
    case 'VOICE_C0_SIP_USERNAME': return /^c0-[a-f\d]{24}$/i.test(value);
    case 'VOICE_C0_SIP_PASSWORD': return /^[A-Za-z\d_-]{40,}$/.test(value);
    case 'VOICE_C0_SIP_TRANSPORT': return ['tcp', 'tls'].includes(value.toLowerCase());
    case 'VOICE_C0_OPENAI_API_KEY': return /^sk-[A-Za-z\d_-]{16,}$/.test(value);
    case 'VOICE_C0_NTFY_TOPIC': return /^[A-Za-z\d._-]{1,64}$/.test(value);
    case 'VOICE_C0_ENABLED': return ['true', 'false'].includes(value);
    default: return false;
  }
}

export function parseStage(value: string | undefined): PreflightStage {
  if (!value || !PREFLIGHT_STAGES.includes(value as PreflightStage)) throw new Error('Usage: --stage inventory|functions|livekit|agent|enable');
  return value as PreflightStage;
}

export type PreflightRuntime = { nodeVersion: string; pm2OnPath: () => boolean; envIgnored: () => boolean };
export const localRuntime: PreflightRuntime = {
  nodeVersion: process.versions.node,
  pm2OnPath: () => { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pm2'], { stdio: 'ignore' }); return true; } catch { return false; } },
  envIgnored: () => { try { execFileSync('git', ['check-ignore', '-q', 'canary/c0/.env.c0'], { cwd: resolve(SCRIPT_DIR, '..', '..', '..'), stdio: 'ignore' }); return true; } catch { return false; } },
};

export function preflight(env: Env, stage: PreflightStage, runtime: PreflightRuntime = localRuntime) {
  const variables = Object.fromEntries(CANONICAL_C0_ENV.map((name) => {
    const present = Boolean(env[name]);
    return [name, { present, missing: !present, formatValid: validateCanonical(name, env[name]), defaultApplied: !present && (name === 'VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION' || name === 'VOICE_C0_SIP_TRANSPORT') }];
  }));
  const requiredNames = REQUIRED[stage];
  const missingOrInvalid = requiredNames.filter((name) => {
    const status = variables[name as keyof typeof variables];
    return (!status.present && !status.defaultApplied) || !status.formatValid;
  });
  return { pass: missingOrInvalid.length === 0 && runtime.envIgnored(), stage, requiredNames, missingOrInvalid, variables, defaults: { VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION: valueOr(env, 'VOICE_C0_LIVEKIT_MEDIA_ENCRYPTION', 'SIP_MEDIA_ENCRYPT_ALLOW') === 'SIP_MEDIA_ENCRYPT_ALLOW' ? 'applied-or-configured' : 'configured', VOICE_C0_SIP_TRANSPORT: valueOr(env, 'VOICE_C0_SIP_TRANSPORT', 'tcp') === 'tcp' ? 'applied-or-configured' : 'configured' }, nodeVersion: runtime.nodeVersion, pm2OnPath: runtime.pm2OnPath(), envGitIgnored: runtime.envIgnored() };
}

async function main(env: Env): Promise<void> {
  const result = preflight(env, parseStage(parseFlag(process.argv, '--stage')));
  await writeEvidence('preflight', result); printSafe(result);
  if (!result.pass) process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'preflight')); process.exitCode = 1; });
