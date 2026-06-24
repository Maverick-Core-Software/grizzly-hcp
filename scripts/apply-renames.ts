// scripts/apply-renames.ts
// Reads scripts/renames.tsv (uuid<TAB>new_name per line) and applies renames to data/pricebook.csv
// Lines starting with # are ignored. Lines starting with DELETE:<uuid> remove that row.
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.resolve(__dirname, '../data/pricebook.csv');
const TSV_PATH = path.resolve(__dirname, 'renames.tsv');

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = ''; let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function escapeCsv(s: string): string { return `"${s.replace(/"/g, '""')}"` ; }

async function main() {
  const tsv = await fs.readFile(TSV_PATH, 'utf-8');
  const renames = new Map<string, string>();
  const deletes = new Set<string>();

  for (const line of tsv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('DELETE:')) {
      deletes.add(trimmed.slice(7).trim());
      continue;
    }
    const [uuid, ...rest] = trimmed.split('\t');
    if (uuid && rest.length) renames.set(uuid.trim(), rest.join('\t').trim());
  }

  const raw = await fs.readFile(CSV_PATH, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = lines[0];
  let applied = 0;
  let deleted = 0;

  const newBody = lines.slice(1).flatMap(line => {
    const cols = parseCsvLine(line);
    if (cols.length < 5) return [line];
    const uuid = cols[3].trim();
    if (deletes.has(uuid)) { deleted++; return []; }
    if (renames.has(uuid)) {
      cols[4] = renames.get(uuid)!;
      applied++;
      return [cols.map(escapeCsv).join(',')];
    }
    return [line];
  });

  await fs.writeFile(CSV_PATH, [header, ...newBody].join('\n'), 'utf-8');
  console.log(`Applied ${applied} of ${renames.size} renames.`);
  console.log(`Deleted ${deleted} of ${deletes.size} items.`);
  if (applied < renames.size) console.log(`WARNING: ${renames.size - applied} rename UUIDs not found in CSV`);
  if (deleted < deletes.size) console.log(`WARNING: ${deletes.size - deleted} delete UUIDs not found in CSV`);
}

main().catch(e => { console.error(e); process.exit(1); });
