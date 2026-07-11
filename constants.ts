
import {
  ChatConfig,
  DEFAULT_CONFIG,
  ModelConfig,
  ModelId,
  ReasoningEffort,
  ReasoningEffortFlagship,
  ReasoningEffortGPT56,
  ReasoningEffortMiniNano,
  ReasoningEffortO3,
  TextVerbosity
} from './types';

type ChatConfigInput = Partial<Omit<ChatConfig, 'tools'>> & {
  tools?: Partial<ChatConfig['tools']>;
};

export const APP_VERSION = __APP_VERSION__;
export const REASONING_EFFORT_FLAGSHIP: ReasoningEffortFlagship[] = ['none', 'low', 'medium', 'high', 'xhigh'];
export const REASONING_EFFORT_GPT_5_6: ReasoningEffortGPT56[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_EFFORT_MINI_NANO: ReasoningEffortMiniNano[] = ['minimal', 'low', 'medium', 'high'];
export const REASONING_EFFORT_O3: ReasoningEffortO3[] = ['low', 'medium', 'high'];

export const MODEL_CONFIGS: Record<ModelId, ModelConfig> = {
  [ModelId.GPT_5_6_SOL]: {
    id: ModelId.GPT_5_6_SOL,
    name: 'GPT-5.6 Sol',
    knowledgeCutoff: 'February 16, 2026',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_GPT_5_6,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_6_TERRA]: {
    id: ModelId.GPT_5_6_TERRA,
    name: 'GPT-5.6 Terra',
    knowledgeCutoff: 'February 16, 2026',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_GPT_5_6,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_5]: {
    id: ModelId.GPT_5_5,
    name: 'GPT-5.5',
    knowledgeCutoff: 'December 1, 2025',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_FLAGSHIP,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_MINI]: {
    id: ModelId.GPT_5_MINI,
    name: 'GPT-5 Mini',
    knowledgeCutoff: 'May 31, 2024',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_MINI_NANO,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_NANO]: {
    id: ModelId.GPT_5_NANO,
    name: 'GPT-5 Nano',
    knowledgeCutoff: 'May 31, 2024',
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_MINI_NANO,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_O3]: {
    id: ModelId.GPT_O3,
    name: 'o3',
    knowledgeCutoff: 'June 1, 2024',
    supportsVerbosity: false,
    reasoningOptions: REASONING_EFFORT_O3,
    defaultReasoningEffort: 'medium'
  }
};

export const MODELS = [
  MODEL_CONFIGS[ModelId.GPT_5_6_SOL],
  MODEL_CONFIGS[ModelId.GPT_5_6_TERRA],
  MODEL_CONFIGS[ModelId.GPT_5_5],
  MODEL_CONFIGS[ModelId.GPT_5_MINI],
  MODEL_CONFIGS[ModelId.GPT_5_NANO],
  MODEL_CONFIGS[ModelId.GPT_O3]
];

export const TEXT_VERBOSITY: TextVerbosity[] = ['low', 'medium', 'high'];

export const getModelConfig = (model: ModelId | string): ModelConfig => {
  return MODEL_CONFIGS[model as ModelId] || MODEL_CONFIGS[ModelId.GPT_5_6_SOL];
};

export const getModelInstructions = (
  model: ModelId | string,
  customInstructions?: string
): string => {
  const modelConfig = getModelConfig(model);
  const identityInstructions = `You are ${modelConfig.name}, an OpenAI model. Your knowledge cutoff is ${modelConfig.knowledgeCutoff}.`;

  return customInstructions
    ? `${identityInstructions}\n\n${customInstructions}`
    : identityInstructions;
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

export const normalizeChatConfig = (
  config: ChatConfigInput | null | undefined
): ChatConfig => {
  const source = config || {};
  const textVerbosity = source.textVerbosity && TEXT_VERBOSITY.includes(source.textVerbosity)
    ? source.textVerbosity
    : DEFAULT_CONFIG.textVerbosity;

  return {
    ...source,
    model: getModelConfig(source.model || DEFAULT_CONFIG.model).id,
    reasoningEffort: getNormalizedReasoningEffort(source.model || DEFAULT_CONFIG.model, source.reasoningEffort),
    textVerbosity,
    tools: {
      webSearch: typeof source.tools?.webSearch === 'boolean'
        ? source.tools.webSearch
        : DEFAULT_CONFIG.tools.webSearch,
      codeInterpreter: typeof source.tools?.codeInterpreter === 'boolean'
        ? source.tools.codeInterpreter
        : DEFAULT_CONFIG.tools.codeInterpreter
    }
  };
};
