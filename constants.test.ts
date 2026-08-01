import { describe, expect, it } from 'vitest';
import {
  MODELS,
  MODEL_CONFIGS,
  getModelInstructions,
  normalizeChatConfig
} from './constants';
import { DEFAULT_CONFIG, ModelId } from './types';

describe('normalizeChatConfig', () => {
  it('fills a missing tools config with defaults', () => {
    const normalized = normalizeChatConfig({});

    expect(normalized).toEqual(DEFAULT_CONFIG);
  });

  it('normalizes missing tool flags independently', () => {
    const normalized = normalizeChatConfig({
      model: ModelId.GPT_5_6_LUNA,
      tools: { webSearch: false }
    });

    expect(normalized.tools).toEqual({
      webSearch: false,
      webSearchOptions: DEFAULT_CONFIG.tools.webSearchOptions,
      codeInterpreter: DEFAULT_CONFIG.tools.codeInterpreter
    });
  });

  it('normalizes supported Web Search options and API-bound location text', () => {
    const normalized = normalizeChatConfig({
      tools: {
        webSearchOptions: {
          searchContextSize: 'high',
          userLocation: {
            type: 'approximate',
            city: '  London  ',
            region: '  England ',
            country: ' gb '
          }
        }
      }
    });

    expect(normalized.tools.webSearchOptions).toEqual({
      searchContextSize: 'high',
      userLocation: {
        type: 'approximate',
        city: 'London',
        region: 'England',
        country: 'GB'
      }
    });
  });

  it('preserves explicit no-location Web Search options', () => {
    const normalized = normalizeChatConfig({
      tools: {
        webSearchOptions: {
          searchContextSize: 'low',
          userLocation: null
        }
      }
    });

    expect(normalized.tools.webSearchOptions).toEqual({
      searchContextSize: 'low',
      userLocation: null
    });
  });

  it('falls back from malformed Web Search options', () => {
    const normalized = normalizeChatConfig({
      tools: {
        webSearchOptions: {
          searchContextSize: 'extreme',
          userLocation: { type: 'precise' }
        }
      }
    });

    expect(normalized.tools.webSearchOptions).toEqual(
      DEFAULT_CONFIG.tools.webSearchOptions
    );
  });

  it('falls back from unknown models and unsupported saved options', () => {
    const normalized = normalizeChatConfig({
      model: 'removed-model' as ModelId,
      reasoningEffort: 'unsupported',
      textVerbosity: 'unsupported' as typeof DEFAULT_CONFIG.textVerbosity
    });

    expect(normalized).toMatchObject({
      model: DEFAULT_CONFIG.model,
      reasoningEffort: MODEL_CONFIGS[DEFAULT_CONFIG.model].defaultReasoningEffort,
      textVerbosity: DEFAULT_CONFIG.textVerbosity
    });
  });
});

describe('model catalog', () => {
  it('contains every ModelId exactly once with a valid default effort', () => {
    const modelIds = Object.values(ModelId);

    expect(Object.keys(MODEL_CONFIGS).sort()).toEqual([...modelIds].sort());
    expect(MODELS.map(model => model.id).sort()).toEqual([...modelIds].sort());
    MODELS.forEach(model => {
      expect(model.reasoningOptions).toContain(model.defaultReasoningEffort);
      expect(model.contextWindowTokens).toBeGreaterThan(0);
    });
  });

  it('tracks the context window for each model', () => {
    expect(MODEL_CONFIGS[ModelId.GPT_5_6_SOL].contextWindowTokens).toBe(1_050_000);
    expect(MODEL_CONFIGS[ModelId.GPT_5_6_TERRA].contextWindowTokens).toBe(1_050_000);
    expect(MODEL_CONFIGS[ModelId.GPT_5_6_LUNA].contextWindowTokens).toBe(1_050_000);
    expect(MODEL_CONFIGS[ModelId.GPT_5_5].contextWindowTokens).toBe(1_050_000);
    expect(MODEL_CONFIGS[ModelId.GPT_5_NANO].contextWindowTokens).toBe(400_000);
    expect(MODEL_CONFIGS[ModelId.GPT_O3].contextWindowTokens).toBe(200_000);
  });

  it('orders the picker with Luna between Terra and GPT-5.5', () => {
    expect(MODELS.map(model => model.id)).toEqual([
      ModelId.GPT_5_6_SOL,
      ModelId.GPT_5_6_TERRA,
      ModelId.GPT_5_6_LUNA,
      ModelId.GPT_5_5,
      ModelId.GPT_5_NANO,
      ModelId.GPT_O3
    ]);
  });

  it('places automatic identity metadata before custom instructions', () => {
    const instructions = getModelInstructions(
      ModelId.GPT_5_6_SOL,
      'Respond with concise examples.'
    );

    expect(instructions).toBe(
      'You are GPT-5.6 Sol, an OpenAI model. '
      + 'Your knowledge cutoff is February 16, 2026.\n\n'
      + 'Respond with concise examples.'
    );
  });
});
