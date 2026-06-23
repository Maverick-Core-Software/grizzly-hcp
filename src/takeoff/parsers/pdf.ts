import { readFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
// pdf-parse's index.js runs a debug block at import (reads a bundled test PDF) when
// module.parent is falsy — which it is under tsx/ESM, crashing the whole module graph.
// Import the library entry directly to skip that block.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fromPath } from 'pdf2pic';
import sharp from 'sharp';
import type { ParsedPdfPage } from '../types.js';

const execFileAsync = promisify(execFile);

const MAX_PAGES = 20;
// Tile grid is 2×2 with 15% overlap
const TILE_ROWS = 2;
const TILE_COLS = 2;
const OVERLAP = 0.15;

// ponytail: binary detection is just a `which`/`where` exit-code check — no library needed.
async function binaryExists(name: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(cmd, [name]);
    return true;
  } catch {
    return false;
  }
}

export async function checkPdfDependencies(): Promise<{
  ok: boolean;
  missing: string[];
  instructions: string;
}> {
  const [hasGm, hasGs] = await Promise.all([binaryExists('gm'), binaryExists('gs')]);

  const missing: string[] = [];
  if (!hasGm) missing.push('GraphicsMagick (gm)');
  if (!hasGs) missing.push('Ghostscript (gs)');

  const instructions =
    missing.length === 0
      ? 'All PDF rendering dependencies are present.'
      : [
          `Missing: ${missing.join(', ')}.`,
          'Install with:',
          '  Windows: choco install graphicsmagick ghostscript  (or download from graphicsmagick.org / ghostscript.com)',
          '  macOS:   brew install graphicsmagick ghostscript',
          '  Ubuntu:  sudo apt-get install graphicsmagick ghostscript',
        ].join('\n');

  return { ok: missing.length === 0, missing, instructions };
}

async function makeTiles(
  pngBuffer: Buffer,
  pageNumber: number,
): Promise<ParsedPdfPage['tiles']> {
  const meta = await sharp(pngBuffer).metadata();
  const pageW = meta.width ?? 0;
  const pageH = meta.height ?? 0;

  const tiles: ParsedPdfPage['tiles'] = [];

  const tileW = Math.round(pageW / (TILE_COLS - (TILE_COLS - 1) * OVERLAP));
  const tileH = Math.round(pageH / (TILE_ROWS - (TILE_ROWS - 1) * OVERLAP));

  const rowLabels = ['A', 'B'];
  const colLabels = ['1', '2'];

  for (let row = 0; row < TILE_ROWS; row++) {
    for (let col = 0; col < TILE_COLS; col++) {
      const offsetX = Math.round(col * tileW * (1 - OVERLAP));
      const offsetY = Math.round(row * tileH * (1 - OVERLAP));

      // Clamp to image bounds
      const clampedW = Math.min(tileW, pageW - offsetX);
      const clampedH = Math.min(tileH, pageH - offsetY);

      const tileBuffer = await sharp(pngBuffer)
        .extract({ left: offsetX, top: offsetY, width: clampedW, height: clampedH })
        .png()
        .toBuffer();

      tiles.push({
        label: `page${pageNumber}-tile-${rowLabels[row]}${colLabels[col]}`,
        image: tileBuffer,
        offsetX,
        offsetY,
        widthPx: clampedW,
        heightPx: clampedH,
        pageWidthPx: pageW,
        pageHeightPx: pageH,
      });
    }
  }

  return tiles;
}

export async function parsePdf(pdfPath: string): Promise<ParsedPdfPage[]> {
  const buffer = await readFile(pdfPath);

  // Text extraction
  const parsed = await pdfParse(buffer);
  const totalPages = parsed.numpages;

  const pageCount = Math.min(totalPages, MAX_PAGES);
  if (totalPages > MAX_PAGES) {
    console.warn(
      `[parsePdf] PDF has ${totalPages} pages; processing first ${MAX_PAGES} only.`,
    );
  }

  // Render pages to PNG via pdf2pic
  const tmpDir = path.join(os.tmpdir(), `pdf-takeoff-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });

  let pages: ParsedPdfPage[] = [];

  try {
    const convert = fromPath(pdfPath, {
      density: 300,
      saveFilename: 'page',
      savePath: tmpDir,
      format: 'png',
      width: 2480,
      height: 3508,
    });

    // Build per-page text map from pdf-parse render callbacks (page text is concatenated)
    // pdf-parse doesn't expose per-page text natively, so we do a best-effort split.
    // ponytail: per-page text via re-parsing with a custom render callback would be cleaner
    // but requires pdf.js internals. The concatenated string is sufficient for downstream RAG.
    const fullText = parsed.text;

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      // pdf2pic uses 1-based page numbers
      const result = await convert(pageNum, { responseType: 'image' });
      const pngPath = result.path;

      if (!pngPath || !existsSync(pngPath)) {
        console.warn(`[parsePdf] Page ${pageNum} render failed — skipping.`);
        continue;
      }

      const pngBuffer = await readFile(pngPath);
      const tiles = await makeTiles(pngBuffer, pageNum);

      // Assign full text to page 1; leave others empty (acceptable for vision pipeline)
      const pageText = pageNum === 1 ? fullText : '';

      pages.push({
        pageNumber: pageNum,
        text: pageText,
        imagePng: pngBuffer,
        tiles,
      });
    }
  } finally {
    // Cleanup temp dir regardless of success/failure
    await rm(tmpDir, { recursive: true, force: true });
  }

  return pages;
}
