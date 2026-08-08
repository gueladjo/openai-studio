import type {
  EasyInputMessage,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInputContent,
  ResponseInputFile,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputText,
  ResponseOutputMessage,
  ResponseStreamEvent,
  ResponseUsage,
  Tool,
  WebSearchPreviewTool,
  WebSearchTool
} from 'openai/resources/responses/responses';

export enum ModelId {
  GPT_5_6_SOL = 'gpt-5.6-sol',
  GPT_5_6_TERRA = 'gpt-5.6-terra',
  GPT_5_6_LUNA = 'gpt-5.6-luna',
  GPT_5_5 = 'gpt-5.5',
  GPT_5_NANO = 'gpt-5-nano',
  GPT_O3 = 'o3',
}

export type ReasoningEffortFlagship = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningEffortGPT56 = ReasoningEffortFlagship | 'max';
export type ReasoningEffortNano = 'minimal' | 'low' | 'medium' | 'high';
export type ReasoningEffortO3 = 'low' | 'medium' | 'high';
export type ReasoningEffort =
  | ReasoningEffortGPT56
  | ReasoningEffortFlagship
  | ReasoningEffortNano
  | ReasoningEffortO3;
export type TextVerbosity = 'low' | 'medium' | 'high';

export interface ModelConfig {
  id: ModelId;
  name: string;
  pickerName?: string;
  knowledgeCutoff: string;
  contextWindowTokens: number;
  supportsVerbosity: boolean;
  reasoningOptions: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

export interface SystemInstruction {
  id: string;
  title: string;
  content: string;
}

export type WebSearchContextSize = NonNullable<
  WebSearchTool['search_context_size']
>;

type SdkWebSearchUserLocation = NonNullable<
  WebSearchTool['user_location']
>;
type SdkWebSearchLocationType = NonNullable<
  WebSearchPreviewTool['user_location']
>['type'];

export type WebSearchUserLocation = {
  type: SdkWebSearchLocationType;
} & Partial<{
  [Key in 'city' | 'region' | 'country']:
    NonNullable<SdkWebSearchUserLocation[Key]>;
}>;

export interface WebSearchOptions {
  searchContextSize: WebSearchContextSize;
  userLocation: WebSearchUserLocation | null;
}

export interface ChatConfig {
  model: ModelId;
  reasoningEffort: string; // Union of all types, handled by logic
  textVerbosity: TextVerbosity;
  tools: {
    webSearch: boolean;
    webSearchOptions: WebSearchOptions;
    codeInterpreter: boolean;
  };
  systemInstructionId?: string;
}

export interface WebCitationSource {
  kind: 'web';
  title: string;
  url: string;
}

export type CitationSource =
  | WebCitationSource
  | {
      kind: 'file';
      filename: string;
      fileId: string;
      projectSourceId?: string;
    };
export type Source = CitationSource;

export interface LocalBlobReference {
  sha256: string;
  byteSize: number;
  mimeType?: string;
}

export interface GeneratedFile {
  filename: string;
  fileId: string;
  containerId: string;
  displayName?: string;
  mimeType?: string;
  source?: 'container_file_citation';
  localBlob?: LocalBlobReference;
}

export type ResponseIncompleteReason = NonNullable<
  NonNullable<Response['incomplete_details']>['reason']
>;

export type MessageStatus =
  | 'streaming'
  | 'complete'
  | 'incomplete'
  | 'error'
  | 'stopped';

export type AssistantPhase = NonNullable<ResponseOutputMessage['phase']>;

export interface AssistantOutputMessage {
  content: string;
  phase?: AssistantPhase;
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  outputMessages?: AssistantOutputMessage[];
  status?: MessageStatus;
  requestId?: string;
  openaiResponseId?: string;
  thinking?: string;
  refusal?: string;
  incompleteReason?: ResponseIncompleteReason;
  thinkingDuration?: number; // Time to first streamed output token in milliseconds
  usage?: OpenAIResponsesUsage;
  sources?: Source[];
  generatedFiles?: GeneratedFile[];
  timestamp: number;
  attachments?: FileAttachment[];
  model?: string;
  modelName?: string; // Required for persisted assistant messages
  reasoningEffort?: string;
  fileSearchCallCount?: number;
}

export interface FileAttachment {
  name: string;
  type: string;
  size?: number;
  localBlob?: LocalBlobReference;
  content?: string; // Transient Responses API input; never persisted
  previewUrl?: string; // Runtime-only object URL for locally stored images
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  config: ChatConfig;
  lastModified: number;
  pendingRequest?: PendingRequest;
  projectId?: string;
}

export type ProjectIcon =
  | 'folder'
  | 'briefcase'
  | 'code'
  | 'book'
  | 'research'
  | 'writing'
  | 'health';

export type ProjectSourceCapability =
  | 'file_search'
  | 'code_interpreter'
  | 'direct_attachment';

export interface ProjectSource {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number;
  localBlob: LocalBlobReference;
  capability: ProjectSourceCapability;
  addedAt: number;
}

export type ProjectDefaultConfig = Omit<ChatConfig, 'systemInstructionId'>;

export interface Project {
  id: string;
  name: string;
  icon: ProjectIcon;
  instructions: string;
  defaultConfig: ProjectDefaultConfig;
  sources: ProjectSource[];
  createdAt: number;
  updatedAt: number;
}

export type ProjectRemoteStatus =
  | 'disconnected'
  | 'creating'
  | 'ready'
  | 'failed'
  | 'deleting';

export type ProjectRemoteFileStatus =
  | 'uploading'
  | 'indexing'
  | 'ready'
  | 'failed'
  | 'removing';

export interface ProjectRemoteFile {
  projectSourceId: string;
  openaiFileId?: string;
  status: ProjectRemoteFileStatus;
  indexedUsageBytes?: number;
  lastError?: string;
}

export interface ProjectRemoteIndex {
  projectId: string;
  apiKeyFingerprint: string;
  vectorStoreId?: string;
  status: ProjectRemoteStatus;
  usageBytes: number;
  files: Record<string, ProjectRemoteFile>;
  lastVerifiedAt?: number;
}

export interface RemoteCleanupTombstone {
  id: string;
  projectId?: string;
  projectSourceId?: string;
  apiKeyFingerprint: string;
  openaiFileIds: string[];
  vectorStoreId?: string;
  createdAt: number;
  lastError?: string;
}

export interface ProjectRemoteState {
  indexes: Record<string, ProjectRemoteIndex>;
  cleanupTombstones: RemoteCleanupTombstone[];
}

export interface ResolvedProjectContext {
  projectId: string;
  instructions: string;
  vectorStoreId?: string;
  analysisFileIds: string[];
  sourceIdByFileId?: Readonly<Record<string, string>>;
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
export type OpenAIResponsesUsage = ResponseUsage;

export const DEFAULT_CONFIG: ChatConfig = {
  model: ModelId.GPT_5_6_SOL,
  reasoningEffort: 'medium',
  textVerbosity: 'medium',
  tools: {
    webSearch: true,
    webSearchOptions: {
      searchContextSize: 'medium',
      userLocation: {
        type: 'approximate',
        city: 'New York',
        region: 'NY',
        country: 'US'
      }
    },
    codeInterpreter: false,
  },
  systemInstructionId: undefined
};
