import { readFile } from 'fs/promises';
import { join } from 'path';

export interface LaborFactors {
  [deviceType: string]: number | undefined;
  per_100ft_run?: number;
}

export interface LaborResult {
  rough_in_hours: number;
  trim_out_hours: number;
  panel_hours: number;
  total_hours: number;
  breakdown: Record<string, number>;
}

const PANEL_TYPES = new Set(['panel_main', 'panel_sub']);
const DEFAULT_HOURS_PER_DEVICE = 0.75;
const DEFAULT_PER_100FT = 2.0;

const DEFAULTS: LaborFactors = {
  duplex_receptacle: 0.75,
  gfci_receptacle: 1.0,
  afci_receptacle: 1.0,
  switch_single: 0.75,
  switch_3way: 1.25,
  switch_dimmer: 1.0,
  smoke_detector: 0.5,
  co_detector: 0.5,
  exhaust_fan: 1.5,
  light_fixture: 1.0,
  recessed_light: 0.75,
  panel_main: 12.0,
  panel_sub: 8.0,
  ev_charger: 3.0,
  exit_light: 0.75,
  emergency_light: 0.75,
  junction_box: 0.5,
  disconnect: 2.0,
  transformer: 4.0,
  meter: 2.0,
  per_100ft_run: 2.0,
};

export async function loadLaborFactors(): Promise<LaborFactors> {
  const configPath = join(process.cwd(), 'config', 'labor-factors.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as LaborFactors;
  } catch {
    return { ...DEFAULTS };
  }
}

export function computeLabor(
  devices: Record<string, number>,
  routingTotalNominalFt: number,
  factors: LaborFactors,
): LaborResult {
  let rough_in_hours = 0;
  let trim_out_hours = 0;
  let panel_hours = 0;
  const breakdown: Record<string, number> = {};

  for (const [dtype, count] of Object.entries(devices)) {
    const hoursEach = factors[dtype] ?? DEFAULT_HOURS_PER_DEVICE;
    const total = hoursEach * count;
    breakdown[dtype] = total;

    if (PANEL_TYPES.has(dtype)) {
      panel_hours += total;
    } else {
      rough_in_hours += total * 0.6;
      trim_out_hours += total * 0.4;
    }
  }

  // Wire run hours → rough-in only
  const wireHours = (routingTotalNominalFt / 100) * (factors.per_100ft_run ?? DEFAULT_PER_100FT);
  rough_in_hours += wireHours;

  const total_hours = rough_in_hours + trim_out_hours + panel_hours;

  return { rough_in_hours, trim_out_hours, panel_hours, total_hours, breakdown };
}
