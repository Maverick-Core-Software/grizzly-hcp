import 'dotenv/config';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export type ModelRole = 'REASONING' | 'EXTRACTION' | 'VISION' | 'CHEAP';

const DEFAULTS: Record<ModelRole, string> = {
  REASONING:  'claude-sonnet-4-6',
  EXTRACTION: 'claude-haiku-4-5-20251001',
  VISION:     'claude-haiku-4-5-20251001', // ponytail: Gemini swap via MAVERICK_VISION_MODEL env var
  CHEAP:      'claude-haiku-4-5-20251001',
};

// System-level ANTHROPIC_BASE_URL may be set without the /v1 suffix (e.g. by other tools).
// We resolve it here so our calls always hit the correct endpoint, scoped to this process.
function resolveAnthropicBaseURL(): string {
  const raw = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1';
  if (raw.endsWith('/v1') || raw.endsWith('/v1/')) return raw.replace(/\/$/, '');
  return raw.replace(/\/$/, '') + '/v1';
}

const ANTHROPIC_BASE_URL = resolveAnthropicBaseURL();

export function getModel(role: ModelRole): LanguageModelV3 {
  const envKey = `MAVERICK_${role}_MODEL` as const;
  const modelId = process.env[envKey] || DEFAULTS[role];

  // Google models (if operator swaps in Gemini for vision)
  if (modelId.startsWith('gemini-') || modelId.startsWith('google/')) {
    throw new Error(`Google model "${modelId}" requires @ai-sdk/google — install it and extend model-router.ts`);
  }

  // Custom base URL (e.g. OpenAI-compat endpoint for GLM/Ollama)
  const customBase = process.env.MAVERICK_OPENAI_BASE_URL;
  if (customBase && (modelId.startsWith('glm-') || modelId.startsWith('qwen-') || modelId.startsWith('mistral-'))) {
    const openaiCompatProvider = createAnthropic({ baseURL: customBase, apiKey: process.env.OPENAI_API_KEY || 'sk-' });
    return openaiCompatProvider(modelId);
  }

  // Default: Anthropic with explicit baseURL to avoid system-level ANTHROPIC_BASE_URL misconfig
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return createAnthropic({ baseURL: ANTHROPIC_BASE_URL, apiKey: key })(modelId);
}
