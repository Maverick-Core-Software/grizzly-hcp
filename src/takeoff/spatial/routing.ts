import type { DxfEntity, DetectionEvidence, Calibration, RoutingLength, TakeoffWarning } from '../types.js';

export interface RoutingResult {
  lengths: Record<string, RoutingLength>;
  panelLocation?: { x: number; y: number };
  panelSource?: string;
  warnings: TakeoffWarning[];
  assumptions: string[];
}

const PANEL_BLOCK_NAMES = ['PANEL', 'ELEC-PANEL', 'MDP', 'MSB', 'LP', 'DP', 'MAIN', 'DIST'];
const PANEL_TEXT_PATTERNS = ['ELECTRICAL ROOM', 'ELEC RM', 'PANEL ROOM', 'MDP', 'MAIN PANEL', 'LP-', 'DP-'];

const SLACK_FACTOR = 1.35;

function findPanel(entities: DxfEntity[]): { x: number; y: number; source: string } | null {
  // Priority 1: INSERT block whose blockName contains a panel keyword
  for (const e of entities) {
    if (e.type === 'INSERT' && e.blockName && e.position) {
      const name = e.blockName.toUpperCase();
      if (PANEL_BLOCK_NAMES.some((kw) => name.includes(kw))) {
        return {
          x: e.position.x,
          y: e.position.y,
          source: `INSERT block '${e.blockName}' at (${e.position.x}, ${e.position.y})`,
        };
      }
    }
  }

  // Priority 2: TEXT/MTEXT entity whose text contains a panel keyword
  for (const e of entities) {
    if ((e.type === 'TEXT' || e.type === 'MTEXT') && e.text && e.position) {
      const txt = e.text.toUpperCase();
      if (PANEL_TEXT_PATTERNS.some((kw) => txt.includes(kw))) {
        return {
          x: e.position.x,
          y: e.position.y,
          source: `${e.type} '${e.text.trim()}' at (${e.position.x}, ${e.position.y})`,
        };
      }
    }
  }

  return null;
}

function zero(): RoutingLength {
  return { min_ft: 0, nominal_ft: 0, max_ft: 0 };
}

export function estimateRoutingLengths(
  entities: DxfEntity[],
  calibration: Calibration,
  detections: DetectionEvidence[],
): RoutingResult {
  const warnings: TakeoffWarning[] = [];
  const assumptions: string[] = [];

  const panel = findPanel(entities);

  if (!panel) {
    warnings.push({
      code: 'PANEL_NOT_FOUND',
      message: 'Panel location not found in DXF — routing lengths skipped',
      severity: 'warning',
    });
    return { lengths: {}, warnings, assumptions };
  }

  assumptions.push(`Panel located at drawing coords (${panel.x}, ${panel.y}) from ${panel.source}`);

  const hasCal =
    calibration.ft_per_drawing_unit !== undefined && calibration.scale_confidence !== 'low';

  let scaleWarnEmitted = false;

  // Accumulate nominal ft per device_type (only DXF-sourced detections)
  const totals: Record<string, number> = {};

  for (const d of detections) {
    if (d.method !== 'dxf_block') continue;
    if (!d.bbox_drawing) continue;

    const cx = d.bbox_drawing.x + d.bbox_drawing.width / 2;
    const cy = d.bbox_drawing.y + d.bbox_drawing.height / 2;
    const manhattan = Math.abs(cx - panel.x) + Math.abs(cy - panel.y);
    const slacked = manhattan * SLACK_FACTOR;

    if (!hasCal) {
      if (!scaleWarnEmitted) {
        warnings.push({
          code: 'SCALE_UNKNOWN',
          message: 'Cannot compute routing lengths — scale unknown',
          severity: 'warning',
        });
        scaleWarnEmitted = true;
      }
      totals[d.device_type] = (totals[d.device_type] ?? 0) + 0;
    } else {
      const ft = slacked * calibration.ft_per_drawing_unit!;
      totals[d.device_type] = (totals[d.device_type] ?? 0) + ft;
    }
  }

  const lengths: Record<string, RoutingLength> = {};
  for (const [dtype, nominal] of Object.entries(totals)) {
    if (!hasCal) {
      lengths[dtype] = zero();
    } else {
      lengths[dtype] = {
        min_ft: nominal * 0.85,
        nominal_ft: nominal,
        max_ft: nominal * 1.15,
      };
    }
  }

  return {
    lengths,
    panelLocation: { x: panel.x, y: panel.y },
    panelSource: panel.source,
    warnings,
    assumptions,
  };
}
