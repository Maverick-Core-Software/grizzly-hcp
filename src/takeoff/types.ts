export type SheetType =
  | 'electrical-plan'
  | 'lighting-plan'
  | 'power-plan'
  | 'panel-schedule'
  | 'riser'
  | 'legend'
  | 'title'
  | 'detail'
  | 'specification'
  | 'other';

export interface PanelSchedule {
  panelId: string;
  location?: string;
  voltage?: string;
  amperage?: number;
  circuits: Array<{
    number: number;
    description: string;
    amperage?: number;
    poles?: number;
    notes?: string;
  }>;
}

export interface SymbolLegend {
  entries: Array<{
    rawSymbol: string;
    deviceType: string;
    description?: string;
  }>;
  source: string; // which sheet/page it came from
}

export interface DetectionEvidence {
  device_type: string;
  raw_symbol: string;
  method: 'dxf_block' | 'vision_bbox' | 'vision_text' | 'panel_schedule';
  sheet: string;
  region: string;
  entity_id?: string;
  bbox_px?: { x: number; y: number; width: number; height: number };
  bbox_drawing?: { x: number; y: number; width: number; height: number };
  transform_id?: string;
  page_width_px?: number;
  page_height_px?: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExcludedDetection {
  raw_symbol: string;
  sheet: string;
  region: string;
  exclusion_reason: 'legend' | 'detail' | 'duplicate' | 'low_confidence' | 'non_plan_sheet' | 'title_block';
}

export interface TakeoffWarning {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface Calibration {
  source: 'dxf_insunits' | 'title_block' | 'dimension_annotation' | 'user_confirmed' | 'unknown';
  units: string;
  ft_per_drawing_unit?: number;
  scale_confidence: 'high' | 'medium' | 'low';
}

export interface RoutingLength {
  min_ft: number;
  nominal_ft: number;
  max_ft: number;
}

export interface TakeoffResult {
  schema_version: 'takeoff.v1';
  pipeline_version: string;
  model_versions: Record<string, string>;

  devices: Record<string, number>;
  estimated_routing_lengths: {
    by_type: Record<string, RoutingLength>;
    calibration_method: string;
    note: string;
  };
  circuits: { count: number; notes: string[] };
  panels: PanelSchedule[];
  labor: {
    rough_in_hours: number;
    trim_out_hours: number;
    panel_hours: number;
    total_hours: number;
  };
  confidence: {
    device_counts: 'high' | 'medium' | 'low';
    routing_lengths: 'high' | 'medium' | 'low';
    panel_schedules: 'high' | 'medium' | 'low';
  };
  calibration: Calibration;
  detections: DetectionEvidence[];
  excluded_detections: ExcludedDetection[];
  assumptions: string[];
  warnings: TakeoffWarning[];
  notes: string[];
  source_files: string[];
  requires_human_review: true;
}

// Parsed DXF entity types for internal use
export interface DxfEntity {
  type: string;
  handle?: string;
  layer?: string;
  blockName?: string;
  position?: { x: number; y: number };
  text?: string;
  vertices?: Array<{ x: number; y: number }>;
}

// Internal representation of a parsed DXF sheet
export interface ParsedDxf {
  entities: DxfEntity[];
  svgContent: string;
  layers: string[];
  header: Record<string, unknown>;
}

// Internal representation of a parsed PDF page
export interface ParsedPdfPage {
  pageNumber: number;
  text: string;
  imagePng: Buffer;
  tiles: Array<{
    label: string;
    image: Buffer;
    offsetX: number;
    offsetY: number;
    widthPx: number;
    heightPx: number;
    pageWidthPx: number;
    pageHeightPx: number;
  }>;
}
