import { describe, expect, it } from 'vitest';
import {
  MODELS,
  MODEL_CONFIGS,
  getModelDisplayName,
  getModelInstructions,
  normalizeChatConfig
} from './constants';
import { DEFAULT_CONFIG, ModelId } from './types';

describe('getModelDisplayName', () => {
  it('returns live catalog names for current models', () => {
    expect(getModelDisplayName(ModelId.GPT_5_6_SOL)).toBe('GPT-5.6 Sol');
    expect(getModelDisplayName(ModelId.GPT_5_5)).toBe('GPT-5.5');
    expect(getModelDisplayName(ModelId.GPT_O3)).toBe('o3');
  });

  it('returns historical product names for retired model ids', () => {
    expect(getModelDisplayName('gpt-5.2')).toBe('GPT-5.2');
    expect(getModelDisplayName('gpt-5.4')).toBe('GPT-5.4');
    expect(getModelDisplayName('gpt-5-mini')).toBe('GPT-5 Mini');
  });

  it('does not label unknown or retired models as the current default', () => {
    expect(getModelDisplayName('gpt-5.2')).not.toBe(MODEL_CONFIGS[DEFAULT_CONFIG.model].name);
    expect(getModelDisplayName('gpt-5-mini')).not.toBe(MODEL_CONFIGS[DEFAULT_CONFIG.model].name);
    expect(getModelDisplayName('removed-model')).toBe('removed-model');
    expect(getModelDisplayName('removed-model')).not.toBe(
      MODEL_CONFIGS[DEFAULT_CONFIG.model].name
    );
  });
});

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
      codeInterpreter: DEFAULT_CONFIG.tools.codeInterpreter
    });
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
