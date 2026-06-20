import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { DetectionEvidence, ExcludedDetection, SymbolLegend, TakeoffWarning } from '../types.js';

const client = new Anthropic();

export interface SymbolCountResult {
  detections: DetectionEvidence[];
  excluded: ExcludedDetection[];
  warnings: TakeoffWarning[];
}

const DetectionSchema = z.object({
  device_type: z.string(),
  raw_symbol: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  bbox_px: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  is_from_legend: z.boolean().optional(),
  is_from_detail: z.boolean().optional(),
});

const TileResultSchema = z.object({
  detections: z.array(DetectionSchema),
});

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  return text.trim();
}

function buildPrompt(legend?: SymbolLegend): string {
  const legendText = legend && legend.entries.length > 0
    ? `Known symbols for this project:\n${legend.entries.map(e => `- ${e.rawSymbol} = ${e.deviceType}`).join('\n')}`
    : '';

  return `You are an electrical estimator counting devices on a construction plan.
Count all electrical devices/symbols visible on this blueprint tile.
Do NOT count symbols from the legend, title blocks, or detail drawings.

${legendText}

Return ONLY valid JSON (no markdown fences, no explanation):
{
  "detections": [
    {
      "device_type": "<normalized device type>",
      "raw_symbol": "<how it appears on this drawing>",
      "confidence": "<high|medium|low>",
      "bbox_px": {"x": <left>, "y": <top>, "width": <w>, "height": <h>},
      "is_from_legend": <true if this is a legend entry, not an installed device>,
      "is_from_detail": <true if this appears to be in a detail/title block area>
    }
  ]
}

Device types: duplex_receptacle, gfci_receptacle, afci_receptacle, switch_single, switch_3way, switch_dimmer, smoke_detector, co_detector, exhaust_fan, light_fixture, recessed_light, panel_main, panel_sub, ev_charger, exit_light, emergency_light, junction_box, disconnect, transformer, meter

Be conservative — only count devices you can clearly identify. Use 'low' confidence for ambiguous symbols.
If you see no electrical devices, return {"detections": []}.`;
}

async function parseTile(
  model: string,
  imageBase64: string,
  prompt: string,
): Promise<z.infer<typeof TileResultSchema> | null> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  try {
    return TileResultSchema.parse(JSON.parse(extractJson(text)));
  } catch {
    // Retry once with repair prompt
    const repairResponse = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        },
        { role: 'assistant', content: text },
        { role: 'user', content: 'Your response was not valid JSON. Please return ONLY the JSON object with no markdown fences or explanation.' },
      ],
    });
    const repairText = repairResponse.content.find(b => b.type === 'text')?.text ?? '';
    try {
      return TileResultSchema.parse(JSON.parse(extractJson(repairText)));
    } catch {
      return null;
    }
  }
}

export async function countSymbols(
  tiles: Array<{ label: string; image: Buffer; pageWidthPx: number; pageHeightPx: number }>,
  sheetId: string,
  legend?: SymbolLegend,
): Promise<SymbolCountResult> {
  const model = process.env.TAKEOFF_MODEL ?? 'claude-sonnet-4-6';
  const prompt = buildPrompt(legend);
  const detections: DetectionEvidence[] = [];
  const excluded: ExcludedDetection[] = [];
  const warnings: TakeoffWarning[] = [];

  for (const tile of tiles) {
    const result = await parseTile(model, tile.image.toString('base64'), prompt);

    if (!result) {
      warnings.push({
        code: 'TILE_PARSE_FAILED',
        message: `Failed to parse detections for tile ${tile.label} on sheet ${sheetId}`,
        severity: 'warning',
      });
      continue;
    }

    for (const d of result.detections) {
      if (d.is_from_legend) {
        excluded.push({ raw_symbol: d.raw_symbol, sheet: sheetId, region: tile.label, exclusion_reason: 'legend' });
        continue;
      }
      if (d.is_from_detail) {
        excluded.push({ raw_symbol: d.raw_symbol, sheet: sheetId, region: tile.label, exclusion_reason: 'detail' });
        continue;
      }
      if (d.confidence === 'low') {
        excluded.push({ raw_symbol: d.raw_symbol, sheet: sheetId, region: tile.label, exclusion_reason: 'low_confidence' });
        continue;
      }

      detections.push({
        device_type: d.device_type,
        raw_symbol: d.raw_symbol,
        method: 'vision_bbox',
        sheet: sheetId,
        region: tile.label,
        bbox_px: d.bbox_px,
        page_width_px: tile.pageWidthPx,
        page_height_px: tile.pageHeightPx,
        confidence: d.confidence,
      });
    }
  }

  return { detections, excluded, warnings };
}
