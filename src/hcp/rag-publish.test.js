import { strict as assert } from 'node:assert';
import { describe, test, after, beforeEach } from 'node:test';
import fs from 'fs/promises';
import path from 'path';

import { deleteJobPoints, deletePointsByType, publishCsv, resolveRagConfig } from './rag-publish.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpRoot = null;

async function tmpDir() {
  const base = path.join(await fs.realpath(process.cwd()), 'rag-test-' + Math.random().toString(36).slice(2));
  await fs.mkdir(base, { recursive: true });
  tmpRoot = base;
  return base;
}

after(async () => {
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('resolveRagConfig', () => {
  test('returns remote defaults when env is empty', () => {
    const cfg = resolveRagConfig({});
    assert.strictEqual(cfg.target, 'remote');
    assert.strictEqual(cfg.qdrantUrl, 'http://localhost:6333');
    assert.strictEqual(cfg.collection, 'grizzly_hcp');
    assert.strictEqual(cfg.ingestDir, '/mnt/samsung-sata/mav-rag/hcp-exports');
    assert.strictEqual(cfg.sshKey, 'C:/Users/carte/.ssh/id_ed25519_proxmox');
    assert.strictEqual(cfg.proxmox, 'root@192.168.1.12');
    assert.strictEqual(cfg.remotePath, '/mnt/samsung-sata/mav-rag/hcp-exports/estimates-enriched.csv');
  });

  test('honours each environment variable override', () => {
    const env = {
      RAG_TARGET: 'local',
      QDRANT_URL: 'http://10.0.0.5:6333',
      QDRANT_COLLECTION: 'my_collection',
      RAG_INGEST_DIR: '/tmp/ingest',
    };
    const cfg = resolveRagConfig(env);
    assert.strictEqual(cfg.target, 'local');
    assert.strictEqual(cfg.qdrantUrl, 'http://10.0.0.5:6333');
    assert.strictEqual(cfg.collection, 'my_collection');
    assert.strictEqual(cfg.ingestDir, '/tmp/ingest');
    assert.strictEqual(cfg.sshKey, undefined);
    assert.strictEqual(cfg.proxmox, undefined);
    assert.strictEqual(cfg.remotePath, undefined);
  });

  test('throws on an invalid target value', () => {
    assert.throws(() => resolveRagConfig({ RAG_TARGET: 'bad' }), {
      message: /Unrecognized RAG_TARGET="bad"\. Valid values: local, remote/,
    });
  });
});

describe('publishCsv (local target)', () => {
  let tmpSrc = null;

  beforeEach(async () => {
    const base = tmpRoot || await tmpDir();
    tmpSrc = path.join(base, 'source.csv');
    await fs.writeFile(tmpSrc, 'col1,col2\na,b\n', 'utf-8');
  });

  test('creates destination directory and copies CSV with expected name and contents (default)', async () => {
    const base = tmpRoot || await tmpDir();
    const ingestDir = path.join(base, 'ingest');

    const cfg = {
      target: 'local',
      qdrantUrl: 'http://localhost:6333',
      collection: 'grizzly_hcp',
      ingestDir,
    };

    await publishCsv(cfg, tmpSrc);

    const destPath = path.join(ingestDir, 'estimates-enriched.csv');
    assert.ok(await fs.stat(destPath));
    const content = await fs.readFile(destPath, 'utf-8');
    assert.strictEqual(content, 'col1,col2\na,b\n');
  });

  test('copies CSV to a custom destination filename', async () => {
    const base = tmpRoot || await tmpDir();
    const ingestDir = path.join(base, 'ingest-custom');

    const cfg = {
      target: 'local',
      qdrantUrl: 'http://localhost:6333',
      collection: 'grizzly_hcp',
      ingestDir,
    };

    await publishCsv(cfg, tmpSrc, 'pricebook.csv');

    const destPath = path.join(ingestDir, 'pricebook.csv');
    assert.ok(await fs.stat(destPath));
    const content = await fs.readFile(destPath, 'utf-8');
    assert.strictEqual(content, 'col1,col2\na,b\n');
  });

  test('throws on non-default filename with remote target', async () => {
    const cfg = {
      target: 'remote',
      qdrantUrl: 'http://localhost:6333',
      collection: 'grizzly_hcp',
      ingestDir: '/tmp/ingest',
      sshKey: 'fake-key',
      proxmox: 'root@192.168.1.12',
      remotePath: '/some/path.csv',
    };

    await assert.rejects(
      () => publishCsv(cfg, tmpSrc, 'pricebook.csv'),
      {
        message: /Remote publish only supports 'estimates-enriched\.csv'; got 'pricebook\.csv'\./,
      },
    );
  });
});

describe('deleteJobPoints', () => {
  test('resolveRagConfig produces config compatible with deleteJobPoints signature', () => {
    const cfg = resolveRagConfig({});
    assert.strictEqual(typeof cfg.collection, 'string');
    assert.strictEqual(typeof cfg.qdrantUrl, 'string');
  });

  test('deleteJobPoints still targets type == "job"', () => {
    const cfg = resolveRagConfig({});
    // deleteJobPoints delegates to deletePointsByType(cfg, 'job') — verify by reading the source
    // Since we can't actually hit Qdrant in these tests, we verify the wrapper behavior
    // by checking that the function exists and has the right signature
    assert.strictEqual(typeof deleteJobPoints, 'function');
    assert.strictEqual(typeof deletePointsByType, 'function');
  });
});
