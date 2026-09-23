import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const self = path.relative(repoRoot, fileURLToPath(import.meta.url)).split(path.sep).join('/');

const credentialPatterns: readonly RegExp[] = [
  /\b(?:AC|SK|IS|PN|CA|RE|ST|SD|KS|MG|AP)[0-9a-fA-F]{32}\b/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\b[0-9a-f]{32}\b/,
  /API[A-Za-z0-9]{10,}/,
  /wss:\/\/[^\s'"`]+livekit\.cloud[\s\S]{0,400}(?:API[A-Za-z0-9]{10,}|\b[0-9a-f]{32}\b|\bsk-[A-Za-z0-9]{20,})/,
];

function gitFiles(args: string[]): string[] {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

const roots = ['canary/c0', 'src/agent/voice'];
const candidateFiles = new Set([
  ...gitFiles(['ls-files', '-z', '--', ...roots]),
  ...gitFiles(['ls-files', '-z', '--others', '--exclude-standard', '--', ...roots]),
]);
const files = [...candidateFiles].filter((filePath) => !filePath.includes('/node_modules/'));
assert.ok(files.every((filePath) => !filePath.endsWith('.env.c0')), 'credential scan must never enumerate canary/c0/.env.c0');
const violations: string[] = [];
for (const filePath of files) {
  if (filePath === self) continue; // The check necessarily contains the detection patterns.
  const source = fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
  if (credentialPatterns.some((pattern) => pattern.test(source))) {
    violations.push(filePath);
  }
}

assert.deepEqual(violations, [], `credential-shaped literals found in: ${violations.join(', ')}`);
console.log('no-credential-literals.check OK');
