import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { checkOdaConverter } from './converters/dwg-to-dxf.js';
import { checkPdfDependencies } from './parsers/pdf.js';
import { runTakeoff } from './index.js';
import type { TakeoffOptions } from './index.js';
import type { TakeoffResult } from './types.js';
import path from 'path';

// ── Arg parsing ──────────────────────────────────────────────────────────────

interface CliArgs {
  check: boolean;
  validateMode: boolean;
  format: 'json' | 'summary';
  filePath: string | undefined;
  options: TakeoffOptions;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: CliArgs = {
    check: false,
    validateMode: false,
    format: 'summary',
    filePath: undefined,
    options: {},
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--check') {
      result.check = true;
    } else if (arg === '--validate-mode') {
      result.validateMode = true;
    } else if (arg === '--format') {
      const val = args[++i];
      if (val === 'json' || val === 'summary') result.format = val;
    } else if (arg === '--ft-per-drawing-unit') {
      const val = parseFloat(args[++i] ?? '');
      if (!isNaN(val)) result.options.ftPerDrawingUnit = val;
    } else if (arg === '--drawing-scale') {
      result.options.drawingScale = args[++i];
    } else if (arg === '--calibrate') {
      result.options.calibratePoints = args[++i];
    } else if (!arg.startsWith('--')) {
      result.filePath = arg;
    }
    i++;
  }

  return result;
}

// ── Check mode ───────────────────────────────────────────────────────────────

async function runCheck(): Promise<void> {
  console.log('Running startup diagnostics...\n');

  // ODA converter
  try {
    await checkOdaConverter();
    console.log('✅ ODA File Converter — found and responding');
  } catch (err) {
    console.log(`❌ ODA File Converter — ${err instanceof Error ? err.message : String(err)}`);
  }

  // PDF dependencies
  try {
    const result = await checkPdfDependencies();
    if (result.ok) {
      console.log('✅ PDF dependencies (GraphicsMagick, Ghostscript) — present');
    } else {
      console.log(`❌ PDF dependencies — missing: ${result.missing.join(', ')}`);
      console.log(`   ${result.instructions.replace(/\n/g, '\n   ')}`);
    }
  } catch (err) {
    console.log(`❌ PDF dependencies check error — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Anthropic API key
  try {
    const client = new Anthropic();
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    console.log('✅ Anthropic API key — valid');
  } catch (err) {
    console.log(`❌ Anthropic API key — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Summary printer ──────────────────────────────────────────────────────────

function printSummary(result: TakeoffResult, filePath: string): void {
  const SEP = '═══════════════════════════════════════════';
  const THIN = '───────────────────────────────────────────';

  console.log(SEP);
  console.log('BLUEPRINT TAKEOFF SUMMARY');
  console.log(SEP);
  console.log(`Source: ${path.basename(filePath)}`);
  console.log(
    `Scale: ${result.calibration.source} (${result.calibration.scale_confidence} confidence)`,
  );

  // Device counts
  const deviceEntries = Object.entries(result.devices).filter(([, count]) => count > 0);
  if (deviceEntries.length > 0) {
    console.log('\nDEVICE COUNTS');
    console.log(THIN.slice(0, 33));
    for (const [dtype, count] of deviceEntries) {
      const label = dtype.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      console.log(`${label.padEnd(28)} ${String(count).padStart(4)}`);
    }
  }

  // Routing
  const routingEntries = Object.entries(result.estimated_routing_lengths.by_type);
  if (routingEntries.length > 0) {
    console.log('\nESTIMATED WIRE ROUTING (nominal)');
    console.log(THIN.slice(0, 33));
    for (const [dtype, lengths] of routingEntries) {
      console.log(
        `${dtype.padEnd(24)} ${String(Math.round(lengths.nominal_ft)).padStart(5)} ft` +
          `  (min ${Math.round(lengths.min_ft)} / max ${Math.round(lengths.max_ft)})`,
      );
    }
  }

  // Panels
  console.log('\nPANEL SCHEDULES');
  console.log(THIN.slice(0, 33));
  console.log(`${result.panels.length} panel(s) found`);

  // Labor
  const { labor } = result;
  console.log('\nLABOR ESTIMATE');
  console.log(THIN.slice(0, 33));
  console.log(`Rough-in:   ${labor.rough_in_hours.toFixed(1).padStart(6)} hrs`);
  console.log(`Trim-out:   ${labor.trim_out_hours.toFixed(1).padStart(6)} hrs`);
  console.log(`Panel work: ${labor.panel_hours.toFixed(1).padStart(6)} hrs`);
  console.log(`Total:      ${labor.total_hours.toFixed(1).padStart(6)} hrs`);

  // Warnings
  if (result.warnings.length > 0) {
    console.log(`\nWARNINGS (${result.warnings.length})`);
    console.log(THIN.slice(0, 33));
    for (const w of result.warnings) {
      console.log(`[${w.severity.toUpperCase()}] ${w.message}`);
    }
  }

  // Assumptions
  if (result.assumptions.length > 0) {
    console.log('\nASSUMPTIONS');
    console.log(THIN.slice(0, 33));
    for (const a of result.assumptions) {
      console.log(`- ${a}`);
    }
  }

  console.log(
    '\n⚠ REVIEW REQUIRED — Do not use this takeoff in an estimate without manual verification.',
  );
  console.log(SEP);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

if (args.check) {
  await runCheck();
  process.exit(0);
}

if (args.validateMode) {
  console.log('Validation mode not yet implemented');
  process.exit(0);
}

if (!args.filePath) {
  console.error('Usage: npm run takeoff <file> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --check                       Run startup diagnostics');
  console.error('  --validate-mode               Placeholder for future validation');
  console.error('  --format <json|summary>       Output format (default: summary)');
  console.error('  --ft-per-drawing-unit <n>     Scale override');
  console.error('  --drawing-scale <scale>       Scale string e.g. "1/8in=1ft"');
  console.error('  --calibrate <string>          Calibration points string');
  process.exit(1);
}

const filePath = args.filePath;
console.log(`🔍 Running blueprint takeoff on: ${path.basename(filePath)}`);

try {
  const result = await runTakeoff(filePath, args.options);

  if (args.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    console.log(
      '\n⚠ REVIEW REQUIRED — Do not use this takeoff in an estimate without manual verification.',
    );
  } else {
    printSummary(result, filePath);
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
