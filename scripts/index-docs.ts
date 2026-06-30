// Upload local knowledge docs to Proxmox RAG watchdog folder via SCP.
// Usage: npx tsx scripts/index-docs.ts [source-folder]
// Default source folder: ./knowledge

import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import path from 'path';

const srcFolder = process.argv[2] ?? './knowledge';
const remoteHost = 'root@192.168.1.12';
const remotePath = '/mnt/samsung-sata/mav-rag/reference-docs/';
const sshKey =
  process.platform === 'win32'
    ? 'C:/Users/carte/.ssh/id_ed25519_proxmox'
    : '/root/.ssh/id_ed25519_proxmox';

let files: string[];
try {
  files = readdirSync(srcFolder).filter((f) => /\.(md|txt)$/.test(f));
} catch (e: unknown) {
  console.error(`Error reading source folder "${srcFolder}":`, (e as Error).message);
  process.exit(1);
}

if (files.length === 0) {
  console.log('No .md or .txt files found in', srcFolder);
  process.exit(0);
}

let uploaded = 0;
for (const file of files) {
  const localPath = path.join(srcFolder, file);
  console.log(`Uploading: ${file}`);
  try {
    execSync(
      `scp -i "${sshKey}" -o StrictHostKeyChecking=no "${localPath}" "${remoteHost}:${remotePath}"`,
      { stdio: 'inherit' },
    );
    uploaded++;
  } catch (e: unknown) {
    console.error(`Failed to upload "${file}":`, (e as Error).message);
    process.exit(1);
  }
}

console.log(`Done. ${uploaded} file${uploaded === 1 ? '' : 's'} uploaded.`);
