
import { ModelId, ReasoningEffort52, ReasoningEffortMiniNano, ReasoningEffortO3 } from "./types";

export const MODELS = [
  { id: ModelId.GPT_5_2, name: 'GPT-5.2 (Flagship)' },
  { id: ModelId.GPT_5_MINI, name: 'GPT-5 Mini' },
  { id: ModelId.GPT_5_NANO, name: 'GPT-5 Nano' },
  { id: ModelId.GPT_O3, name: 'o3' },
];

export const REASONING_EFFORT_5_2: ReasoningEffort52[] = ['none', 'low', 'medium', 'high', 'xhigh'];
export const REASONING_EFFORT_MINI_NANO: ReasoningEffortMiniNano[] = ['minimal', 'low', 'medium', 'high'];
export const REASONING_EFFORT_O3: ReasoningEffortO3[] = ['low', 'medium', 'high'];

export const TEXT_VERBOSITY = ['low', 'medium', 'high'];
