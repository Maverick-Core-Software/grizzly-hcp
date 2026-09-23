import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const self = fileURLToPath(import.meta.url);

const credentialPatterns: readonly RegExp[] = [
  /\b(?:AC|SK|IS|PN|CA|RE|ST|SD|KS|MG|AP)[0-9a-fA-F]{32}\b/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\b[0-9a-f]{32}\b/,
  /API[A-Za-z0-9]{10,}/,
  /wss:\/\/[^\s'"`]+livekit\.cloud[\s\S]{0,400}(?:API[A-Za-z0-9]{10,}|\b[0-9a-f]{32}\b|\bsk-[A-Za-z0-9]{20,})/,
];

function filesBelow(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

const roots = [path.join(repoRoot, 'canary', 'c0'), path.join(repoRoot, 'src', 'agent', 'voice')];
const violations: string[] = [];
for (const root of roots) {
  for (const filePath of filesBelow(root)) {
    if (filePath === self) continue; // The check necessarily contains the detection patterns.
    const source = fs.readFileSync(filePath, 'utf8');
    if (credentialPatterns.some((pattern) => pattern.test(source))) {
      violations.push(path.relative(repoRoot, filePath));
    }
  }
}

assert.deepEqual(violations, [], `credential-shaped literals found in: ${violations.join(', ')}`);
console.log('no-credential-literals.check OK');
