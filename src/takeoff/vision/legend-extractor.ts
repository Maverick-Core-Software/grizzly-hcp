import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { SymbolLegend } from '../types.js';

const client = new Anthropic();

const LegendSchema = z.object({
  entries: z.array(z.object({
    rawSymbol: z.string(),
    deviceType: z.string(),
    description: z.string().optional(),
  })),
});

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  return text.trim();
}

const LEGEND_PROMPT = `You are an electrical estimator reading a symbol legend from a blueprint.
Extract every electrical symbol from this legend and map it to a standard device type.

Return ONLY valid JSON (no markdown fences):
{"entries": [{"rawSymbol": "<symbol name from legend>", "deviceType": "<normalized type>", "description": "<description if any>"}]}

Standard device types: duplex_receptacle, gfci_receptacle, afci_receptacle, switch_single, switch_3way, switch_dimmer, smoke_detector, co_detector, exhaust_fan, light_fixture, recessed_light, panel_main, panel_sub, ev_charger, exit_light, emergency_light, junction_box, disconnect, transformer, meter

If you see no legend on this image, return: {"entries": []}`;

export async function extractLegend(
  image: Buffer,
  sheetId: string,
): Promise<SymbolLegend | null> {
  const model = process.env.TAKEOFF_MODEL ?? 'claude-sonnet-4-6';

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
        { type: 'text', text: LEGEND_PROMPT },
      ],
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';

  try {
    const parsed = LegendSchema.parse(JSON.parse(extractJson(text)));
    if (parsed.entries.length === 0) return null;
    return { entries: parsed.entries, source: sheetId };
  } catch {
    return null;
  }
}
