import { describe, expect, it } from 'vitest';
import { normalizeChatConfig } from './constants';
import { DEFAULT_CONFIG, ModelId } from './types';

describe('normalizeChatConfig', () => {
  it('fills a missing tools config with defaults', () => {
    const normalized = normalizeChatConfig({});

    expect(normalized).toEqual(DEFAULT_CONFIG);
  });

  it('normalizes missing tool flags independently', () => {
    const normalized = normalizeChatConfig({
      model: ModelId.GPT_5_MINI,
      tools: { webSearch: false }
    });

    expect(normalized.tools).toEqual({
      webSearch: false,
      codeInterpreter: DEFAULT_CONFIG.tools.codeInterpreter
    });
  });
});
