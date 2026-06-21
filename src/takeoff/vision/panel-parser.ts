import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { PanelSchedule, TakeoffWarning } from '../types.js';

const client = new Anthropic();

const CircuitSchema = z.object({
  number: z.number(),
  description: z.string(),
  amperage: z.number().optional(),
  poles: z.number().optional(),
  notes: z.string().optional(),
});

const PanelSchema = z.object({
  panelId: z.string(),
  location: z.string().optional(),
  voltage: z.string().optional(),
  amperage: z.number().optional(),
  circuits: z.array(CircuitSchema),
});

const PanelResultSchema = z.object({ panels: z.array(PanelSchema) });

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  return text.trim();
}

const PANEL_PROMPT = `You are an electrical estimator reading a panel schedule from a blueprint.
Extract all panel schedules visible in this image.

Return ONLY valid JSON (no markdown fences):
{
  "panels": [
    {
      "panelId": "<panel name/ID>",
      "location": "<location if shown>",
      "voltage": "<voltage if shown e.g. '120/240V'>",
      "amperage": <main breaker amperage as number>,
      "circuits": [
        {"number": <circuit number>, "description": "<load description>", "amperage": <breaker size>, "poles": <1 or 2 or 3>, "notes": "<any notes>"}
      ]
    }
  ]
}

If no panel schedule is visible, return: {"panels": []}`;

export async function extractPanelSchedule(
  image: Buffer,
  sheetId: string,
  textContent?: string,
): Promise<{ panels: PanelSchedule[]; warnings: TakeoffWarning[] }> {
  const model = process.env.TAKEOFF_MODEL ?? 'claude-sonnet-4-6';

  const userText = textContent
    ? `${PANEL_PROMPT}\n\nAdditional text extracted from this page:\n${textContent}`
    : PANEL_PROMPT;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
          { type: 'text', text: userText },
        ],
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const parsed = PanelResultSchema.parse(JSON.parse(extractJson(text)));
    return { panels: parsed.panels, warnings: [] };
  } catch (err) {
    return {
      panels: [],
      warnings: [{
        code: 'PANEL_PARSE_FAILED',
        message: `Failed to extract panel schedule from sheet ${sheetId}: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      }],
    };
  }
}
