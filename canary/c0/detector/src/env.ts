import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';

export type C0Env = Record<string, string | undefined>;
const C0_ENV_KEY = /^(VOICE_C0_|VOICE_OUTBOX_)/;

/** Parse only the canary file; inherited C0 values can only cause refusal. */
export function parseDetectorEnv(source: string, inherited: NodeJS.ProcessEnv = process.env): C0Env {
  const parsed = dotenv.parse(source);
  const env: C0Env = Object.fromEntries(Object.entries(parsed).filter(([name]) => C0_ENV_KEY.test(name)));
  for (const [name, inheritedValue] of Object.entries(inherited)) {
    if (C0_ENV_KEY.test(name) && inheritedValue !== env[name]) {
      throw new Error(`Refusing inherited canary configuration conflict: ${name}`);
    }
  }
  return env;
}

export function loadDetectorEnv(envPath: string, inherited: NodeJS.ProcessEnv = process.env): C0Env {
  try {
    return parseDetectorEnv(readFileSync(envPath, 'utf8'), inherited);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing inherited canary configuration conflict:')) throw error;
    throw new Error('Unable to load canary/c0/.env.c0');
  }
}
