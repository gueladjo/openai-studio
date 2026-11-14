import type { OpenAIResponsesUsage } from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isTokenCount = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) &&
  value >= 0 && value <= 1_000_000_000_000
);

// The API can add usage fields ahead of the SDK and our persisted schema.
// Copy supported counters rather than persisting the raw API object. Invalid
// optional metadata must not prevent saving the answer or invent zero usage.
export const normalizeResponseUsage = (value: unknown): OpenAIResponsesUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const input = value.input_tokens_details;
  const output = value.output_tokens_details;
  if (
    !isTokenCount(value.input_tokens) || !isTokenCount(value.output_tokens) ||
    !isTokenCount(value.total_tokens) || !isRecord(input) || !isRecord(output) ||
    !isTokenCount(input.cached_tokens) || !isTokenCount(output.reasoning_tokens)
  ) return undefined;

  const writes = input.cache_write_tokens_details;
  const writeDetails = isRecord(writes) &&
    isTokenCount(writes.ttl_30m_tokens) && isTokenCount(writes.ttl_12h_tokens)
    ? { ttl_30m_tokens: writes.ttl_30m_tokens, ttl_12h_tokens: writes.ttl_12h_tokens }
    : undefined;

  return {
    input_tokens: value.input_tokens,
    input_tokens_details: {
      cached_tokens: input.cached_tokens,
      ...(isTokenCount(input.cache_write_tokens) ? { cache_write_tokens: input.cache_write_tokens } : {}),
      ...(writeDetails ? { cache_write_tokens_details: writeDetails } : {})
    },
    output_tokens: value.output_tokens,
    output_tokens_details: { reasoning_tokens: output.reasoning_tokens },
    total_tokens: value.total_tokens
  } as OpenAIResponsesUsage;
};
