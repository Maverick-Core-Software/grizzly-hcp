import { TwilioServerlessApiClient } from '@twilio-labs/serverless-api';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertApply, isApply, isEntryPoint, loadC0Env, printSafe, required, safeFailureMessage, upsertC0EnvAtomically, valueOr, writeEvidence, type Env } from './lib.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const FUNCTIONS_SERVICE_NAME = 'grizzly-c0-canary';
export const FUNCTIONS_ENVIRONMENT = 'production';

export type FunctionsDeployer = { deployLocalProject: (config: any) => Promise<{ serviceSid: string; environmentSid: string; domain: string }> };

export function functionContext(env: Env): Record<string, string> {
  const transport = valueOr(env, 'VOICE_C0_SIP_TRANSPORT', 'tcp').toLowerCase();
  if (!['tcp', 'tls'].includes(transport)) throw new Error('VOICE_C0_SIP_TRANSPORT must be tcp or tls');
  return {
    C0_ALLOWED_CALLERS: required(env, 'VOICE_C0_ALLOWED_CALLERS'),
    C0_SYNC_SERVICE_SID: required(env, 'VOICE_C0_SYNC_SERVICE_SID'),
    C0_LIVEKIT_SIP_HOST: required(env, 'VOICE_C0_LIVEKIT_SIP_HOST'),
    C0_SIP_USERNAME: required(env, 'VOICE_C0_SIP_USERNAME'),
    C0_SIP_PASSWORD: required(env, 'VOICE_C0_SIP_PASSWORD'),
    C0_CANARY_DID: required(env, 'VOICE_C0_CANARY_DID'),
    C0_DIAL_TIMEOUT_S: '20',
    C0_TIME_LIMIT_S: '480',
    C0_SIP_TRANSPORT: transport,
    C0_SIP_SECURE: transport === 'tls' ? 'true' : 'false',
    C0_OFFICE_NUMBER: required(env, 'VOICE_C0_OFFICE_NUMBER'),
    C0_BACKUP_NUMBER: required(env, 'VOICE_C0_BACKUP_NUMBER'),
    C0_NTFY_TOPIC: required(env, 'VOICE_C0_NTFY_TOPIC'),
  };
}

function functionBaseUrl(domain: string): string {
  return domain.startsWith('https://') ? domain.replace(/\/$/, '') : `https://${domain.replace(/\/$/, '')}`;
}

export async function deployFunctions(deployer: FunctionsDeployer, env: Env, apply: boolean, writeEnv: (values: Record<string, string>) => Promise<void>) {
  const context = functionContext(env);
  if (!apply) return { dryRun: true, serviceName: FUNCTIONS_SERVICE_NAME, environment: FUNCTIONS_ENVIRONMENT, contextNames: Object.keys(context).sort() };
  const accountSid = required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID');
  const authToken = required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN');
  const result = await deployer.deployLocalProject({
    accountSid, authToken, cwd: resolve(SCRIPT_DIR, '..', 'twilio-functions'), envPath: resolve(SCRIPT_DIR, '..', '.env.c0'), env: context,
    serviceName: FUNCTIONS_SERVICE_NAME, functionsEnv: FUNCTIONS_ENVIRONMENT, overrideExistingService: true, runtime: 'node22',
    pkgJson: { dependencies: { twilio: '6.0.2' } },
  });
  const base = functionBaseUrl(result.domain);
  await writeEnv({ VOICE_C0_INGRESS_URL: `${base}/ingress`, VOICE_C0_FALLBACK_URL: `${base}/fallback` });
  return { dryRun: false, serviceSid: result.serviceSid, environmentSid: result.environmentSid, ingressUrl: `${base}/ingress`, fallbackUrl: `${base}/fallback` };
}

async function main(env: Env): Promise<void> {
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const result = await deployFunctions(new TwilioServerlessApiClient({ accountSid: required(env, 'VOICE_C0_TWILIO_ACCOUNT_SID'), authToken: required(env, 'VOICE_C0_TWILIO_AUTH_TOKEN') }), env, apply, upsertC0EnvAtomically);
  await writeEvidence('deploy-functions', result); printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'Functions deployment')); process.exitCode = 1; });
