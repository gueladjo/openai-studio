import type { OpenAIPromptCacheDiagnostics } from '../types';

export const PROMPT_CACHE_MISS_LABELS: Record<
  Extract<OpenAIPromptCacheDiagnostics, { type: 'cache_miss' }>['reason'],
  string
> = {
  model_changed: 'Model changed',
  prompt_cache_key_changed: 'Cache key changed',
  tools_changed: 'Tools changed',
  text_format_changed: 'Output format changed',
  reasoning_effort_changed: 'Reasoning effort changed',
  verbosity_changed: 'Verbosity changed',
  context_compacted: 'Context compacted',
  input_changed: 'Earlier input changed',
  service_tier_changed: 'Service tier changed'
};

// Diagnostics are optional metadata. Ignore unknown/malformed API results and
// copy only supported fields so they cannot prevent saving the actual answer.
export const normalizePromptCacheDiagnostics = (
  value: unknown
): OpenAIPromptCacheDiagnostics | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const diagnostic = value as Record<string, unknown>;
  switch (diagnostic.type) {
    case 'cache_hit':
    case 'comparison_response_not_found':
    case 'unavailable':
      return { type: diagnostic.type };
    case 'cache_miss': {
      const validTokenCount = (count: unknown): count is number => (
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000_000_000
      );
      if (
        typeof diagnostic.reason !== 'string' ||
        !Object.prototype.hasOwnProperty.call(PROMPT_CACHE_MISS_LABELS, diagnostic.reason) ||
        !validTokenCount(diagnostic.cache_missed_tokens) ||
        (diagnostic.comparison_reusable_tokens !== undefined &&
          !validTokenCount(diagnostic.comparison_reusable_tokens))
      ) return undefined;
      return {
        type: 'cache_miss',
        reason: diagnostic.reason as keyof typeof PROMPT_CACHE_MISS_LABELS,
        cache_missed_tokens: diagnostic.cache_missed_tokens,
        ...(diagnostic.comparison_reusable_tokens !== undefined
          ? { comparison_reusable_tokens: diagnostic.comparison_reusable_tokens as number }
          : {})
      };
    }
    default:
      return undefined;
  }
};
