import { randomBytes } from 'node:crypto';
import { assertApply, isApply, isEntryPoint, loadC0Env, printSafe, safeFailureMessage, upsertC0EnvAtomically, writeEvidence, type Env } from './lib.js';

export type RandomBytes = (size: number) => Buffer;

export async function generateSipCredentials(env: Env, apply: boolean, writeEnv: (values: Record<string, string>) => Promise<void>, random: RandomBytes = randomBytes) {
  const values: Record<string, string> = {};
  if (!env.VOICE_C0_SIP_USERNAME) values.VOICE_C0_SIP_USERNAME = `c0-${random(12).toString('hex')}`;
  if (!env.VOICE_C0_SIP_PASSWORD) values.VOICE_C0_SIP_PASSWORD = random(36).toString('base64url');
  if (!apply) return { dryRun: true, generated: Object.keys(values).sort() };
  if (Object.keys(values).length) await writeEnv(values);
  return { dryRun: false, generated: Object.keys(values).sort() };
}

async function main(env: Env): Promise<void> {
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const result = await generateSipCredentials(env, apply, upsertC0EnvAtomically);
  await writeEvidence('generate-sip-credentials', result); printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'SIP credential generation')); process.exitCode = 1; });
