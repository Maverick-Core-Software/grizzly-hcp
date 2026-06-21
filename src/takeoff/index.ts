import path from 'path';
import sharp from 'sharp';
import { dwgToDxf } from './converters/dwg-to-dxf.js';
import { detectCalibration } from './calibration.js';
import type { CalibrationOptions } from './calibration.js';
import { parseDxf, filterElectricalEntities } from './parsers/dxf.js';
import { parsePdf } from './parsers/pdf.js';
import { parseRaster } from './parsers/raster.js';
import { classifySheet } from './vision/sheet-classifier.js';
import { extractLegend } from './vision/legend-extractor.js';
import { countSymbols } from './vision/symbol-counter.js';
import { extractPanelSchedule } from './vision/panel-parser.js';
import { reconcileDetections } from './spatial/reconciler.js';
import { estimateRoutingLengths } from './spatial/routing.js';
import { buildTakeoffResult } from './aggregator.js';
import type {
  TakeoffResult,
  DetectionEvidence,
  ExcludedDetection,
  TakeoffWarning,
  PanelSchedule,
  SymbolLegend,
} from './types.js';

export interface TakeoffOptions {
  ftPerDrawingUnit?: number;
  drawingScale?: string;
  calibratePoints?: string;
}

const BLOCK_TO_DEVICE: Record<string, string> = {
  'RECEPT': 'duplex_receptacle',
  'OUTLET': 'duplex_receptacle',
  'DUPLEX': 'duplex_receptacle',
  'GFCI': 'gfci_receptacle',
  'AFCI': 'afci_receptacle',
  'SW': 'switch_single',
  'SWITCH': 'switch_single',
  '3WAY': 'switch_3way',
  'DIMMER': 'switch_dimmer',
  'SMOKE': 'smoke_detector',
  'CO': 'co_detector',
  'FAN': 'exhaust_fan',
  'LIGHT': 'light_fixture',
  'FIXTURE': 'light_fixture',
  'RECESS': 'recessed_light',
  'CAN': 'recessed_light',
  'PANEL': 'panel_main',
  'MDP': 'panel_main',
  'MSB': 'panel_main',
  'LP': 'panel_sub',
  'DP': 'panel_sub',
  'EV': 'ev_charger',
  'CHARGER': 'ev_charger',
  'EXIT': 'exit_light',
  'EMERG': 'emergency_light',
  'JB': 'junction_box',
  'DISC': 'disconnect',
  'XFMR': 'transformer',
  'METER': 'meter',
};

