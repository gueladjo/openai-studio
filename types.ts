
export enum ModelId {
  GPT_5_2 = 'gpt-5.2',
  GPT_5_MINI = 'gpt-5-mini',
  GPT_5_NANO = 'gpt-5-nano',
  GPT_O3 = 'o3',
}

export type ReasoningEffort52 = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningEffortMiniNano = 'minimal' | 'low' | 'medium' | 'high';
export type ReasoningEffortO3 = 'low' | 'medium' | 'high';
export type TextVerbosity = 'low' | 'medium' | 'high';

export interface SystemInstruction {
  id: string;
  title: string;
  content: string;
}

export interface ChatConfig {
  model: ModelId;
  reasoningEffort: string; // Union of all types, handled by logic
  textVerbosity: TextVerbosity;
  tools: {
    webSearch: boolean;
    codeInterpreter: boolean;
  };
  systemInstructionId?: string;
}

export interface Source {
  title: string;
  url: string;
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  requestId?: string;
  thinking?: string;
  thinkingDuration?: number; // Duration in milliseconds
  sources?: Source[];
  timestamp: number;
  attachments?: FileAttachment[];
  model?: string;
  reasoningEffort?: string;
}

export interface FileAttachment {
  name: string;
  type: string;
  content?: string; // For text files we might preview/send content directly
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  config: ChatConfig;
  lastModified: number;
  pendingRequest?: PendingRequest;
}

export interface PendingRequest {
  id: string;
  userMessageId: string;
  createdAt: number;
}

// Experimental API Types based on the prompt
export interface OpenAIResponsesInput {
  role: string;
  content: string | any[];
}

export interface OpenAIResponsesConfig {
  model: string;
  input: OpenAIResponsesInput[];
  text?: {
    format: { type: 'text' };
    verbosity?: string;
  };
  reasoning?: {
    effort: string;
  };
  tools?: any[];
  store: boolean;
  include?: string[];
}

export const DEFAULT_CONFIG: ChatConfig = {
  model: ModelId.GPT_5_2,
  reasoningEffort: 'medium',
  textVerbosity: 'medium',
  tools: {
    webSearch: true,
    codeInterpreter: false,
  },
  systemInstructionId: undefined
};
