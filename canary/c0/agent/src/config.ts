import dotenv from 'dotenv';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CANARY_ENV_FILE = new URL('../../.env.c0', import.meta.url);
export interface CanaryRuntimeConfig { readonly c0Env:Record<string,string>; readonly twilioAccountSid:string; readonly twilioApiKeySid:string; readonly twilioApiKeySecret:string; readonly livekitUrl:string; readonly livekitApiKey:string; readonly livekitApiSecret:string; readonly openaiApiKey:string; readonly fallbackUrl:string; readonly syncServiceSid:string; readonly dataDir:string|null; readonly mappingPath:string|null; readonly enabled:boolean; readonly trunkId:string; readonly ruleId:string; readonly callerAllowlist:readonly string[]; readonly rehearsalSilentStart:boolean; }
export type EnvReader = (path:string, encoding:'utf8') => string;
function required(env: Record<string,string>, name:string): string { const value=env[name]?.trim(); if(!value) throw new Error(`c0_env_missing_${name}`); return value; }
function allowlist(env:Record<string,string>):readonly string[] { const values=required(env,'VOICE_C0_ALLOWLIST').split(',').map(x=>x.trim()).filter(Boolean); if(!values.length||values.some(x=>!/^\+[1-9]\d{7,14}$/.test(x))) throw new Error('c0_env_invalid_VOICE_C0_ALLOWLIST'); return values; }
/** Parses only canary/c0/.env.c0; inherited values are comparison-only poison detection. */
export function loadCanaryRuntimeConfig(inherited:NodeJS.ProcessEnv=process.env, readFile:EnvReader=fs.readFileSync):CanaryRuntimeConfig {
  let env:Record<string,string>; try { env=dotenv.parse(readFile(fileURLToPath(CANARY_ENV_FILE),'utf8')); } catch { throw new Error('c0_env_file_missing'); }
  for(const [name,value] of Object.entries(inherited)) if((name.startsWith('VOICE_C0_')||name.startsWith('VOICE_OUTBOX_'))&&env[name]!==value) throw new Error(`c0_env_inherited_conflict_${name}`);
  return { c0Env:env,twilioAccountSid:required(env,'VOICE_C0_TWILIO_ACCOUNT_SID'),twilioApiKeySid:required(env,'VOICE_C0_TWILIO_API_KEY_SID'),twilioApiKeySecret:required(env,'VOICE_C0_TWILIO_API_KEY_SECRET'),livekitUrl:required(env,'VOICE_C0_LIVEKIT_URL'),livekitApiKey:required(env,'VOICE_C0_LIVEKIT_API_KEY'),livekitApiSecret:required(env,'VOICE_C0_LIVEKIT_API_SECRET'),openaiApiKey:required(env,'VOICE_C0_OPENAI_API_KEY'),fallbackUrl:required(env,'VOICE_C0_FALLBACK_URL'),syncServiceSid:required(env,'VOICE_C0_SYNC_SERVICE_SID'),dataDir:env.VOICE_C0_DATA_DIR?.trim()||null,mappingPath:env.VOICE_C0_MAPPING_PATH?.trim()||null,enabled:env.VOICE_C0_ENABLED==='true',trunkId:required(env,'VOICE_C0_LIVEKIT_TRUNK_ID'),ruleId:required(env,'VOICE_C0_LIVEKIT_RULE_ID'),callerAllowlist:allowlist(env),rehearsalSilentStart:env.VOICE_C0_REHEARSAL_SILENT_START==='true' };
}
