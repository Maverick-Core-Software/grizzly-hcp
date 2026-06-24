// scripts/validate-pricebook.ts
// Scans data/pricebook.csv and flags every item name that violates the naming convention.
// Run: npx tsx scripts/validate-pricebook.ts
// Output: grouped list of violations with suggested renames, printed to stdout.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const CSV_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/pricebook.csv'
);

// ── helpers ──────────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function isTitleCase(name: string): boolean {
  // Every word should start with a capital letter.
  // Exceptions: conjunctions/prepositions of 3 chars or less (and, or, of, ft, per)
  const SKIP = new Set(['and', 'or', 'of', 'per', 'ft', 'w/', 'w']);
  return name.split(' ').every(word => {
    if (!word) return true;
    if (SKIP.has(word.toLowerCase())) return true;
    return word[0] === word[0].toUpperCase();
  });
}

interface Violation {
  uuid: string;
  category: string;
  name: string;
  rule: string;
  suggestion: string;
}

function checkItem(uuid: string, category: string, name: string, unit: string): Violation[] {
  const violations: Violation[] = [];

  // Rule 1: Title Case
  if (!isTitleCase(name)) {
    const suggestion = name.replace(/\b(\w)/g, (_, c) => c.toUpperCase());
    violations.push({ uuid, category, name, rule: 'NOT_TITLE_CASE', suggestion });
  }

  // Rule 2: Amperage must use "200A" format (not "200 amp", "200-amp", "200 AMP", "200amp")
  if (/\d\s*-?\s*amp\b/i.test(name)) {
    const suggestion = name.replace(/(\d+)\s*-?\s*amp\b/gi, '$1A');
    violations.push({ uuid, category, name, rule: 'AMP_FORMAT', suggestion });
  }

  // Rule 3: No abbreviations in type words
  const ABBR = [
    [/\bUpg\b/gi, 'Upgrade'],
    [/\bInst\b/gi, 'Install'],
    [/\bInstl\b/gi, 'Install'],
    [/\bRpl\b/gi, 'Replace'],
    [/\bRepl\b/gi, 'Replace'],
    [/\bDisconn?\b/gi, 'Disconnect'],
    [/\bCkt\b/gi, 'Circuit'],
    [/\bPnl\b/gi, 'Panel'],
    [/\bRcpt\b/gi, 'Receptacle'],
    [/\bRec\b/gi, 'Receptacle'],
    [/\bSwt\b/gi, 'Switch'],
    [/\bFxtr\b/gi, 'Fixture'],
    [/\bFix\b/gi, 'Fixture'],
    [/\bSvc\b/gi, 'Service'],
    [/\bBreak\b/gi, 'Breaker'],
    [/\bBrkr\b/gi, 'Breaker'],
  ] as const;

  for (const [pattern, replacement] of ABBR) {
    if (pattern.test(name)) {
      const suggestion = name.replace(pattern, replacement);
      violations.push({ uuid, category, name, rule: `ABBR:${replacement}`, suggestion });
      break; // report one abbr violation at a time
    }
  }

  // Rule 4: Per-foot items must end with ", per ft"
  if (unit.toLowerCase().includes('foot') || unit.toLowerCase() === 'lf') {
    if (!name.toLowerCase().endsWith(', per ft')) {
      const suggestion = name.replace(/,?\s*(per\s+ft|\/ft|per foot)\s*$/i, '') + ', per ft';
      violations.push({ uuid, category, name, rule: 'PER_FOOT_SUFFIX', suggestion });
    }
  }

  // Rule 5: Wire gauge — must use "#12 THHN" or "12/2 Romex" format (not "12awg", "#12awg", "12 AWG")
  if (/\bawg\b/i.test(name)) {
    const suggestion = name.replace(/(\d+)\s*(?:AWG|awg)/gi, '#$1');
    violations.push({ uuid, category, name, rule: 'WIRE_GAUGE_FORMAT', suggestion });
  }

  return violations;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const raw = await fs.readFile(CSV_PATH, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);

  const allViolations: Violation[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 10) continue;
    const [, , category, uuid, name, , , , , unit] = cols;
    const vs = checkItem(uuid.trim(), category.trim(), name.trim(), unit.trim());
    allViolations.push(...vs);
  }

  if (allViolations.length === 0) {
    console.log('✅ All pricebook items conform to the naming convention.');
    return;
  }

  // Group by rule
  const byRule = new Map<string, Violation[]>();
  for (const v of allViolations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule)!.push(v);
  }

  console.log(`\n⚠️  ${allViolations.length} naming violations found across ${byRule.size} rule(s).\n`);

  for (const [rule, vs] of byRule.entries()) {
    console.log(`── ${rule} (${vs.length} items) ─────────────────────`);
    for (const v of vs) {
      console.log(`  UUID:     ${v.uuid}`);
      console.log(`  Category: ${v.category}`);
      console.log(`  Current:  "${v.name}"`);
      console.log(`  Suggest:  "${v.suggestion}"`);
      console.log('');
    }
  }

  console.log(`\nTotal violations: ${allViolations.length}`);
  console.log('Run scripts/remap-categories.ts next to fix category assignments.');
}

main().catch(e => { console.error(e); process.exit(1); });
