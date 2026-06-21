import { readFile } from 'fs/promises';
import { join } from 'path';
import { loadLaborFactors, computeLabor } from './labor.js';
import type {
  TakeoffResult,
  DetectionEvidence,
  ExcludedDetection,
  TakeoffWarning,
  PanelSchedule,
  Calibration,
} from './types.js';
import type { RoutingResult } from './spatial/routing.js';

export interface AggregatorInput {
  sourceFiles: string[];
  allDetections: DetectionEvidence[];
  allExcluded: ExcludedDetection[];
  allWarnings: TakeoffWarning[];
  allAssumptions: string[];
  panels: PanelSchedule[];
  circuitCount: number;
  circuitNotes: string[];
  routing: RoutingResult;
  calibration: Calibration;
}

export async function buildTakeoffResult(input: AggregatorInput): Promise<TakeoffResult> {
  const {
    sourceFiles,
    allDetections,
    allExcluded,
    allWarnings,
    allAssumptions,
    panels,
    circuitCount,
    circuitNotes,
    routing,
    calibration,
  } = input;

  // Read pipeline_version from package.json
  let pipeline_version = 'unknown';
  try {
    const pkgRaw = await readFile(join(process.cwd(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw) as { version?: string };
    pipeline_version = pkg.version ?? 'unknown';
  } catch {
    // leave as 'unknown'
  }

  // Model versions from env vars
  const model_versions: Record<string, string> = {
    classifier: process.env['TAKEOFF_CLASSIFIER_MODEL'] ?? 'claude-haiku-4-5-20251001',
    counter: process.env['TAKEOFF_MODEL'] ?? 'claude-sonnet-4-6',
  };

  // Aggregate device counts
  const devices: Record<string, number> = {};
  for (const d of allDetections) {
    devices[d.device_type] = (devices[d.device_type] ?? 0) + 1;
  }

  // Routing totals
  const routingTotalNominalFt = Object.values(routing.lengths).reduce(
    (sum, r) => sum + r.nominal_ft,
    0,
  );

  // Labor
  const factors = await loadLaborFactors();
  const laborResult = computeLabor(devices, routingTotalNominalFt, factors);

  // Routing output
  const estimated_routing_lengths: TakeoffResult['estimated_routing_lengths'] = {
    by_type: routing.lengths,
    calibration_method: routing.panelSource ?? 'unknown',
    note: 'Computed via Manhattan distance × 1.35. Verify before material purchase.',
  };

  // Confidence levels
  const dxfCount = allDetections.filter(d => d.method === 'dxf_block').length;
  const total = allDetections.length;
  const dxfRatio = total > 0 ? dxfCount / total : 0;

  const device_counts_confidence: 'high' | 'medium' | 'low' =
    dxfRatio > 0.5 ? 'high' : dxfRatio > 0.2 ? 'medium' : 'low';

  return {
    schema_version: 'takeoff.v1',
    pipeline_version,
    model_versions,
    devices,
    estimated_routing_lengths,
    circuits: { count: circuitCount, notes: circuitNotes },
    panels,
    labor: {
      rough_in_hours: laborResult.rough_in_hours,
      trim_out_hours: laborResult.trim_out_hours,
      panel_hours: laborResult.panel_hours,
      total_hours: laborResult.total_hours,
    },
    confidence: {
      device_counts: device_counts_confidence,
      routing_lengths: calibration.scale_confidence,
      panel_schedules: panels.length > 0 ? 'high' : 'low',
    },
    calibration,
    detections: allDetections,
    excluded_detections: allExcluded,
    assumptions: allAssumptions,
    warnings: allWarnings,
    notes: [],
    source_files: sourceFiles,
    requires_human_review: true,
  };
}
