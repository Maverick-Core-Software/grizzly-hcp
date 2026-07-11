import 'dotenv/config';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export type ModelRole = 'REASONING' | 'EXTRACTION' | 'VISION' | 'CHEAP';

// Default routing (2026-07-03): ALL roles → z.ai direct (avoids OpenRouter markup).
//   REASONING/EXTRACTION/CHEAP → glm-5.2
//   VISION                     → glm-5v-turbo  (multimodal coding model, same z.ai endpoint)
// Override any role via MAVERICK_<ROLE>_MODEL / ZAI_*_MODEL / ZAI_BASE_URL / ZAI_API_KEY.
const ZAI_BASE_URL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4';
const ZAI_API_KEY  = process.env.ZAI_API_KEY || '';
const ZAI_TEXT_MODEL   = process.env.ZAI_MODEL || 'glm-5.2';
const ZAI_VISION_MODEL = process.env.ZAI_VISION_MODEL || 'glm-5v-turbo';

const DEFAULTS: Record<ModelRole, string> = {
  REASONING:  ZAI_TEXT_MODEL,
  EXTRACTION: ZAI_TEXT_MODEL,
  VISION:     ZAI_VISION_MODEL,
  CHEAP:      ZAI_TEXT_MODEL,
};

function resolveAnthropicBaseURL(): string {
  const raw = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1';
  if (raw.endsWith('/v1') || raw.endsWith('/v1/')) return raw.replace(/\/$/, '');
  return raw.replace(/\/$/, '') + '/v1';
}

const ANTHROPIC_BASE_URL = resolveAnthropicBaseURL();

export function getModel(role: ModelRole): LanguageModelV3 {
  const envKey = `MAVERICK_${role}_MODEL` as const;
  const modelId = process.env[envKey] || DEFAULTS[role];

  // Google models
  if (modelId.startsWith('gemini-') || modelId.startsWith('google/')) {
    throw new Error(`Google model "${modelId}" requires @ai-sdk/google — install it and extend model-router.ts`);
  }

  // Escape hatch: any role explicitly set to a claude-* model → direct Anthropic.
  if (modelId.startsWith('claude-')) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set (required when a role uses a claude-* model)');
    return createAnthropic({ baseURL: ANTHROPIC_BASE_URL, apiKey: key })(modelId);
  }

  // Default: z.ai (OpenAI-compatible). Same base URL + key for text and vision;
  // only the model ID differs. Optional gateway override via MAVERICK_OPENAI_BASE_URL.
  if (!ZAI_API_KEY) throw new Error('ZAI_API_KEY is not set (required for z.ai GLM routing)');
  const gatewayBase = process.env.MAVERICK_OPENAI_BASE_URL;
  const base = (gatewayBase || ZAI_BASE_URL).replace(/\/$/, '');
  return createOpenAI({
    baseURL: base.endsWith('/v1') ? base : `${base}/v1`,
    apiKey: process.env.OPENAI_API_KEY || ZAI_API_KEY,
  })(modelId) as unknown as LanguageModelV3;
}
