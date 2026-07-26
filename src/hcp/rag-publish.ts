/**
 * RAG publish abstraction — remote (SSH/SCP) or local (HTTP + filesystem).
 *
 * Both deleteJobPoints and publishCsv log which target they are using so
 * the operator can tell from the output whether it ran locally or remotely.
 */
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

export type RagTarget = 'local' | 'remote';

/** Resolved publish settings. Remote-only fields are undefined when target is 'local'. */
export interface RagConfig {
  target: RagTarget;
  qdrantUrl: string;
  collection: string;
  ingestDir: string;
  // remote-only (below):
  sshKey?: string;
  proxmox?: string;
  remotePath?: string;
}

/**
 * Build a RagConfig from an environment bag (default: process.env).
 * Throws if target is not 'local' or 'remote'.
 */
export function resolveRagConfig(env: NodeJS.ProcessEnv = process.env): RagConfig {
  const target = (env.RAG_TARGET ?? 'remote') as RagTarget;

  if (target !== 'local' && target !== 'remote') {
    throw new Error(
      `Unrecognized RAG_TARGET="${target}". Valid values: local, remote`,
    );
  }

  const config: RagConfig = {
    target,
    qdrantUrl: env.QDRANT_URL ?? 'http://localhost:6333',
    collection: env.QDRANT_COLLECTION ?? 'grizzly_hcp',
    ingestDir: env.RAG_INGEST_DIR ?? '/mnt/samsung-sata/mav-rag/hcp-exports',
  };

  if (target === 'remote') {
    config.sshKey    = env.SSH_KEY    ?? 'C:/Users/carte/.ssh/id_ed25519_proxmox';
    config.proxmox   = env.PROXMOX   ?? 'root@192.168.1.12';
    config.remotePath = env.REMOTE_PATH ?? '/mnt/samsung-sata/mav-rag/hcp-exports/estimates-enriched.csv';
  }

  return config;
}

/**
 * Delete stale job points from the Qdrant collection.
 *
 * For 'local' target: POST to the collection's delete endpoint.
 * For 'remote' target: run the same SSH command sync-estimates.ts used today.
 */
export async function deleteJobPoints(cfg: RagConfig): Promise<void> {
  const label = cfg.target === 'local' ? 'local' : 'remote (SSH)';
  console.log(`  Deleting job points via ${label}...`);

  if (cfg.target === 'local') {
    const url = `${cfg.qdrantUrl}/collections/${cfg.collection}/points/delete`;
    const body = JSON.stringify({
      filter: {
        must: [
          { key: 'type', match: { value: 'job' } },
        ],
      },
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant delete failed: ${res.status} ${text}`);
    }

    console.log('  Job points cleared.');
  } else {
    const cmd = [
      `ssh -i "${cfg.sshKey}" -o StrictHostKeyChecking=no ${cfg.proxmox}`,
      `"curl -s -X POST http://localhost:6333/collections/${cfg.collection}/points/delete`,
      `-H 'Content-Type: application/json'`,
      `-d '{\\"filter\\":{\\"must\\":[{\\"key\\":\\"type\\",\\"match\\":{\\"value\\":\\"job\\"}}]}}'"`,
    ].join(' ');
    execSync(cmd, { stdio: 'inherit' });
  }
}

/**
 * Publish the enriched CSV to the configured ingest directory.
 *
 * For 'local' target: copy the file under the destination directory.
 * For 'remote' target: run the same SCP command sync-estimates.ts used today.
 */
export async function publishCsv(cfg: RagConfig, localCsvPath: string): Promise<void> {
  const label = cfg.target === 'local' ? 'local filesystem' : 'remote (SCP)';
  console.log(`  Publishing CSV via ${label}...`);

  if (cfg.target === 'local') {
    const destDir = cfg.ingestDir;
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(localCsvPath, path.join(destDir, 'estimates-enriched.csv'));
    console.log('  CSV published.');
  } else {
    execSync(
      `scp -i "${cfg.sshKey}" -o StrictHostKeyChecking=no "${localCsvPath}" ${cfg.proxmox}:${cfg.remotePath}`,
      { stdio: 'inherit' },
    );
  }
}
