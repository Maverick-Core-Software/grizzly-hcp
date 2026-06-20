import type { DetectionEvidence, ExcludedDetection } from '../types.js';

export interface ReconcileInput {
  dxfDetections: DetectionEvidence[];
  visionDetections: DetectionEvidence[];
  symbolSizePx?: number; // unused in current merge strategy, kept for API stability
}

export interface ReconcileResult {
  detections: DetectionEvidence[];
  excluded: ExcludedDetection[];
}

export function reconcileDetections(input: ReconcileInput): ReconcileResult {
  const { dxfDetections, visionDetections } = input;

  const detections: DetectionEvidence[] = [...dxfDetections];
  const excluded: ExcludedDetection[] = [];

  // Build a lookup set of (device_type, sheet, region) for existing DXF detections
  const dxfKeys = new Set(
    dxfDetections.map((d) => `${d.device_type}|${d.sheet}|${d.region}`),
  );

  const visionOnly = dxfDetections.length === 0;

  for (const v of visionDetections) {
    const key = `${v.device_type}|${v.sheet}|${v.region}`;
    if (dxfKeys.has(key)) {
      // DXF detection already covers this tile — vision is a duplicate
      excluded.push({
        raw_symbol: v.raw_symbol,
        sheet: v.sheet,
        region: v.region,
        exclusion_reason: 'duplicate',
      });
    } else {
      // No DXF coverage — include vision detection
      if (visionOnly && v.confidence === 'high') {
        detections.push({ ...v, confidence: 'medium' });
      } else {
        detections.push(v);
      }
    }
  }

  return { detections, excluded };
}
