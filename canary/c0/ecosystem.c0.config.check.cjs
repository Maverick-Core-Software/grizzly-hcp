const assert = require('node:assert/strict');
const path = require('node:path');
const config = require('./ecosystem.c0.config.cjs');

const expectedNames = ['c0-agent', 'c0-detector', 'c0-monitor'];
const forbiddenProductionNames = new Set([
  'voice-server',
  'booking-approval-poller',
  'customer-chat-server',
  'mav-email-watcher',
  'sync-estimates-weekly',
]);
const repoRoot = path.resolve(__dirname, '../..');

assert.deepEqual(config.apps.map((app) => app.name), expectedNames);
assert.ok(config.apps.every((app) => !forbiddenProductionNames.has(app.name)));
assert.ok(config.apps.every((app) => app.cwd === repoRoot));
assert.ok(config.apps.every((app) => app.env.TZ === 'America/Chicago'));
assert.ok(config.apps.every((app) => app.autorestart === true && app.max_restarts === 5));
assert.ok(config.apps.every((app) => !Object.hasOwn(app, 'env_file')));
assert.deepEqual(config.apps[0].args, ['canary/c0/agent/src/main.ts', 'start']);

console.log('ecosystem.c0.config.check OK');
