
import {
  ChatConfig,
  DEFAULT_CONFIG,
  ModelConfig,
  ModelId,
  ReasoningEffort,
  ReasoningEffortFlagship,
  ReasoningEffortGPT56,
  ReasoningEffortNano,
  ReasoningEffortO3,
  TextVerbosity,
  WebSearchContextSize,
  WebSearchOptions,
  WebSearchUserLocation
} from './types';

type ChatConfigInput = Partial<Omit<ChatConfig, 'tools'>> & {
  tools?: Omit<Partial<ChatConfig['tools']>, 'webSearchOptions'> & {
    webSearchOptions?: unknown;
  };
};

export const APP_VERSION = __APP_VERSION__;
export const REASONING_EFFORT_FLAGSHIP: ReasoningEffortFlagship[] = ['none', 'low', 'medium', 'high', 'xhigh'];
export const REASONING_EFFORT_GPT_5_6: ReasoningEffortGPT56[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_EFFORT_NANO: ReasoningEffortNano[] = ['minimal', 'low', 'medium', 'high'];
export const REASONING_EFFORT_O3: ReasoningEffortO3[] = ['low', 'medium', 'high'];

export const MODEL_CONFIGS: Record<ModelId, ModelConfig> = {
  [ModelId.GPT_5_6_SOL]: {
    id: ModelId.GPT_5_6_SOL,
    name: 'GPT-5.6 Sol',
    knowledgeCutoff: 'February 16, 2026',
    contextWindowTokens: 1_050_000,
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_GPT_5_6,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_6_TERRA]: {
    id: ModelId.GPT_5_6_TERRA,
    name: 'GPT-5.6 Terra',
    knowledgeCutoff: 'February 16, 2026',
    contextWindowTokens: 1_050_000,
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_GPT_5_6,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_6_LUNA]: {
    id: ModelId.GPT_5_6_LUNA,
    name: 'GPT-5.6 Luna',
    knowledgeCutoff: 'February 16, 2026',
    contextWindowTokens: 1_050_000,
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_GPT_5_6,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_5]: {
    id: ModelId.GPT_5_5,
    name: 'GPT-5.5',
    knowledgeCutoff: 'December 1, 2025',
    contextWindowTokens: 1_050_000,
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_FLAGSHIP,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_5_NANO]: {
    id: ModelId.GPT_5_NANO,
    name: 'GPT-5 Nano',
    knowledgeCutoff: 'May 31, 2024',
    contextWindowTokens: 400_000,
    supportsVerbosity: true,
    reasoningOptions: REASONING_EFFORT_NANO,
    defaultReasoningEffort: 'medium'
  },
  [ModelId.GPT_O3]: {
    id: ModelId.GPT_O3,
    name: 'o3',
    knowledgeCutoff: 'June 1, 2024',
    contextWindowTokens: 200_000,
    supportsVerbosity: false,
    reasoningOptions: REASONING_EFFORT_O3,
    defaultReasoningEffort: 'medium'
  }
};

export const MODELS = [
  MODEL_CONFIGS[ModelId.GPT_5_6_SOL],
  MODEL_CONFIGS[ModelId.GPT_5_6_TERRA],
  MODEL_CONFIGS[ModelId.GPT_5_6_LUNA],
  MODEL_CONFIGS[ModelId.GPT_5_5],
  MODEL_CONFIGS[ModelId.GPT_5_NANO],
  MODEL_CONFIGS[ModelId.GPT_O3]
];

export const TEXT_VERBOSITY: TextVerbosity[] = ['low', 'medium', 'high'];
export const WEB_SEARCH_CONTEXT_SIZES: WebSearchContextSize[] = [
  'low',
  'medium',
  'high'
];
export const WEB_SEARCH_LOCATION_TEXT_MAX_LENGTH = 256;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeLocationText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, WEB_SEARCH_LOCATION_TEXT_MAX_LENGTH);
  return normalized || undefined;
};

const cloneDefaultWebSearchLocation = (): WebSearchUserLocation => ({
  type: 'approximate',
  city: 'New York',
  region: 'NY',
  country: 'US'
});

const normalizeWebSearchLocation = (
  value: unknown
): WebSearchUserLocation | null => {
  if (value === undefined) return cloneDefaultWebSearchLocation();
  if (value === null) return null;
  if (!isRecord(value) || value.type !== 'approximate') {
    return cloneDefaultWebSearchLocation();
  }

  const city = normalizeLocationText(value.city);
  const region = normalizeLocationText(value.region);
  const rawCountry = normalizeLocationText(value.country)?.toUpperCase();
  const country = rawCountry && /^[A-Z]{2}$/.test(rawCountry)
    ? rawCountry
    : undefined;

  if (!city && !region && !country) return null;
  return {
    type: 'approximate',
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {})
  };
};

export const normalizeWebSearchOptions = (value: unknown): WebSearchOptions => {
  const options = isRecord(value) ? value : {};
  const searchContextSize = (
    typeof options.searchContextSize === 'string' &&
    WEB_SEARCH_CONTEXT_SIZES.includes(
      options.searchContextSize as WebSearchContextSize
    )
  )
    ? options.searchContextSize as WebSearchContextSize
    : DEFAULT_CONFIG.tools.webSearchOptions.searchContextSize;

  return {
    searchContextSize,
    userLocation: normalizeWebSearchLocation(options.userLocation)
  };
};

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
      webSearchOptions: normalizeWebSearchOptions(
        source.tools?.webSearchOptions
      ),
      codeInterpreter: typeof source.tools?.codeInterpreter === 'boolean'
        ? source.tools.codeInterpreter
        : DEFAULT_CONFIG.tools.codeInterpreter
    }
  };
};
