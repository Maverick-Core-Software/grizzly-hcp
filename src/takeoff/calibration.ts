import type { Calibration, TakeoffWarning } from './types.js';

export interface CalibrationOptions {
  ftPerDrawingUnit?: number;
  drawingScale?: string;
  calibratePoints?: string;
}

// $INSUNITS → ft per drawing unit
const INSUNITS_MAP: Record<number, { ft: number; label: string }> = {
  1: { ft: 1 / 12, label: 'inches' },
  2: { ft: 1.0, label: 'feet' },
  4: { ft: 0.00328084, label: 'mm' },
  5: { ft: 0.0328084, label: 'cm' },
  6: { ft: 3.28084, label: 'meters' },
};

/**
 * Parse architectural / ratio scale notation to ft-per-drawing-unit.
 *
 * Supported forms:
 *   "1/8in=1ft"   → 0.125   (1/8 inch on paper = 1 foot real)
 *   "1/4"         → 0.25    (bare fraction treated as inch-to-foot ratio)
 *   "1:100"       → 1/100 * 3.28084 ft  (metric ratio)
 *   "1:48"        → 1/48 ft  (imperial ratio, 1 unit = 1/48 ft)
 */
function parseDrawingScale(raw: string): number | undefined {
  const s = raw.trim();

  // "1/8in=1ft" or "1/8"=1'-0"" — architectural paper:real
  const archMatch = s.match(/^(\d+)\/(\d+)\s*(?:in|"|')?(?:\s*=\s*1\s*(?:ft|'|foot))?/i);
  if (archMatch) {
    const num = parseInt(archMatch[1]!, 10);
    const den = parseInt(archMatch[2]!, 10);
    if (den !== 0) return num / den; // fraction of a foot per drawing unit
  }

  // "1:N" ratio — detect if likely metric (N ≥ 20) or imperial
  const ratioMatch = s.match(/^1\s*:\s*(\d+(?:\.\d+)?)$/);
  if (ratioMatch) {
    const n = parseFloat(ratioMatch[1]!);
    if (n >= 20) {
      // Treat as metric: 1 mm on paper = N mm real → N mm = N * 0.00328084 ft
      return (1 / n) * 3.28084;
    } else {
      // Treat as imperial: 1 drawing unit = 1/N feet
      return 1 / n;
    }
  }

  return undefined;
}

/**
 * Parse "known=20ft,p1=100:200,p2=580:200" calibration string.
 * Returns ft_per_drawing_unit based on pixel-distance between p1 and p2 vs known real-world length.
 */
function parseCalibratePoints(raw: string): number | undefined {
  const params: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }

  const knownStr = params['known'];
  const p1Str = params['p1'];
  const p2Str = params['p2'];
  if (!knownStr || !p1Str || !p2Str) return undefined;

  const knownFtMatch = knownStr.match(/^([\d.]+)\s*ft$/i);
  if (!knownFtMatch) return undefined;
  const knownFt = parseFloat(knownFtMatch[1]!);

  const parseCoord = (s: string): { x: number; y: number } | undefined => {
    const m = s.match(/^([\d.]+)\s*:\s*([\d.]+)$/);
    if (!m) return undefined;
    return { x: parseFloat(m[1]!), y: parseFloat(m[2]!) };
  };

  const p1 = parseCoord(p1Str);
  const p2 = parseCoord(p2Str);
  if (!p1 || !p2) return undefined;

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const drawingDist = Math.sqrt(dx * dx + dy * dy);
  if (drawingDist === 0) return undefined;

  return knownFt / drawingDist;
}

/** Scan title block text for a SCALE annotation and return ft_per_drawing_unit. */
function scanTitleBlock(texts: string[]): number | undefined {
  const scaleRe = /scale\s*[=:]?\s*([\d/]+(?:in)?(?:\s*=\s*1['-]?0?"?)?|1\s*:\s*\d+)/i;
  for (const t of texts) {
    const m = t.match(scaleRe);
    if (!m) continue;
    const parsed = parseDrawingScale(m[1]!);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export async function detectCalibration(input: {
  dxfHeader?: Record<string, unknown>;
  dxfTextEntities?: string[];
  options?: CalibrationOptions;
}): Promise<Calibration & { warnings?: TakeoffWarning[] }> {
  const { dxfHeader, dxfTextEntities, options } = input;

  // ── Level 1: User CLI flags ───────────────────────────────────────────────
  if (options) {
    if (options.ftPerDrawingUnit !== undefined) {
      return {
        source: 'user_confirmed',
        units: 'feet',
        ft_per_drawing_unit: options.ftPerDrawingUnit,
        scale_confidence: 'high',
      };
    }

    if (options.drawingScale) {
      const ft = parseDrawingScale(options.drawingScale);
      if (ft !== undefined) {
        return {
          source: 'user_confirmed',
          units: 'feet',
          ft_per_drawing_unit: ft,
          scale_confidence: 'high',
        };
      }
    }

    if (options.calibratePoints) {
      const ft = parseCalibratePoints(options.calibratePoints);
      if (ft !== undefined) {
        return {
          source: 'user_confirmed',
          units: 'feet',
          ft_per_drawing_unit: ft,
          scale_confidence: 'high',
        };
      }
    }
  }

  // ── Level 2: $INSUNITS from DXF header ───────────────────────────────────
  if (dxfHeader && '$INSUNITS' in dxfHeader) {
    const code = Number(dxfHeader['$INSUNITS']);
    if (code !== 0 && INSUNITS_MAP[code]) {
      const { ft, label } = INSUNITS_MAP[code]!;
      return {
        source: 'dxf_insunits',
        units: label,
        ft_per_drawing_unit: ft,
        scale_confidence: 'high',
      };
    }
    // code === 0 means unitless — fall through
  }

  // ── Level 3: Title block text scan ───────────────────────────────────────
  if (dxfTextEntities && dxfTextEntities.length > 0) {
    const ft = scanTitleBlock(dxfTextEntities);
    if (ft !== undefined) {
      return {
        source: 'title_block',
        units: 'feet',
        ft_per_drawing_unit: ft,
        scale_confidence: 'medium',
      };
    }
  }

  // ── Level 4: Unknown fallback ─────────────────────────────────────────────
  const warning: TakeoffWarning = {
    code: 'SCALE_UNKNOWN',
    message: 'No scale detected — routing lengths will not be computed',
    severity: 'warning',
  };

  return {
    source: 'unknown',
    units: 'unknown',
    ft_per_drawing_unit: undefined,
    scale_confidence: 'low',
    warnings: [warning],
  };
}
