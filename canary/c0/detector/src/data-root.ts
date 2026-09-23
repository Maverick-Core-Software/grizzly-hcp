import fs from 'node:fs';
import path from 'node:path';

export type PathExists = (candidate: string) => boolean;

function requiredRepoPath(repoRoot: string, relative: string, exists: PathExists): void {
  if (!exists(path.join(repoRoot, relative))) {
    throw new Error(`c0_detector_invalid_repo_root:${relative}`);
  }
}

/** `sourceDir` is `<repo>/canary/c0/detector/src`, exactly four levels below the repo. */
export function resolveDetectorRepoRoot(sourceDir: string, exists: PathExists = fs.existsSync): string {
  const repoRoot = path.resolve(sourceDir, '../../../..');
  requiredRepoPath(repoRoot, 'package.json', exists);
  requiredRepoPath(repoRoot, path.join('src', 'agent', 'voice'), exists);
  return repoRoot;
}

/**
 * Shared C0 data-root rule: a supplied data directory must be absolute;
 * otherwise all canary packages use the worktree's `data/c0` directory.
 */
export function resolveC0DataRoot(
  env: { readonly [name: string]: string | undefined; readonly VOICE_C0_DATA_DIR?: string },
  repoRoot: string,
): string {
  const configured = env.VOICE_C0_DATA_DIR?.trim();
  if (!configured) return path.join(repoRoot, 'data', 'c0');
  if (!path.isAbsolute(configured)) throw new Error('c0_detector_data_dir_must_be_absolute');
  return path.resolve(configured);
}
