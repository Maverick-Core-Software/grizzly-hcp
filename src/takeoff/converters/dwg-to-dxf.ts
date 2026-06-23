import 'dotenv/config';
import { spawn } from 'child_process';
import { access, constants, cp, mkdir, rm } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ODA's first launch in a session does a cold GUI/Qt init that can exceed 30s;
// warm launches finish in seconds. 120s covers the cold start.
const ODA_TIMEOUT_MS = 120_000;

function getOdaPath(): string {
  const p = process.env['ODA_CONVERTER_PATH'];
  if (!p) {
    throw new Error(
      'ODA_CONVERTER_PATH not set. Download ODA File Converter from opendesign.com and set this env var.'
    );
  }
  return p;
}

async function assertBinaryExists(odaPath: string): Promise<void> {
  try {
    await access(odaPath, constants.X_OK);
  } catch {
    throw new Error(
      `ODA File Converter not found at ${odaPath}. Download from opendesign.com.`
    );
  }
}

/**
 * Run ODA File Converter with no args to verify it responds without "file not found".
 * Used as a startup diagnostic (--check flag).
 */
export async function checkOdaConverter(): Promise<void> {
  const odaPath = getOdaPath();
  await assertBinaryExists(odaPath);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(odaPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', (d: Buffer) => (output += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (output += d.toString()));
    proc.on('close', () => {
      // ODA exits non-zero when run with no args but should not say "not found"
      if (output.toLowerCase().includes('no such file') || output.toLowerCase().includes('not found')) {
        reject(new Error(`ODA File Converter check failed: ${output.trim()}`));
      } else {
        resolve();
      }
    });
    proc.on('error', (err) => reject(new Error(`ODA File Converter check error: ${err.message}`)));
  });
}

/**
 * Convert a DWG file to DXF using the ODA File Converter CLI.
 * Returns the path to the converted DXF file in a temp directory.
 * The caller (or OS reboot) is responsible for cleaning up the temp dir on success.
 */
export async function dwgToDxf(dwgPath: string): Promise<string> {
  const odaPath = getOdaPath();
  await assertBinaryExists(odaPath);

  const tempDir = join(tmpdir(), `oda-${randomUUID()}`);
  const srcDir = join(tempDir, 'src');
  const outDir = join(tempDir, 'out');

  await mkdir(srcDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  // Copy input DWG into the isolated src dir
  const dwgName = basename(dwgPath);
  await cp(dwgPath, join(srcDir, dwgName));

  const dxfName = dwgName.replace(/\.dwg$/i, '.dxf');
  const dxfPath = join(outDir, dxfName);

  // ODA CLI signature: <binary> <srcDir> <outDir> <outVersion> <outFileType> <recurse> <audit> <filter>
  // OutputVersion comes BEFORE OutputFileType. Swapping them makes ODA silently no-op (exit 0, no file).
  const args = [srcDir, outDir, 'ACAD2018', 'DXF', '0', '1', '*.DWG'];

  let stdout = '';
  let stderr = '';

  const exitCode = await new Promise<number>((resolve, reject) => {
    const proc = spawn(odaPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('ODA File Converter timed out after 30s'));
    }, ODA_TIMEOUT_MS);

    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ODA File Converter process error: ${err.message}`));
    });
  }).catch(async (err: Error) => {
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  });

  const combined = stdout + stderr;
  const auditLines = combined
    .split('\n')
    .filter((l) => /Warning|Error/i.test(l))
    .map((l) => l.trim())
    .filter(Boolean);

  if (exitCode !== 0 || auditLines.length > 0) {
    const hasError = exitCode !== 0 || auditLines.some((l) => /Error/i.test(l));
    if (hasError) {
      await rm(tempDir, { recursive: true, force: true });
      const detail = auditLines.length > 0 ? auditLines.join('\n') : combined.trim();
      throw new Error(`ODA File Converter failed (exit ${exitCode}):\n${detail}`);
    }
    // Warnings only — log but continue
    console.warn('[dwgToDxf] ODA audit warnings:\n' + auditLines.join('\n'));
  }

  return dxfPath;
}
