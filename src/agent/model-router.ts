import 'dotenv/config';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export type ModelRole = 'REASONING' | 'EXTRACTION' | 'VISION' | 'CHEAP';

// Default routing (Venice Pro+ eval 2026-07): ALL roles → Venice, with z.ai / deepseek
// fallback.  REASONING/EXTRACTION/CHEAP → zai-org-glm-5-2; VISION → z-ai-glm-5v-turbo.
// Override any role via MAVERICK_<ROLE>_MODEL.
const ZAI_BASE_URL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4';
const ZAI_API_KEY  = process.env.ZAI_API_KEY || '';
const VENICE_BASE_URL = process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1';
const VENICE_API_KEY  = process.env.VENICE_API_KEY || '';
const VENICE_TEXT_MODEL   = process.env.VENICE_TEXT_MODEL || 'zai-org-glm-5-2';
const VENICE_VISION_MODEL = process.env.VENICE_VISION_MODEL || 'z-ai-glm-5v-turbo';

const DEFAULTS: Record<ModelRole, string> = {
  REASONING:  VENICE_TEXT_MODEL,
  EXTRACTION: VENICE_TEXT_MODEL,
  VISION:     VENICE_VISION_MODEL,
  CHEAP:      VENICE_TEXT_MODEL,
};

// ── z.ai / deepseek fallback (Venice Pro+ eval) ──────────────────────────

/**
 * Venice Pro+ eval 2026-07 — old direct routing kept as fallback.
 * Revert: swap DEFAULTS back to ZAI_TEXT_MODEL / ZAI_VISION_MODEL.
 */
export function getFallbackModel(role: ModelRole): LanguageModelV3 {
  const envKey = `MAVERICK_${role}_MODEL` as const;
  const modelId = process.env[envKey] || DEFAULTS[role];

  // Google models
  if (modelId.startsWith('gemini-') || modelId.startsWith('google/')) {
    throw new Error(`Google model "${modelId}" requires @ai-sdk/google — install it and extend model-router.ts`);
  }

  // Escape hatch: claude-* → direct Anthropic.
  if (modelId.startsWith('claude-')) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set (required when a role uses a claude-* model)');
    return createAnthropic({ baseURL: ANTHROPIC_BASE_URL, apiKey: key })(modelId);
  }

  // DeepSeek (OpenAI-compatible, chat completions only).
  if (modelId.startsWith('deepseek-')) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY is not set (required for deepseek-* models)');
    const dsBase = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
    return createOpenAI({
      baseURL: dsBase.endsWith('/v1') ? dsBase : `${dsBase}/v1`,
      apiKey: key,
    }).chat(modelId) as unknown as LanguageModelV3;
  }

  // Default: z.ai (OpenAI-compatible).
  if (!ZAI_API_KEY) throw new Error('ZAI_API_KEY is not set (required for z.ai GLM routing)');
  const gatewayBase = process.env.MAVERICK_OPENAI_BASE_URL;
  const base = (gatewayBase || ZAI_BASE_URL).replace(/\/$/, '');
  const apiKey = gatewayBase ? (process.env.OPENAI_API_KEY || ZAI_API_KEY) : ZAI_API_KEY;
  return createOpenAI({
    baseURL: base.endsWith('/v1') ? base : `${base}/v1`,
    apiKey,
  }).chat(modelId) as unknown as LanguageModelV3;
}

/**
 * Wrap a model so that API call errors retry once with the role's fallback.
 * Intercepts the model's doGenerate / doStream methods via proxy.
 */
export function withRetry(model: LanguageModelV3, role: ModelRole): LanguageModelV3 {
  return new Proxy(model, {
    get(target, key) {
      const raw = (target as Record<PropertyKey, unknown>)[key as PropertyKey];
      if (typeof key === 'string' && (key === 'doGenerate' || key === 'doStream')) {
        const fn = raw as (...a: unknown[]) => unknown;
        const fallback = getFallbackModel(role);
        const fb = fallback as Record<string, unknown>;
        return async (...args: unknown[]) => {
          try {
            return await fn(...args);
          } catch (err) {
            console.warn(`[model-router] ${role} failed, retrying with fallback: ${err}`);
            return await (fb[key] as (...a: unknown[]) => Promise<unknown>)(...args);
          }
        };
      }
      return raw;
    },
  });
}

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

  // Escape hatch: any role explicitly set to a claude-* model → direct Anthropic (unchanged).
  if (modelId.startsWith('claude-')) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set (required when a role uses a claude-* model)');
    return createAnthropic({ baseURL: ANTHROPIC_BASE_URL, apiKey: key })(modelId);
  }

  // DeepSeek — honour deepseek-* via Venice (same base + key) so the deepseek branch
  // is reachable through the fallback, not here.
  if (modelId.startsWith('deepseek-')) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY is not set (required for deepseek-* models)');
    const dsBase = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
    return createOpenAI({
      baseURL: dsBase.endsWith('/v1') ? dsBase : `${dsBase}/v1`,
      apiKey: key,
    }).chat(modelId) as unknown as LanguageModelV3;
  }

  // Default → Venice (any model id not matching the three explicit prefixes above).
  if (!VENICE_API_KEY) throw new Error('VENICE_API_KEY is not set (required for default model routing)');
  const veniceBase = VENICE_BASE_URL.replace(/\/$/, '');
  return createOpenAI({
    baseURL: veniceBase.endsWith('/v1') ? veniceBase : `${veniceBase}/v1`,
    apiKey: VENICE_API_KEY,
  }).chat(modelId) as unknown as LanguageModelV3;
}
