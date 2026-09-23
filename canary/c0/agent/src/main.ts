import { AgentServer } from '@livekit/agents';
import { loadCanaryRuntimeConfig } from './config.js';
import { createCanaryServerOptions } from './worker.js';

const config = loadCanaryRuntimeConfig();
if (config.rehearsalSilentStart) console.warn('c0_rehearsal_silent_start_enabled');
const server = new AgentServer(createCanaryServerOptions(config));
await server.run();
