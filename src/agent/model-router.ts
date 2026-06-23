import 'dotenv/config';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export type ModelRole = 'REASONING' | 'EXTRACTION' | 'VISION' | 'CHEAP';

const DEFAULTS: Record<ModelRole, string> = {
  REASONING:  'claude-sonnet-4-6',
  EXTRACTION: 'claude-haiku-4-5-20251001',
  VISION:     'claude-haiku-4-5-20251001',
  CHEAP:      'claude-haiku-4-5-20251001',
};

// When MAVERICK_OPENAI_BASE_URL is set, ALL model roles route through that gateway
// (LiteLLM on Proxmox → OpenRouter). The model ID becomes a LiteLLM alias like
// carter-planner or carter-haiku. OPENAI_API_KEY should be the LiteLLM master key.
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

  // OpenAI-compat gateway (LiteLLM on Proxmox). Set MAVERICK_OPENAI_BASE_URL to route
  // all agent calls through the gateway instead of hitting Anthropic directly.
  const gatewayBase = process.env.MAVERICK_OPENAI_BASE_URL;
  if (gatewayBase) {
    const base = gatewayBase.replace(/\/$/, '');
    return createOpenAI({
      baseURL: base.endsWith('/v1') ? base : `${base}/v1`,
      apiKey: process.env.OPENAI_API_KEY || 'sk-noop',
    })(modelId) as unknown as LanguageModelV3;
  }

  // Default: direct Anthropic
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return createAnthropic({ baseURL: ANTHROPIC_BASE_URL, apiKey: key })(modelId);
}
