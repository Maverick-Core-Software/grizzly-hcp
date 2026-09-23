import { AgentServer, initializeLogger, type LoggerOptions, type ServerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadCanaryRuntimeConfig, type CanaryRuntimeConfig } from './config.js';
import { createCanaryServerOptions } from './worker.js';

export type AgentServerLike = { run(): Promise<void> };

export type CanaryAgentStartupDependencies = {
  readonly initializeLogger: (options: LoggerOptions) => void;
  readonly loadConfig: () => CanaryRuntimeConfig;
  readonly createServerOptions: (config: CanaryRuntimeConfig) => ServerOptions;
  readonly createServer: (options: ServerOptions) => AgentServerLike;
  readonly warn: (message: string) => void;
};

/**
 * Starts the standalone C0 worker. This intentionally does not use cli.runApp,
 * so it performs the logger initialization that the CLI normally supplies.
 */
export async function startCanaryAgent(
  dependencies: Partial<CanaryAgentStartupDependencies> = {},
  argv: readonly string[] = process.argv,
): Promise<void> {
  if (argv[argv.length - 1] !== 'start') {
    throw new Error('c0_agent_usage: expected trailing start argument');
  }

  const initLogger = dependencies.initializeLogger ?? initializeLogger;
  const loadConfig = dependencies.loadConfig ?? loadCanaryRuntimeConfig;
  const makeOptions = dependencies.createServerOptions ?? createCanaryServerOptions;
  const makeServer = dependencies.createServer ?? ((options: ServerOptions) => new AgentServer(options));
  const warn = dependencies.warn ?? console.warn;

  // AgentServer constructs a logger child, so this must precede every SDK object.
  initLogger({ pretty: false, level: 'info' });
  const config = loadConfig();
  if (config.rehearsalSilentStart) warn('c0_rehearsal_silent_start_enabled');
  const server = makeServer(makeOptions(config));
  await server.run();
}

const isEntrypoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await startCanaryAgent();
