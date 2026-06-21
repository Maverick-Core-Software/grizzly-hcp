import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { SheetType } from '../types.js';

const client = new Anthropic();

export interface ClassifiedSheet {
  sheetId: string;
  type: SheetType;
  confidence: 'high' | 'medium' | 'low';
  title?: string;
}

const ClassificationSchema = z.object({
  type: z.enum([
    'electrical-plan', 'lighting-plan', 'power-plan', 'panel-schedule',
    'riser', 'legend', 'title', 'detail', 'specification', 'other',
  ]),
  confidence: z.enum(['high', 'medium', 'low']),
  title: z.string().optional(),
});

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  return text.trim();
}

const CLASSIFY_PROMPT = `You are an electrical blueprint classifier. Look at this blueprint sheet image and classify it.
Return ONLY valid JSON (no markdown fences, no explanation):
{"type": "<SheetType>", "confidence": "<high|medium|low>", "title": "<sheet title if visible>"}

SheetType options: electrical-plan, lighting-plan, power-plan, panel-schedule, riser, legend, title, detail, specification, other

- electrical-plan: shows device locations (outlets, switches, circuits) on a floor plan
- lighting-plan: shows lighting fixture locations and switching
- power-plan: shows power outlets and equipment connections
- panel-schedule: shows a panel board schedule table with circuit numbers and loads
- riser: shows electrical riser diagram or service entrance diagram
- legend: shows electrical symbol legend/key
- title: title sheet, index sheet, or cover page
- detail: construction detail drawing
- specification: written specifications
- other: anything else`;

export async function classifySheet(
  image: Buffer,
  sheetId: string,
  textHint?: string,
): Promise<ClassifiedSheet> {
  const model = process.env.TAKEOFF_CLASSIFIER_MODEL ?? 'claude-haiku-4-5-20251001';

  const content: Anthropic.MessageParam['content'] = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
    { type: 'text', text: textHint ? `${CLASSIFY_PROMPT}\n\nAdditional text found on this page:\n${textHint}` : CLASSIFY_PROMPT },
  ];

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      messages: [{ role: 'user', content }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const parsed = ClassificationSchema.parse(JSON.parse(extractJson(text)));
    return { sheetId, ...parsed };
  } catch {
    return { sheetId, type: 'other', confidence: 'low' };
  }
}
