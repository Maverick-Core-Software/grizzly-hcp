// PM2 process definition for the Grizzly-HCP email watcher.
// Start/refresh with:  pm2 start ecosystem.config.cjs && pm2 save
//
// Runs email-watcher.ts through the tsx CLI (no build step). We launch the
// tsx CLI as the script and pass the .ts file as an arg, rather than using
// node's --import loader via interpreter_args — pm2 collapses a space-bearing
// interpreter_args string into one token, which crashes node on startup.
// cwd is the repo root so `import 'dotenv/config'` loads ./.env and runtime
// state lands in ./data/ (seen-emails.json, failed-emails.json).
module.exports = {
  apps: [
    {
      name: 'mav-email-watcher',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/automations/estimates/email-watcher.ts',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      windowsHide: true,
    },
    {
      name: 'mav-slack',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/automations/slack/index.ts',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      windowsHide: true,
    },
    {
      // Weekly job: pull all HCP estimates with full line items → re-index in RAG.
      // Runs every Sunday at 2 AM so fresh data is ready for Monday.
      // Complements the Gemini CSV auto-download pipeline (jobs/customers/pricebook).
      // One-shot: autorestart: false so PM2 doesn't loop it; cron_restart fires it weekly.
      name: 'sync-estimates-weekly',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/hcp/sync-estimates.ts',
      cwd: __dirname,
      cron_restart: '0 2 * * 0',
      autorestart: false,
      watch: false,
      windowsHide: true,
    },
  ],
};
