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
      model: ModelId.GPT_5_MINI,
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
    });
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
