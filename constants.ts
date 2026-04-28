
import {
  ChatConfig,
  ModelConfig,
  ModelId,
  ReasoningEffort,
  ReasoningEffortFlagship,
  ReasoningEffortMiniNano,
  ReasoningEffortO3,
  TextVerbosity
} from './types';

export const APP_VERSION = __APP_VERSION__;
export const REASONING_EFFORT_FLAGSHIP: ReasoningEffortFlagship[] = ['none', 'low', 'medium', 'high', 'xhigh'];
export const REASONING_EFFORT_MINI_NANO: ReasoningEffortMiniNano[] = ['minimal', 'low', 'medium', 'high'];
export const REASONING_EFFORT_O3: ReasoningEffortO3[] = ['low', 'medium', 'high'];

export const MODEL_CONFIGS: Record<ModelId, ModelConfig> = {
  [ModelId.GPT_5_5]: {
    id: ModelId.GPT_5_5,
    name: 'GPT-5.5',
    pickerName: 'GPT-5.5 (Flagship)',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_FLAGSHIP,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_4]: {
    id: ModelId.GPT_5_4,
    name: 'GPT-5.4',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_FLAGSHIP,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_2]: {
    id: ModelId.GPT_5_2,
    name: 'GPT-5.2',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_FLAGSHIP,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_MINI]: {
    id: ModelId.GPT_5_MINI,
    name: 'GPT-5 Mini',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_MINI_NANO,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_NANO]: {
    id: ModelId.GPT_5_NANO,
    name: 'GPT-5 Nano',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_MINI_NANO,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_O3]: {
    id: ModelId.GPT_O3,
    name: 'o3',
    supportsVerbosity: false,
    reasoningOptions: REASONING_EFFORT_O3,
    defaultReasoningEffort: 'medium'
  }
};

export const MODELS = [
  MODEL_CONFIGS[ModelId.GPT_5_5],
  MODEL_CONFIGS[ModelId.GPT_5_4],
  MODEL_CONFIGS[ModelId.GPT_5_2],
  MODEL_CONFIGS[ModelId.GPT_5_MINI],
  MODEL_CONFIGS[ModelId.GPT_5_NANO],
  MODEL_CONFIGS[ModelId.GPT_O3]
];

export const TEXT_VERBOSITY: TextVerbosity[] = ['low', 'medium', 'high'];

export const getModelConfig = (model: ModelId | string): ModelConfig => {
  return MODEL_CONFIGS[model as ModelId] || MODEL_CONFIGS[ModelId.GPT_5_5];
};

export const getNormalizedReasoningEffort = (
  model: ModelId | string,
  reasoningEffort?: string
): ReasoningEffort => {
  const modelConfig = getModelConfig(model);

  if (reasoningEffort && modelConfig.reasoningOptions.includes(reasoningEffort as ReasoningEffort)) {
    return reasoningEffort as ReasoningEffort;
  }

  return modelConfig.defaultReasoningEffort;
};

export const normalizeChatConfig = (config: ChatConfig): ChatConfig => {
  const textVerbosity = TEXT_VERBOSITY.includes(config.textVerbosity)
    ? config.textVerbosity
    : 'medium';

  return {
    ...config,
    model: getModelConfig(config.model).id,
    reasoningEffort: getNormalizedReasoningEffort(config.model, config.reasoningEffort),
    textVerbosity
  };
};
