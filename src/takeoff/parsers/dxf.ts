import { readFile } from 'fs/promises';
import { parseString, denormalise, toSVG } from 'dxf';
import type { Entities } from 'dxf';
import type { DxfEntity, ParsedDxf } from '../types.js';

export const ELECTRICAL_LAYER_PREFIXES = ['E-', 'ELEC', 'POWER', 'LTNG', 'EL-'];

export function isElectricalLayer(layerName: string): boolean {
  const upper = layerName.toUpperCase();
  return ELECTRICAL_LAYER_PREFIXES.some(
    prefix => upper.startsWith(prefix) || upper.includes(prefix),
  );
}

export function filterElectricalEntities(entities: DxfEntity[]): DxfEntity[] {
  const electrical = entities.filter(e => e.layer && isElectricalLayer(e.layer));
  // If no electrical layers found, return all entities (caller gets a warning elsewhere)
  return electrical.length > 0 ? electrical : entities;
}

function mapEntity(raw: Entities.Entity): DxfEntity {
  // raw.type is EntityType | undefined on some Partial<CommonEntityData> variants
  const rawType = (raw as unknown as { type?: string }).type ?? 'UNKNOWN';
  const entity: DxfEntity = { type: rawType };

  // CommonEntityData carries handle and layer
  const common = raw as unknown as { handle?: string; layer?: string | undefined };
  if (common.handle !== undefined) entity.handle = String(common.handle);
  // CommonEntityData.layer is `string` (not optional), but denormalised entities may lack it
  if (common.layer != null) entity.layer = String(common.layer);

  if (raw.type === 'INSERT') {
    const r = raw as Entities.Insert;
    if (r.block !== undefined) entity.blockName = String(r.block);
    if (r.x !== undefined && r.y !== undefined) {
      entity.position = { x: r.x, y: r.y };
    }
    return entity;
  }

  if (raw.type === 'MTEXT') {
    const r = raw as Entities.MText;
    if (r.string !== undefined) entity.text = r.string;
    if (r.x !== undefined && r.y !== undefined) {
      entity.position = { x: r.x as number, y: r.y as number };
    }
    return entity;
  }

  if (raw.type === 'TEXT') {
    const r = raw as unknown as { string?: string; x?: number; y?: number };
    if (r.string !== undefined) entity.text = r.string;
    if (r.x !== undefined && r.y !== undefined) {
      entity.position = { x: r.x, y: r.y };
    }
    return entity;
  }

  if (raw.type === 'LWPOLYLINE') {
    const r = raw as Entities.LWPolyline;
    if (Array.isArray(r.vertices)) {
      entity.vertices = r.vertices.map(v => ({ x: v.x, y: v.y }));
    }
    return entity;
  }

  if (raw.type === 'POLYLINE') {
    const r = raw as Entities.Polyline;
    if (Array.isArray(r.vertices)) {
      entity.vertices = r.vertices.map(v => {
        const pv = v as unknown as { x?: number; y?: number };
        return { x: pv.x ?? 0, y: pv.y ?? 0 };
      });
    }
    return entity;
  }

  // Generic: pull x/y if present (POINT, LINE, ARC, etc.)
  const generic = raw as unknown as { x?: number; y?: number };
  if (generic.x !== undefined && generic.y !== undefined) {
    entity.position = { x: generic.x, y: generic.y };
  }

  return entity;
}

export async function parseDxf(dxfFilePath: string): Promise<ParsedDxf> {
  const content = await readFile(dxfFilePath, 'utf-8');

  const parsed = parseString(content);

  // Denormalise resolves INSERT/BLOCK references, applying coordinate transforms
  const denormalised = denormalise(parsed);

  const entities: DxfEntity[] = denormalised.map(mapEntity);

  const layers = [
    ...new Set(entities.map(e => e.layer).filter((l): l is string => !!l)),
  ];

  const header: Record<string, unknown> = (parsed.header as unknown as Record<string, unknown>) ?? {};

  const svgContent: string = toSVG(parsed);

  return { entities, svgContent, layers, header };
}
