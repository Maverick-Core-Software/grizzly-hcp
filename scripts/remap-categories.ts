// scripts/remap-categories.ts
// Maps old category names to the new job-type category structure.
// Some items require manual review (flagged with ⚠️) — the script will not auto-move those.
// Run (dry run): npx tsx scripts/remap-categories.ts
// Run (apply):   npx tsx scripts/remap-categories.ts --apply

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const CSV_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/pricebook.csv'
);

const APPLY = process.argv.includes('--apply');

// Unambiguous old→new mappings.
// Items that could go in multiple categories are flagged ⚠️ MANUAL instead.
const CATEGORY_MAP: Record<string, string | '⚠️ MANUAL'> = {
  'Service Call':                      'Service Calls & Diagnostics',
  'Service Calls':                     'Service Calls & Diagnostics',
  'Diagnostic':                        'Service Calls & Diagnostics',
  'Service Entrance and Panel':        '⚠️ MANUAL',
  'Service Entrance':                  'Service Entrance',
  'Panel':                             'Panel Upgrades',
  'Panel Upgrades':                    'Panel Upgrades',
  'EV Charger':                        'EV Charger',
  'EV Car Charger':                    'EV Charger',
  'Generator':                         'Generator',
  'Ceiling Fan':                       'Ceiling Fans & Fixtures',
  'Ceiling Fans & Fixtures':           'Ceiling Fans & Fixtures',
  'Lighting':                          'Ceiling Fans & Fixtures',
  'Light Fixtures':                    'Ceiling Fans & Fixtures',
  'Switches and Outlets':             'Switches, Outlets & Devices',
  'Devices':                           'Switches, Outlets & Devices',
  'GFCI':                              'Switches, Outlets & Devices',
  'Surge Protection':                  'Surge Protection',
  'Surge Protector':                   'Surge Protection',
  'Grounding':                         'Grounding & Bonding',
  'Grounding and Bonding':             'Grounding & Bonding',
  'Low Voltage':                       'Low Voltage',
  'Underground':                       'Underground & Trenching',
  'Trenching':                         'Underground & Trenching',
  'Rough In':                          'Remodel — Rough-In',
  'Rough-In':                          'Remodel — Rough-In',
  'Trim Out':                          'Remodel — Trim-Out',
  'Trim-Out':                          'Remodel — Trim-Out',
  'Commercial':                        'Commercial',
  'Conduit':                           'Conduit — Materials',
  'Wire':                              'Wire & Cable — Materials',
  'Wire and Cable':                    'Wire & Cable — Materials',
  'Permits':                           'Permits & Inspections',
  'Permit':                            'Permits & Inspections',
  'Fees':                              'Fees & Adjustments',
  'Install':                           '⚠️ MANUAL',
  'Labor':                             '⚠️ MANUAL',
  'Miscellaneous Material':            '⚠️ MANUAL',
  'Custom':                            '⚠️ MANUAL',
  'New Circuits':                      'New Circuits & Wiring',
  'Circuits':                          'New Circuits & Wiring',
};

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
  // ponytail: no embedded-quote ("") decode; upgrade if cells ever contain literal quotes
  return result;
}

function escapeCsv(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  const raw = await fs.readFile(CSV_PATH, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = lines[0];
  const body = lines.slice(1);

  let autoMoved = 0;
  let needsManual = 0;
  let unchanged = 0;

  const newBody: string[] = [];
  const manualItems: Array<{ uuid: string; name: string; category: string }> = [];

  for (const line of body) {
    const cols = parseCsvLine(line);
    if (cols.length < 5) { newBody.push(line); continue; }

    const oldCategory = cols[2].trim();
    const mapped = CATEGORY_MAP[oldCategory];

    if (!mapped) {
      console.log(`⚠️  Unknown category: "${oldCategory}" (item: "${cols[4]?.trim()}") — not in map`);
      newBody.push(line);
      unchanged++;
      continue;
    }

    if (mapped === '⚠️ MANUAL') {
      manualItems.push({ uuid: cols[3].trim(), name: cols[4].trim(), category: oldCategory });
      newBody.push(line);
      needsManual++;
      continue;
    }

    if (mapped === oldCategory) {
      newBody.push(line);
      unchanged++;
      continue;
    }

    cols[2] = mapped;
    const newLine = cols.map(escapeCsv).join(',');
    newBody.push(newLine);
    autoMoved++;
    if (!APPLY) {
      console.log(`  "${oldCategory}" → "${mapped}" | ${cols[4].trim()}`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Auto-moved: ${autoMoved}`);
  console.log(`  Needs manual review: ${needsManual}`);
  console.log(`  Unchanged: ${unchanged}`);

  if (needsManual > 0) {
    console.log(`\n⚠️  Items needing manual category assignment:`);
    for (const item of manualItems) {
      console.log(`  [${item.category}] ${item.name} (${item.uuid})`);
    }
  }

  if (APPLY) {
    await fs.writeFile(CSV_PATH, [header, ...newBody].join('\n'), 'utf-8');
    console.log(`\n✅ Applied ${autoMoved} category remaps to ${CSV_PATH}`);
    console.log(`   ${needsManual} items still need manual category assignment — see list above.`);
  } else {
    console.log(`\nDry run only. Pass --apply to write changes.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
