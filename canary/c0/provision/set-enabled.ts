import { assertApply, isApply, isEntryPoint, loadC0Env, parseFlag, printSafe, safeFailureMessage, upsertC0EnvAtomically, writeEvidence, type Env } from './lib.js';

export function parseEnabled(value: string | undefined): 'true' | 'false' {
  if (value !== 'true' && value !== 'false') throw new Error('Usage: --value true|false [--apply]');
  return value;
}

export async function setEnabled(env: Env, value: string | undefined, apply: boolean, writeEnv: (values: Record<string, string>) => Promise<void>, now: () => Date = () => new Date()) {
  const after = parseEnabled(value); const before = env.VOICE_C0_ENABLED === 'true' || env.VOICE_C0_ENABLED === 'false' ? env.VOICE_C0_ENABLED : null;
  if (apply) await writeEnv({ VOICE_C0_ENABLED: after });
  return { dryRun: !apply, before, after, at: now().toISOString(), written: apply ? ['VOICE_C0_ENABLED'] : [], restartCommand: 'pwsh -NoProfile -File canary/c0/c0ctl.ps1 restart agent' };
}

async function main(env: Env): Promise<void> {
  const apply = isApply(process.argv); if (apply) assertApply(process.argv);
  const result = await setEnabled(env, parseFlag(process.argv, '--value'), apply, upsertC0EnvAtomically);
  await writeEvidence('set-enabled', result); printSafe(result);
}

if (isEntryPoint(import.meta.url)) main(loadC0Env()).catch((error) => { console.error(safeFailureMessage(error, 'C0 enabled state update')); process.exitCode = 1; });
