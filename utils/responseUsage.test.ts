import { describe, expect, it } from 'vitest';
import { normalizeResponseUsage } from './responseUsage';

const usage = () => ({
  input_tokens: 12000,
  input_tokens_details: {
    cached_tokens: 4000,
    cache_write_tokens: 7000,
    cache_write_tokens_details: { ttl_30m_tokens: 7000, ttl_12h_tokens: 0 }
  },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 12050
});

describe('Responses usage normalization', () => {
  it('preserves supported usage without aliasing API objects', () => {
    const original = usage();
    const normalized = normalizeResponseUsage(original)!;
    expect(normalized).toEqual(original);
    original.input_tokens_details.cache_write_tokens_details.ttl_30m_tokens = 0;
    expect(normalized).toEqual(usage());
  });

  it('retains older counters without fabricating unreported cache writes', () => {
    const original = usage();
    const { cache_write_tokens, cache_write_tokens_details, ...input } = original.input_tokens_details;
    const legacy = { ...original, input_tokens_details: input };
    expect(normalizeResponseUsage(legacy)).toEqual(legacy);
    expect(normalizeResponseUsage(legacy)?.input_tokens_details).not.toHaveProperty('cache_write_tokens');
  });

  it.each([
    null, {}, { ttl_30m_tokens: 1 },
    { ttl_30m_tokens: 7000, ttl_12h_tokens: -1 },
    { ttl_30m_tokens: 7000, ttl_12h_tokens: 0.5 },
    { ttl_30m_tokens: Infinity, ttl_12h_tokens: 0 },
    { ttl_30m_tokens: 1_000_000_000_001, ttl_12h_tokens: 0 }
  ])('omits malformed optional lifetime details without losing other counters: %j', details => {
    const original = usage();
    Object.assign(original.input_tokens_details, { cache_write_tokens_details: details });
    const normalized = normalizeResponseUsage(original)!;
    expect(normalized.input_tokens_details).toEqual({ cached_tokens: 4000, cache_write_tokens: 7000 });
    expect(normalized.total_tokens).toBe(12050);
  });

  it.each([null, undefined, [], {}, { ...usage(), total_tokens: NaN },
    { ...usage(), input_tokens_details: null },
    { ...usage(), output_tokens_details: { reasoning_tokens: -1 } }
  ])('omits unusable usage rather than blocking answer persistence: %j', value => {
    expect(normalizeResponseUsage(value)).toBeUndefined();
  });
});