function normalizeBlockName(blockName: string): string {
  const upper = blockName.toUpperCase();
  for (const [key, value] of Object.entries(BLOCK_TO_DEVICE)) {
    if (upper.includes(key)) return value;
  }
  return blockName.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

const TILE_ROWS = 2;
const TILE_COLS = 2;
const OVERLAP = 0.15;

async function tileImage(
  imageBuffer: Buffer,
  label: string,
): Promise<Array<{ label: string; image: Buffer; pageWidthPx: number; pageHeightPx: number }>> {
  const meta = await sharp(imageBuffer).metadata();
  const pageW = meta.width ?? 0;
  const pageH = meta.height ?? 0;

  const tileW = Math.round(pageW / (TILE_COLS - (TILE_COLS - 1) * OVERLAP));
  const tileH = Math.round(pageH / (TILE_ROWS - (TILE_ROWS - 1) * OVERLAP));

  const rowLabels = ['A', 'B'];
  const colLabels = ['1', '2'];
  const tiles: Array<{ label: string; image: Buffer; pageWidthPx: number; pageHeightPx: number }> = [];

  for (let row = 0; row < TILE_ROWS; row++) {
    for (let col = 0; col < TILE_COLS; col++) {
      const offsetX = Math.round(col * tileW * (1 - OVERLAP));
      const offsetY = Math.round(row * tileH * (1 - OVERLAP));
      const clampedW = Math.min(tileW, pageW - offsetX);
      const clampedH = Math.min(tileH, pageH - offsetY);

      const tileBuffer = await sharp(imageBuffer)
        .extract({ left: offsetX, top: offsetY, width: clampedW, height: clampedH })
        .png()
        .toBuffer();

      tiles.push({
        label: `${label}-tile-${rowLabels[row]}${colLabels[col]}`,
        image: tileBuffer,
        pageWidthPx: pageW,
        pageHeightPx: pageH,
      });
    }
  }

  return tiles;
}

export async function runTakeoff(filePath: string, options?: TakeoffOptions): Promise<TakeoffResult> {
  const ext = path.extname(filePath).toLowerCase();
  const calOptions: CalibrationOptions = {
    ftPerDrawingUnit: options?.ftPerDrawingUnit,
    drawingScale: options?.drawingScale,
    calibratePoints: options?.calibratePoints,
  };

  // ── DWG: convert to DXF first ──────────────────────────────────────────────
  if (ext === '.dwg') {
    const dxfPath = await dwgToDxf(filePath);
    return runTakeoff(dxfPath, options);
  }

  // ── DXF path ───────────────────────────────────────────────────────────────
  if (ext === '.dxf') {
    const parsed = await parseDxf(filePath);

    const textEntities = parsed.entities
      .filter(e => (e.type === 'TEXT' || e.type === 'MTEXT') && e.text)
      .map(e => e.text as string);

    const calibrationRaw = await detectCalibration({
      dxfHeader: parsed.header,
      dxfTextEntities: textEntities,
      options: calOptions,
    });
    const { warnings: calWarnings, ...calibration } = calibrationRaw;

    const electricalEntities = filterElectricalEntities(parsed.entities);

    // Build DXF detections from INSERT entities
    const dxfDetections: DetectionEvidence[] = electricalEntities
      .filter(e => e.type === 'INSERT' && e.blockName && e.position)
      .map(e => ({
        device_type: normalizeBlockName(e.blockName!),
        raw_symbol: e.blockName!,
        method: 'dxf_block' as const,
        sheet: 'dxf',
        region: 'full',
        entity_id: e.handle,
        bbox_drawing: {
          x: e.position!.x,
          y: e.position!.y,
          width: 0,
          height: 0,
        },
        confidence: 'high' as const,
      }));

    // Render SVG for vision — convert SVG string to PNG buffer via sharp
    let visionDetections: DetectionEvidence[] = [];
    const allWarnings: TakeoffWarning[] = [...(calWarnings ?? [])];

    try {
      const svgBuffer = Buffer.from(parsed.svgContent, 'utf-8');
      const pngBuffer = await sharp(svgBuffer).png().toBuffer();

      const classified = await classifySheet(pngBuffer, 'dxf');
      const planTypes = new Set(['electrical-plan', 'lighting-plan', 'power-plan', 'riser']);

      if (planTypes.has(classified.type)) {
        const tiles = await tileImage(pngBuffer, 'dxf');
        const countResult = await countSymbols(tiles, 'dxf');
        visionDetections = countResult.detections;
        allWarnings.push(...countResult.warnings);
      }
    } catch (err) {
      allWarnings.push({
        code: 'DXF_VISION_FAILED',
        message: `DXF SVG vision pass skipped: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }

    const reconciled = reconcileDetections({ dxfDetections, visionDetections });
    const routing = estimateRoutingLengths(electricalEntities, calibration, reconciled.detections);

    return buildTakeoffResult({
      sourceFiles: [filePath],
      allDetections: reconciled.detections,
      allExcluded: reconciled.excluded,
      allWarnings: [...allWarnings, ...routing.warnings],
      allAssumptions: routing.assumptions,
      panels: [],
      circuitCount: 0,
      circuitNotes: [],
      routing,
      calibration,
    });
  }

  // ── PDF path ───────────────────────────────────────────────────────────────
  if (ext === '.pdf') {
    const pages = await parsePdf(filePath);

    const allDetections: DetectionEvidence[] = [];
    const allExcluded: ExcludedDetection[] = [];
    const allWarnings: TakeoffWarning[] = [];
    const allAssumptions: string[] = [];
    const panels: PanelSchedule[] = [];
    let legend: SymbolLegend | undefined;

    const planTypes = new Set(['electrical-plan', 'lighting-plan', 'power-plan', 'riser']);

    for (const page of pages) {
      const sheetId = `page${page.pageNumber}`;
      const classified = await classifySheet(page.imagePng, sheetId, page.text);

      if (classified.type === 'legend') {
        const extracted = await extractLegend(page.imagePng, sheetId);
        if (extracted) legend = extracted;

      } else if (classified.type === 'panel-schedule') {
        const result = await extractPanelSchedule(page.imagePng, sheetId, page.text);
        panels.push(...result.panels);
        allWarnings.push(...result.warnings);

      } else if (planTypes.has(classified.type)) {
        const result = await countSymbols(page.tiles, sheetId, legend);
        allDetections.push(...result.detections);
        allExcluded.push(...result.excluded);
        allWarnings.push(...result.warnings);
      }
    }

    const calibration = await detectCalibration({ options: calOptions });
    const { warnings: calWarnings } = calibration as typeof calibration & { warnings?: TakeoffWarning[] };
    if (calWarnings) allWarnings.push(...calWarnings);

    const routing = estimateRoutingLengths([], calibration, allDetections);
    allWarnings.push(...routing.warnings);
    allAssumptions.push(...routing.assumptions);

    return buildTakeoffResult({
      sourceFiles: [filePath],
      allDetections,
      allExcluded,
      allWarnings,
      allAssumptions,
      panels,
      circuitCount: 0,
      circuitNotes: [],
      routing,
      calibration,
    });
  }

  // ── Raster path (PNG / JPG / TIFF) ────────────────────────────────────────
  const rasterExts = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif']);
  if (rasterExts.has(ext)) {
    const { image } = await parseRaster(filePath);

    const allDetections: DetectionEvidence[] = [];
    const allExcluded: ExcludedDetection[] = [];
    const allWarnings: TakeoffWarning[] = [];

    const classified = await classifySheet(image, 'raster');
    const tiles = await tileImage(image, 'raster');
    const result = await countSymbols(tiles, 'raster');
    allDetections.push(...result.detections);
    allExcluded.push(...result.excluded);
    allWarnings.push(...result.warnings);

    // Classify result is available but not consumed further (raster has no legend pass)
    void classified;

    const calibration = await detectCalibration({ options: calOptions });
    const { warnings: calWarnings } = calibration as typeof calibration & { warnings?: TakeoffWarning[] };
    if (calWarnings) allWarnings.push(...calWarnings);

    const routing = estimateRoutingLengths([], calibration, allDetections);
    allWarnings.push(...routing.warnings);

    return buildTakeoffResult({
      sourceFiles: [filePath],
      allDetections,
      allExcluded,
      allWarnings,
      allAssumptions: routing.assumptions,
      panels: [],
      circuitCount: 0,
      circuitNotes: [],
      routing,
      calibration,
    });
  }

  throw new Error(
    `Unsupported file format: "${ext}". Supported: .dwg, .dxf, .pdf, .png, .jpg, .jpeg, .tiff, .tif`,
  );
}
