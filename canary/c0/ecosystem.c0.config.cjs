// Reference only: c0ctl.ps1 is used on Windows; this configuration is not executed there.
const path = require('node:path');

const c0Root = __dirname;
const repoRoot = path.resolve(c0Root, '../..');

function c0App(name, directory, args) {
  return {
    name,
    // All C0 packages resolve durable data from the worktree root, never cwd.
    cwd: repoRoot,
    script: path.join(c0Root, directory, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    args,
    interpreter: 'node',
    env: { TZ: 'America/Chicago' },
    autorestart: true,
    max_restarts: 5,
    min_uptime: 10_000,
    time: true,
  };
}

module.exports = {
  apps: [
    c0App('c0-agent', 'agent', ['canary/c0/agent/src/main.ts', 'start']),
    c0App('c0-detector', 'detector', ['canary/c0/detector/src/index.ts']),
    c0App('c0-monitor', 'monitor', ['canary/c0/monitor/index.ts']),
  ],
};
