import type {
  EasyInputMessage,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInputContent,
  ResponseInputFile,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputText,
  ResponseStreamEvent,
  Tool,
  WebSearchTool
} from 'openai/resources/responses/responses';

export enum ModelId {
  GPT_5_5 = 'gpt-5.5',
  GPT_5_4 = 'gpt-5.4',
  GPT_5_2 = 'gpt-5.2',
  GPT_5_MINI = 'gpt-5-mini',
  GPT_5_NANO = 'gpt-5-nano',
  GPT_O3 = 'o3',
}

export type ReasoningEffortFlagship = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningEffortMiniNano = 'minimal' | 'low' | 'medium' | 'high';
export type ReasoningEffortO3 = 'low' | 'medium' | 'high';
export type ReasoningEffort =
  | ReasoningEffortFlagship
  | ReasoningEffortMiniNano
  | ReasoningEffortO3;
export type TextVerbosity = 'low' | 'medium' | 'high';

export interface ModelConfig {
  id: ModelId;
  name: string;
  supportsVerbosity: boolean;
  reasoningOptions: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

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

export interface GeneratedFile {
  filename: string;
  fileId: string;
  containerId: string;
  displayName?: string;
  mimeType?: string;
  source?: 'container_file_citation';
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'streaming' | 'complete' | 'error' | 'stopped';
  requestId?: string;
  openaiResponseId?: string;
  thinking?: string;
  thinkingDuration?: number; // Duration in milliseconds
  sources?: Source[];
  generatedFiles?: GeneratedFile[];
  timestamp: number;
  attachments?: FileAttachment[];
  model?: string;
  reasoningEffort?: string;
}

export interface FileAttachment {
  name: string;
  type: string;
  content?: string; // Data URL used for Responses API image/file inputs
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
  assistantMessageId?: string;
  createdAt: number;
}

// Responses API SDK type aliases
export type OpenAIResponsesInputText = ResponseInputText;
export type OpenAIResponsesInputImage = ResponseInputImage;
export type OpenAIResponsesInputFile = ResponseInputFile;
export type OpenAIResponsesContentPart = ResponseInputContent;
export type OpenAIResponsesInputRole = EasyInputMessage['role'];
export type OpenAIResponsesInput = ResponseInputItem;
export type OpenAIWebSearchTool = WebSearchTool;
export type OpenAICodeInterpreterTool = Extract<Tool, { type: 'code_interpreter' }>;
export type OpenAIResponsesTool = Tool;
export type OpenAIResponsesConfig = ResponseCreateParamsNonStreaming;
export type OpenAIResponsesStreamingConfig = ResponseCreateParamsStreaming;
export type OpenAIResponsesStreamEvent = ResponseStreamEvent;

export const DEFAULT_CONFIG: ChatConfig = {
  model: ModelId.GPT_5_5,
  reasoningEffort: 'medium',
  textVerbosity: 'medium',
  tools: {
    webSearch: true,
    codeInterpreter: false,
  },
  systemInstructionId: undefined
};
