import fs from 'node:fs';
import path from 'node:path';

export type PathExists = (candidate: string) => boolean;

export interface MonitorStoragePaths {
  readonly alertStatePath: string;
  readonly outboxPath: string;
  readonly outboxTemporaryPath: string;
}

export interface MonitorStoragePathOptions {
  /** Test seam for the outbox's atomic-rename target; production uses `<outbox>.tmp`. */
  readonly outboxTemporaryPath?: string;
  /** Windows filesystem paths are case-insensitive even when an alias does not exist yet. */
  readonly platform?: NodeJS.Platform;
  readonly filesystem?: MonitorStorageFilesystem;
}

export interface MonitorStorageFilesystem {
  mkdirSync(candidate: string, options: { readonly recursive: true }): unknown;
  realpathNative(candidate: string): string;
}

/**
 * A state or outbox leaf may not exist yet, including beneath a Windows
 * junction.  Create and canonicalize its parent instead, then append the
 * lexical basename so comparison still uses the junction's filesystem target.
 */
export function normalizeMonitorStoragePath(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  filesystem: MonitorStorageFilesystem = { mkdirSync: fs.mkdirSync, realpathNative: fs.realpathSync.native },
): string {
  const absolute = path.resolve(candidate);
  const parent = path.dirname(absolute);
  let canonicalParent: string;
  try {
    filesystem.mkdirSync(parent, { recursive: true });
    canonicalParent = filesystem.realpathNative(parent);
  } catch {
    throw new Error('c0_monitor_storage_path_unresolvable');
  }
  const normalized = path.join(canonicalParent, path.basename(absolute));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isEqualOrInside(candidate: string, container: string): boolean {
  const relative = path.relative(container, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * The monitor's state file is a separate store.  Refuse before either store
 * is constructed if it could be replaced by any outbox write target.
 */
export function resolveMonitorStoragePaths(
  dataRoot: string,
  outboxPath: string,
  options: MonitorStoragePathOptions = {},
): MonitorStoragePaths {
  const platform = options.platform ?? process.platform;
  const filesystem = options.filesystem;
  const alertStatePath = normalizeMonitorStoragePath(path.join(dataRoot, 'monitor-alerts.jsonl'), platform, filesystem);
  const normalizedOutboxPath = normalizeMonitorStoragePath(outboxPath, platform, filesystem);
  const outboxTemporaryPath = normalizeMonitorStoragePath(options.outboxTemporaryPath ?? `${outboxPath}.tmp`, platform, filesystem);
  for (const outboxWritePath of [normalizedOutboxPath, outboxTemporaryPath]) {
    if (isEqualOrInside(alertStatePath, outboxWritePath)) {
      throw new Error('c0_monitor_state_outbox_path_collision');
    }
  }
  return { alertStatePath, outboxPath: normalizedOutboxPath, outboxTemporaryPath };
}

/** `packageDir` is `<repo>/canary/c0/monitor`, exactly three levels below the repo. */
export function resolveMonitorRepoRoot(packageDir: string, exists: PathExists = fs.existsSync): string {
  const repoRoot = path.resolve(packageDir, '../../..');
  if (!exists(path.join(repoRoot, 'package.json'))) {
    throw new Error('c0_monitor_invalid_repo_root:package.json');
  }
  if (!exists(path.join(repoRoot, 'src', 'agent', 'voice'))) {
    throw new Error('c0_monitor_invalid_repo_root:src/agent/voice');
  }
  return repoRoot;
}

/** See detector data-root rule; duplicated locally so neither package depends on the other. */
export function resolveC0DataRoot(
  env: { readonly [name: string]: string | undefined; readonly VOICE_C0_DATA_DIR?: string },
  repoRoot: string,
): string {
  const configured = env.VOICE_C0_DATA_DIR?.trim();
  if (!configured) return path.join(repoRoot, 'data', 'c0');
  if (!path.isAbsolute(configured)) throw new Error('c0_monitor_data_dir_must_be_absolute');
  return path.resolve(configured);
}
