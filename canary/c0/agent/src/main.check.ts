import assert from 'node:assert/strict';
import type { CanaryRuntimeConfig } from './config.js';
import { startCanaryAgent } from './main.js';

const events: string[] = [];
const config = {} as CanaryRuntimeConfig;

await startCanaryAgent(
  {
    initializeLogger: (options) => {
      events.push(`logger:${JSON.stringify(options)}`);
    },
    loadConfig: () => {
      events.push('config');
      return config;
    },
    createServerOptions: (received) => {
      assert.equal(received, config);
      events.push('options');
      return {} as never;
    },
    createServer: () => {
      events.push('server');
      return { run: async () => { events.push('run'); } };
    },
  },
  ['node', 'tsx', 'main.ts', 'start'],
);

assert.deepEqual(events, ['logger:{"pretty":false,"level":"info"}', 'config', 'options', 'server', 'run']);
await assert.rejects(() => startCanaryAgent({}, ['node', 'tsx', 'main.ts']), /expected trailing start argument/);
console.log('main.check OK');
