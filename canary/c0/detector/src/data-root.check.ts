import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveC0DataRoot, resolveDetectorRepoRoot } from './data-root.js';
import { loadDetectorConfig } from './detector.js';

const repoRoot = path.resolve(process.cwd(), 'fixture-detector-repo');
const sourceDir = path.join(repoRoot, 'canary', 'c0', 'detector', 'src');
const present = new Set([
  path.join(repoRoot, 'package.json'),
  path.join(repoRoot, 'src', 'agent', 'voice'),
]);

assert.equal(resolveDetectorRepoRoot(sourceDir, (candidate) => present.has(candidate)), repoRoot);
assert.equal(resolveC0DataRoot({}, repoRoot), path.join(repoRoot, 'data', 'c0'));
assert.equal(
  loadDetectorConfig({ VOICE_C0_ENABLED: 'false' }, repoRoot).markerRoot,
  path.join(repoRoot, 'data', 'c0'),
  'detector marker root is worktree-relative, never process.cwd-relative',
);
const externalRoot = path.resolve(process.cwd(), 'external-c0-state');
assert.equal(resolveC0DataRoot({ VOICE_C0_DATA_DIR: externalRoot }, repoRoot), externalRoot);
assert.throws(
  () => resolveC0DataRoot({ VOICE_C0_DATA_DIR: 'relative/c0-state' }, repoRoot),
  /c0_detector_data_dir_must_be_absolute/,
);
assert.throws(
  () => resolveDetectorRepoRoot(sourceDir, () => false),
  /c0_detector_invalid_repo_root/,
);

console.log('data-root.check OK');
