import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadC0Config, resolveOutboxPath } from '../../../src/agent/voice/c0-config.js';
import { resolveC0DataRoot, resolveMonitorRepoRoot, resolveMonitorStoragePaths } from './data-root.js';

const repoRoot = path.resolve(process.cwd(), 'fixture-monitor-repo');
const packageDir = path.join(repoRoot, 'canary', 'c0', 'monitor');
const present = new Set([
  path.join(repoRoot, 'package.json'),
  path.join(repoRoot, 'src', 'agent', 'voice'),
]);

assert.equal(resolveMonitorRepoRoot(packageDir, (candidate) => present.has(candidate)), repoRoot);
assert.equal(resolveC0DataRoot({}, repoRoot), path.join(repoRoot, 'data', 'c0'));
assert.equal(
  resolveOutboxPath(loadC0Config({}), repoRoot),
  path.join(repoRoot, 'data', 'c0', 'voice-outbox.jsonl'),
  'outbox path resolves from the worktree root, never process.cwd',
);
const externalRoot = path.resolve(process.cwd(), 'external-monitor-state');
assert.equal(resolveC0DataRoot({ VOICE_C0_DATA_DIR: externalRoot }, repoRoot), externalRoot);
assert.throws(
  () => resolveC0DataRoot({ VOICE_C0_DATA_DIR: 'relative/c0-state' }, repoRoot),
  /c0_monitor_data_dir_must_be_absolute/,
);
assert.throws(
  () => resolveMonitorRepoRoot(packageDir, () => false),
  /c0_monitor_invalid_repo_root/,
);

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c0-monitor-storage-'));
try {
  const statePath = path.join(storageRoot, 'monitor-alerts.jsonl');
  const distinctOutboxPath = path.join(storageRoot, 'voice-outbox.jsonl');
  assert.doesNotThrow(() => resolveMonitorStoragePaths(storageRoot, distinctOutboxPath), 'distinct outbox and state paths are allowed');

  const sameCaseConfig = loadC0Config({ VOICE_OUTBOX_PATH: statePath });
  assert.throws(
    () => resolveMonitorStoragePaths(storageRoot, resolveOutboxPath(sameCaseConfig, repoRoot)),
    /c0_monitor_state_outbox_path_collision/,
    'an outbox configured at the state path is refused before any write',
  );
  assert.equal(fs.existsSync(statePath), false, 'refusal leaves the state path unwritten');

  assert.throws(
    () => resolveMonitorStoragePaths(storageRoot, statePath.toUpperCase(), { platform: 'win32' }),
    /c0_monitor_state_outbox_path_collision/,
    'case-only Windows aliases are refused before any write',
  );
  assert.equal(fs.existsSync(statePath), false, 'case-alias refusal also writes nothing');

  assert.throws(
    () => resolveMonitorStoragePaths(storageRoot, distinctOutboxPath, { outboxTemporaryPath: statePath }),
    /c0_monitor_state_outbox_path_collision/,
    'an outbox atomic-rename target that aliases state is refused',
  );

  const junctionParent = path.join(storageRoot, 'junction-parent');
  const actualParent = path.join(storageRoot, 'actual-parent');
  const canonicalParent = path.join(storageRoot, 'canonical-parent');
  const mkdirCalls: string[] = [];
  const junctionFilesystem = {
    mkdirSync(candidate: string, options: { recursive: true }) {
      mkdirCalls.push(candidate);
      fs.mkdirSync(candidate, options);
    },
    realpathNative(candidate: string) {
      if (candidate === junctionParent || candidate === actualParent) return canonicalParent;
      return candidate;
    },
  };
  assert.throws(
    () => resolveMonitorStoragePaths(junctionParent, path.join(actualParent, 'monitor-alerts.jsonl'), { filesystem: junctionFilesystem }),
    /c0_monitor_state_outbox_path_collision/,
    'distinct absent leaves under aliased parent directories are refused',
  );
  assert.ok(mkdirCalls.includes(junctionParent) && mkdirCalls.includes(actualParent), 'all absent leaf parents are created before canonical comparison');
  assert.equal(fs.existsSync(path.join(junctionParent, 'monitor-alerts.jsonl')), false, 'junction refusal reaches no state-file writer');
  assert.equal(fs.existsSync(path.join(actualParent, 'monitor-alerts.jsonl')), false, 'junction refusal reaches no outbox writer');

  const distinctFilesystem = {
    mkdirSync(candidate: string, options: { recursive: true }) { fs.mkdirSync(candidate, options); },
    realpathNative(candidate: string) { return candidate; },
  };
  assert.doesNotThrow(
    () => resolveMonitorStoragePaths(junctionParent, path.join(actualParent, 'voice-outbox.jsonl'), { filesystem: distinctFilesystem }),
    'distinct canonical parent directories remain valid',
  );
} finally {
  fs.rmSync(storageRoot, { recursive: true, force: true });
}

console.log('data-root.check OK');
