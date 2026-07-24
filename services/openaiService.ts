import OpenAI from 'openai';
import type {
  Response as OpenAIResponse,
  ResponseCodeInterpreterToolCall,
  ResponseFunctionWebSearch,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseReasoningItem
} from 'openai/resources/responses/responses';
import {
  getModelConfig,
  getModelInstructions,
  getNormalizedReasoningEffort,
  normalizeChatConfig
} from '../constants';
import {
  ChatConfig,
  FileAttachment,
  GeneratedFile,
  Message,
  ModelId,
  OpenAIResponsesConfig,
  OpenAIResponsesContentPart,
  OpenAIResponsesInput,
  OpenAIResponsesStreamEvent,
  OpenAIResponsesStreamingConfig,
  OpenAIResponsesUsage,
  ReasoningEffort,
  Source
} from '../types';
import { createSourceRecord } from '../utils/sourceUrls';

const TITLE_GENERATION_INSTRUCTIONS = 'Summarize the following message into a short, concise title (max 5 words). Do not use quotes.';

type OpenAIResponseSource = ResponseFunctionWebSearch.Search.Source & {
  title?: string;
  uri?: string;
};

type OpenAIResponseUrlCitationAnnotation = Partial<ResponseOutputText.URLCitation> & {
  type: 'url_citation';
  url: string;
};
type OpenAIResponseContainerFileCitationAnnotation = ResponseOutputText.ContainerFileCitation;
type OpenAIResponseContainerFileCitationCandidate =
  Partial<OpenAIResponseContainerFileCitationAnnotation> & {
    type: 'container_file_citation';
  };

interface GenerateResponseResult {
  content: string;
  thinking?: string;
  sources?: Source[];
  generatedFiles?: GeneratedFile[];
  thinkingDuration: number;
  responseId?: string;
  usage?: OpenAIResponsesUsage;
}

interface GenerateResponseOptions {
  signal?: AbortSignal;
  onResponseCreated?: (responseId: string) => void;
  onReasoningSummaryDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  resolveAttachmentContent?: (attachment: FileAttachment) => Promise<string | undefined>;
}

interface OpenAIErrorDetails {
  message: string;
  status?: number;
  code?: string;
  param?: string;
  type?: string;
  requestId?: string;
}

export class OpenAIServiceError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly param?: string;
  readonly type?: string;
  readonly requestId?: string;

  constructor(details: OpenAIErrorDetails) {
    super(details.message);
    this.name = 'OpenAIServiceError';
    this.status = details.status;
    this.code = details.code;
    this.param = details.param;
    this.type = details.type;
    this.requestId = details.requestId;
  }
}

type OpenAIReasoningConfig = NonNullable<OpenAIResponsesStreamingConfig['reasoning']>;
type OpenAIReasoningEffort = NonNullable<OpenAIReasoningConfig['effort']>;

const toOpenAIReasoningEffort = (effort: ReasoningEffort): OpenAIReasoningEffort => (
  // The GPT-5.6 API supports `max`; openai@6.26.0 response typings do not list it yet.
  effort as OpenAIReasoningEffort
);

const getMonotonicTime = (): number => (
  typeof performance !== 'undefined' ? performance.now() : Date.now()
);

const GENERATED_FILE_MIME_TYPES: Record<string, string> = {
  csv: 'text/csv',
  gif: 'image/gif',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip'
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

const getStringProperty = (
  value: Record<string, unknown>,
  key: string
): string | undefined => {
  const property = value[key];

  if (typeof property !== 'string') return undefined;

  const trimmedProperty = property.trim();
  return trimmedProperty.length > 0 ? trimmedProperty : undefined;
};

const isWebSearchResponseItem = (
  item: ResponseOutputItem
): item is ResponseFunctionWebSearch => item.type === 'web_search_call';

const isCodeInterpreterResponseItem = (
  item: ResponseOutputItem
): item is ResponseCodeInterpreterToolCall => item.type === 'code_interpreter_call';

const isReasoningResponseItem = (
  item: ResponseOutputItem
): item is ResponseReasoningItem => item.type === 'reasoning';

const isUrlCitationAnnotation = (
  annotation: unknown
): annotation is OpenAIResponseUrlCitationAnnotation => {
  return (
    isRecord(annotation) &&
    annotation.type === 'url_citation' &&
    typeof annotation.url === 'string'
  );
};

const isContainerFileCitationAnnotation = (
  value: unknown
): value is OpenAIResponseContainerFileCitationCandidate => (
  isRecord(value) && value.type === 'container_file_citation'
);

const isOpenAIResponseSource = (value: unknown): value is OpenAIResponseSource => (
  isRecord(value) && typeof value.url === 'string'
);

const getWebSearchActionSources = (
  action: ResponseFunctionWebSearch['action'] | undefined
): OpenAIResponseSource[] => {
  if (!isRecord(action) || !Array.isArray(action.sources)) return [];

  return action.sources.filter(isOpenAIResponseSource);
};

const getLegacyStringProperty = (
  value: unknown,
  key: string
): string | undefined => {
  if (!isRecord(value)) return undefined;

  return getStringProperty(value, key);
};

const getLegacyTopLevelWebSearchSources = (
  response: OpenAIResponse
): OpenAIResponseSource[] => {
  if (!isRecord(response)) return [];

  const webSearchCall = response.web_search_call;
  if (!isRecord(webSearchCall)) return [];

  const action = webSearchCall.action;
  if (!isRecord(action) || !Array.isArray(action.sources)) return [];

  return action.sources.filter(isOpenAIResponseSource);
};

const getGeneratedFileDisplayName = (filename: string): string => {
  const pathSegments = filename.split(/[\\/]/).filter(Boolean);
  const displayName = (pathSegments[pathSegments.length - 1] || filename).trim();

  return displayName || 'generated-file';
};

const getGeneratedFileMimeType = (filename: string): string | undefined => {
  const extension = filename.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase();

  if (!extension || extension === filename.toLowerCase()) {
    return undefined;
  }

  return GENERATED_FILE_MIME_TYPES[extension];
};

const mapContainerFileCitationToGeneratedFile = (
  annotation: OpenAIResponseContainerFileCitationCandidate
): GeneratedFile | null => {
  const fileId = getLegacyStringProperty(annotation, 'file_id');
  const containerId = getLegacyStringProperty(annotation, 'container_id');

  if (!fileId || !containerId) return null;

  const filename = getLegacyStringProperty(annotation, 'filename') || fileId;
  const mimeType = getGeneratedFileMimeType(filename);

  return {
    filename,
    fileId,
    containerId,
    displayName: getGeneratedFileDisplayName(filename),
    ...(mimeType ? { mimeType } : {}),
    source: 'container_file_citation'
  };
};

const addGeneratedFile = (
  generatedFiles: GeneratedFile[],
  seenGeneratedFileKeys: Set<string>,
  generatedFile: GeneratedFile
): void => {
  const generatedFileKey = `${generatedFile.containerId}:${generatedFile.fileId}`;

  if (seenGeneratedFileKeys.has(generatedFileKey)) return;

  seenGeneratedFileKeys.add(generatedFileKey);
  generatedFiles.push(generatedFile);
};

const collectGeneratedFilesFromValue = (
  value: unknown,
  generatedFiles: GeneratedFile[],
  seenGeneratedFileKeys: Set<string>,
  seenObjects: Set<object>
): void => {
  if (typeof value !== 'object' || value === null) return;

  if (seenObjects.has(value)) return;
  seenObjects.add(value);

  if (isContainerFileCitationAnnotation(value)) {
    const generatedFile = mapContainerFileCitationToGeneratedFile(value);

    if (generatedFile) {
      addGeneratedFile(generatedFiles, seenGeneratedFileKeys, generatedFile);
    }
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectGeneratedFilesFromValue(
        item,
        generatedFiles,
        seenGeneratedFileKeys,
        seenObjects
      );
    });
    return;
  }

  Object.values(value).forEach((propertyValue) => {
    collectGeneratedFilesFromValue(
      propertyValue,
      generatedFiles,
      seenGeneratedFileKeys,
      seenObjects
    );
  });
};

const collectGeneratedFilesFromOutput = (
  output: ResponseOutputItem[] | undefined
): GeneratedFile[] => {
  if (!output || !Array.isArray(output)) return [];

  const generatedFiles: GeneratedFile[] = [];
  const seenGeneratedFileKeys = new Set<string>();
  const seenObjects = new Set<object>();

  collectGeneratedFilesFromValue(
    output,
    generatedFiles,
    seenGeneratedFileKeys,
    seenObjects
  );

  return generatedFiles;
};

const getSourceKey = (url: string): string => url.trim();

const formatCitationMarkdownLink = (citationNumber: number, url: string): string => {
  const escapedUrl = url.trim().replace(/>/g, '%3E');
  return `[[${citationNumber}]](<${escapedUrl}>)`;
};

export const isCitationMarkerSpan = (text: string): boolean => {
  const trimmedText = text.trim();

  if (!trimmedText) return false;

  const sourceLabel = trimmedText
    .replace(/^[([{]\s*/, '')
    .replace(/\s*[)\]}]$/, '');

  return (
    /^\u3010[^\u3011]+\u3011$/.test(trimmedText) ||
    /^\uE200cite\uE202.+?\uE201$/.test(trimmedText) ||
    /^\[\d+(?:\s*[-,]\s*\d+)*\]$/.test(trimmedText) ||
    /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(sourceLabel)
  );
};

const normalizeSourceLabel = (label: string): string => {
  return label
    .trim()
    .toLowerCase()
    .replace(/^[([{]\s*/, '')
    .replace(/\s*[)\]}]$/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
};

const isDomainLikeSourceLabel = (label: string): boolean => (
  /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(normalizeSourceLabel(label))
);

export const stripAdjacentCitationSourceLabels = (content: string): string => {
  const withoutAdjacentLabels = content
    .replace(
      /(^|[ \t])\(([^()\n]{3,160})\)([ \t]*(?:\[\[\d+\]\]\((?:<[^>\n]+>|https?:\/\/[^\s)\n]+)\)(?:[ \t]*)?)+)/g,
      (match, prefix, label, marker) => (
        isDomainLikeSourceLabel(label) ? `${prefix}${marker.trimStart()}` : match
      )
    )
    .replace(
      /((?:\[\[\d+\]\]\((?:<[^>\n]+>|https?:\/\/[^\s)\n]+)\)(?:[ \t]*)?)+)[ \t]*\(([^()\n]{3,160})\)/g,
      (match, marker, label) => (
        isDomainLikeSourceLabel(label) ? marker.trimEnd() : match
      )
    );

  return withoutAdjacentLabels.replace(
    /\(([^()\n]{0,300}?)((?:\[\[\d+\]\]\((?:<[^>\n]+>|https?:\/\/[^\s)\n]+)\)(?:[ \t]*)?)+)[\]\s]*\)/g,
    (match: string, labelPrefix: string, markers: string) => {
      const remainder = labelPrefix
        .replace(/\[([^\]\n]{3,160})\]/g, (labelMatch: string, label: string) => (
          isDomainLikeSourceLabel(label) ? '' : labelMatch
        ))
        .replace(
          /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,;\]]*)?/gi,
          (label: string) => (isDomainLikeSourceLabel(label) ? '' : label)
        )
        .replace(/[\s,;\[\]]+/g, '');

      return remainder.length === 0 ? markers.trim() : match;
    }
  );
};

const replaceInlineCitationSourceLabels = (
  text: string,
  markerText: string
): {
  text: string;
  replaced: boolean;
} => {
  let replaced = false;

  const updatedText = text.replace(
    /\(([^()\n]{3,160})\)/g,
    (match, label) => {
      if (!isDomainLikeSourceLabel(label)) {
        return match;
      }

      replaced = true;
      return markerText;
    }
  );

  return {
    text: updatedText,
    replaced
  };
};

const mapSources = (sources: OpenAIResponseSource[] = []): Source[] => {
  const seenUrls = new Set<string>();
  const mappedSources: Source[] = [];

  sources.forEach((source, index) => {
    const sourceRecord = createSourceRecord(
      source.title,
      source.uri || source.url,
      `OpenAI response source #${index + 1}`
    );

    if (!sourceRecord) return;

    const sourceKey = getSourceKey(sourceRecord.url);
    if (seenUrls.has(sourceKey)) return;

    seenUrls.add(sourceKey);
    mappedSources.push(sourceRecord);
  });

  return mappedSources;
};

const extractMarkdownLinkCitations = (content: string): {
  content: string;
  sources: Source[];
} => {
  const linkRegex = /(^|[^!])\[([^\]]+?)\]\((https?:\/\/[^\)]+?)\)/g;
  const extractedSources: Source[] = [];
  const sourceIndexByUrl = new Map<string, number>();

  const updatedContent = content.replace(linkRegex, (match, prefix, title, url) => {
    const extractedSource = createSourceRecord(
      title,
      url,
      `Assistant citation #${extractedSources.length + 1}`
    );

    if (!extractedSource) {
      return match;
    }

    const sourceKey = getSourceKey(extractedSource.url);
    let citationNumber = sourceIndexByUrl.get(sourceKey);

    if (!citationNumber) {
      extractedSources.push(extractedSource);
      citationNumber = extractedSources.length;
      sourceIndexByUrl.set(sourceKey, citationNumber);
    }

    return `${prefix}${formatCitationMarkdownLink(citationNumber, extractedSource.url)}`;
  });

  return {
    content: updatedContent,
    sources: extractedSources
  };
};

export interface CitationRegistry {
  sources: Source[];
  sourceIndexByUrl: Map<string, number>;
}

interface CitationReplacement {
  startIndex: number;
  endIndex: number;
  citationNumbers: number[];
  urls: string[];
}

const getOrAddCitationSource = (
  registry: CitationRegistry,
  annotation: OpenAIResponseUrlCitationAnnotation
): {
  citationNumber: number;
  source: Source;
} | null => {
  const source = createSourceRecord(
    annotation.title,
    annotation.url,
    `OpenAI url_citation`
  );

  if (!source) return null;

  const sourceKey = getSourceKey(source.url);
  const existingCitationNumber = registry.sourceIndexByUrl.get(sourceKey);

  if (existingCitationNumber) {
    return {
      citationNumber: existingCitationNumber,
      source
    };
  }

  registry.sources.push(source);
  const citationNumber = registry.sources.length;
  registry.sourceIndexByUrl.set(sourceKey, citationNumber);

  return {
    citationNumber,
    source
  };
};

const getAnnotationSpanKey = (
  annotation: OpenAIResponseUrlCitationAnnotation
): string | null => {
  if (
    !Number.isInteger(annotation.start_index) ||
    !Number.isInteger(annotation.end_index)
  ) {
    return null;
  }

  return `${annotation.start_index}:${annotation.end_index}`;
};

const buildCitationReplacements = (
  text: string,
  annotations: unknown[] | undefined,
  registry: CitationRegistry
): CitationReplacement[] => {
  if (!annotations || annotations.length === 0) return [];

  const replacementsBySpan = new Map<string, CitationReplacement>();

  annotations.forEach((annotation) => {
    if (!isUrlCitationAnnotation(annotation)) return;

    const spanKey = getAnnotationSpanKey(annotation);
    if (!spanKey) return;

    const startIndex = annotation.start_index as number;
    const endIndex = annotation.end_index as number;

    if (
      startIndex < 0 ||
      endIndex <= startIndex ||
      startIndex >= text.length ||
      endIndex > text.length
    ) {
      return;
    }

    const citationSource = getOrAddCitationSource(registry, annotation);
    if (!citationSource) return;

    const existingReplacement = replacementsBySpan.get(spanKey);

    if (existingReplacement) {
      if (!existingReplacement.citationNumbers.includes(citationSource.citationNumber)) {
        existingReplacement.citationNumbers.push(citationSource.citationNumber);
        existingReplacement.urls.push(citationSource.source.url);
      }
      return;
    }

    replacementsBySpan.set(spanKey, {
      startIndex,
      endIndex,
      citationNumbers: [citationSource.citationNumber],
      urls: [citationSource.source.url]
    });
  });

  return Array.from(replacementsBySpan.values()).sort((a, b) => (
    a.startIndex === b.startIndex
      ? a.endIndex - b.endIndex
      : a.startIndex - b.startIndex
  ));
};

export const applyCitationAnnotations = (
  text: string,
  annotations: unknown[] | undefined,
  registry: CitationRegistry
): string => {
  const replacements = buildCitationReplacements(text, annotations, registry);

  if (replacements.length === 0) {
    return text;
  }

  let updatedText = '';
  let cursor = 0;

  replacements.forEach((replacement) => {
    if (replacement.startIndex < cursor) return;

    const spanText = text.slice(replacement.startIndex, replacement.endIndex);
    const markerText = replacement.citationNumbers
      .map((citationNumber, index) => (
        formatCitationMarkdownLink(citationNumber, replacement.urls[index])
      ))
      .join(' ');

    updatedText += text.slice(cursor, replacement.startIndex);
    const spanWithCitationMarkers = replaceInlineCitationSourceLabels(spanText, markerText);

    if (spanWithCitationMarkers.replaced) {
      updatedText += spanWithCitationMarkers.text;
    } else {
      updatedText += isCitationMarkerSpan(spanText)
        ? markerText
        : `${spanText}${markerText}`;
    }
    cursor = replacement.endIndex;
  });

  updatedText += text.slice(cursor);

  return stripAdjacentCitationSourceLabels(updatedText);
};

const getResponseOutputMessageText = (
  message: ResponseOutputMessage,
  citationRegistry?: CitationRegistry
): string => {
  const messageContent: unknown = message.content;

  if (typeof messageContent === 'string') return messageContent;
  if (!Array.isArray(messageContent)) return '';

  return messageContent.map((part) => {
    if (!isRecord(part)) return '';

    const text = typeof part.text === 'string' ? part.text : '';

    if (
      citationRegistry &&
      part.type === 'output_text' &&
      Array.isArray(part.annotations)
    ) {
      return applyCitationAnnotations(text, part.annotations, citationRegistry);
    }

    return text;
  }).join('');
};

const getLongestBacktickRun = (content: string): number => {
  const backtickRuns = content.match(/`+/g);

  if (!backtickRuns) return 0;

  return backtickRuns.reduce((longestRun, run) => (
    Math.max(longestRun, run.length)
  ), 0);
};

const formatMarkdownCodeBlock = (content: string, language: string): string => {
  if (!content.trim()) return '';

  const fence = '`'.repeat(Math.max(3, getLongestBacktickRun(content) + 1));
  const trimmedContent = content.replace(/\s+$/, '');

  return `${fence}${language}\n${trimmedContent}\n${fence}`;
};

const formatCodeInterpreterOutput = (
  output: ResponseCodeInterpreterToolCall.Logs | ResponseCodeInterpreterToolCall.Image,
  index: number
): string => {
  if (output.type === 'logs') {
    const logs = formatMarkdownCodeBlock(output.logs, 'output');

    return logs ? `**Output**\n\n${logs}` : '';
  }

  if (output.type === 'image' && output.url.trim()) {
    return `![Code Interpreter output ${index + 1}](${output.url})`;
  }

  return '';
};

const formatCodeInterpreterCall = (
  item: ResponseCodeInterpreterToolCall
): string => {
  const sections: string[] = [];
  const code = item.code ? formatMarkdownCodeBlock(item.code, 'python') : '';

  if (code) {
    sections.push(`**Code Interpreter**\n\n${code}`);
  }

  item.outputs?.forEach((output, index) => {
    const formattedOutput = formatCodeInterpreterOutput(output, index);

    if (formattedOutput) {
      sections.push(formattedOutput);
    }
  });

  return sections.join('\n\n');
};

const appendMarkdownSection = (content: string, section: string): string => {
  const trimmedSection = section.trim();

  if (!trimmedSection) return content;
  if (!content.trim()) return trimmedSection;

  return `${content.trimEnd()}\n\n${trimmedSection}`;
};

const mapMessageToResponseInput = (message: Message): OpenAIResponsesInput => {
  const images = message.attachments?.filter(a => a.type.startsWith('image/') && a.content) || [];
  const otherAttachments = message.attachments?.filter(a => !a.type.startsWith('image/')) || [];
  const fileAttachments = otherAttachments.filter(a => a.content);
  const filenameFallbackAttachments = otherAttachments.filter(a => !a.content);

  if (images.length === 0 && fileAttachments.length === 0) {
    return {
      role: message.role,
      content: message.content + (filenameFallbackAttachments.length > 0 ? `\n\n[Attached Files: ${filenameFallbackAttachments.map(a => a.name).join(', ')}]` : '')
    };
  }

  const contentParts: OpenAIResponsesContentPart[] = [];

  if (message.content) {
    contentParts.push({ type: 'input_text', text: message.content });
  }

  images.forEach(img => {
    contentParts.push({
      type: 'input_image',
      image_url: img.content as string,
      detail: 'auto'
    });
  });

  fileAttachments.forEach(file => {
    contentParts.push({
      type: 'input_file',
      filename: file.name,
      file_data: file.content as string
    });
  });

  if (filenameFallbackAttachments.length > 0) {
    contentParts.push({
      type: 'input_text',
      text: `\n\n[Attached Files: ${filenameFallbackAttachments.map(a => a.name).join(', ')}]`
    });
  }

  return {
    role: message.role,
    content: contentParts
  };
};

const resolveMessageAttachmentContent = async (
  message: Message,
  resolver?: (attachment: FileAttachment) => Promise<string | undefined>
): Promise<Message> => {
  if (!resolver || !message.attachments?.length) return message;

  return {
    ...message,
    attachments: await Promise.all(message.attachments.map(async attachment => ({
      ...attachment,
      content: attachment.content || await resolver(attachment)
    })))
  };
};

const getPreviousResponseId = (messages: Message[]): string | undefined => {
  const previousMessage = messages[messages.length - 2];

  // Only thread when the stored server state exactly matches the local transcript
  // immediately before the newest user turn. This also keeps any active auto
  // Code Interpreter container in the previous response context available.
  if (previousMessage?.role === 'assistant' && previousMessage.openaiResponseId) {
    return previousMessage.openaiResponseId;
  }

  return undefined;
};

const getReasoningSummaryText = (item: ResponseReasoningItem): string => (
  item.summary
    .map(summary => summary.text)
    .filter(summary => summary.trim().length > 0)
    .join('\n\n')
);

const parseGenerateResponse = (
  response: OpenAIResponse,
  thinkingDuration: number,
  normalizedConfig: ChatConfig,
  streamedThinking = ''
): GenerateResponseResult => {
  let thinking = '';
  let content = '';
  const rawSources: OpenAIResponseSource[] = [];
  const citationRegistry: CitationRegistry = {
    sources: [],
    sourceIndexByUrl: new Map<string, number>()
  };
  const responseOutput = Array.isArray(response.output) ? response.output : undefined;
  const generatedFiles = collectGeneratedFilesFromOutput(responseOutput);

  if (responseOutput) {
    for (const item of responseOutput) {
      if (item.type === 'message') {
        content = appendMarkdownSection(
          content,
          getResponseOutputMessageText(item, citationRegistry)
        );
      } else if (isReasoningResponseItem(item)) {
        thinking = appendMarkdownSection(thinking, getReasoningSummaryText(item));
      } else if (isCodeInterpreterResponseItem(item)) {
        content = appendMarkdownSection(content, formatCodeInterpreterCall(item));
      } else if (isWebSearchResponseItem(item)) {
        rawSources.push(...getWebSearchActionSources(item.action));
      }
    }
  } else {
    if (response.output_text) content = response.output_text;
    else content = getLegacyStringProperty(response, 'content') || '';
  }

  if (rawSources.length === 0) {
    rawSources.push(...getLegacyTopLevelWebSearchSources(response));
  }

  if (citationRegistry.sources.length > 0) {
    content = stripAdjacentCitationSourceLabels(content);
  }

  let sources = citationRegistry.sources;

  if (sources.length === 0) {
    sources = mapSources(rawSources);
  }

  if (sources.length === 0 && !normalizedConfig.tools.webSearch) {
    const markdownCitations = extractMarkdownLinkCitations(content);
    content = markdownCitations.content;
    sources = markdownCitations.sources;
  }

  return {
    content,
    thinking: thinking || streamedThinking,
    sources,
    generatedFiles: generatedFiles.length > 0 ? generatedFiles : undefined,
    thinkingDuration,
    responseId: response.id,
    usage: response.usage
  };
};

const createAbortError = (): Error => {
  const error = new Error('Request aborted.');
  error.name = 'AbortError';
  return error;
};

const getOpenAIErrorDetails = (error: unknown): OpenAIErrorDetails => {
  const root = isRecord(error) ? error : undefined;
  const nestedError = root && isRecord(root.error) ? root.error : undefined;
  const status = root && typeof root.status === 'number' && Number.isFinite(root.status)
    ? root.status
    : undefined;

  return {
    message: (
      error instanceof Error
        ? error.message
        : undefined
    ) ||
      (nestedError && getStringProperty(nestedError, 'message')) ||
      (root && getStringProperty(root, 'message')) ||
      'OpenAI request failed.',
    status,
    code: (
      root && getStringProperty(root, 'code')
    ) || (
      nestedError && getStringProperty(nestedError, 'code')
    ),
    param: (
      root && getStringProperty(root, 'param')
    ) || (
      nestedError && getStringProperty(nestedError, 'param')
    ),
    type: (
      nestedError && getStringProperty(nestedError, 'type')
    ) || (
      root && getStringProperty(root, 'type')
    ),
    requestId: root && (
      getStringProperty(root, 'requestID') ||
      getStringProperty(root, 'request_id')
    )
  };
};

const getStreamEventError = (
  event: OpenAIResponsesStreamEvent
): OpenAIServiceError => {
  if (!isRecord(event)) {
    return new OpenAIServiceError({ message: 'OpenAI response failed.' });
  }

  const eventError = isRecord(event.error) ? event.error : undefined;
  const responseError = isRecord(event.response) && isRecord(event.response.error)
    ? event.response.error
    : undefined;
  const errorValue = eventError || responseError || event;
  const details = getOpenAIErrorDetails(errorValue);

  if (errorValue === event && details.type === event.type) {
    details.type = undefined;
  }

  return new OpenAIServiceError(details);
};

const PREVIOUS_RESPONSE_NOT_FOUND_CODES = new Set([
  'previous_response_not_found',
  'response_not_found',
  'not_found'
]);

const isUnresolvablePreviousResponseError = (error: unknown): boolean => {
  const details = getOpenAIErrorDetails(error);
  const code = details.code?.toLowerCase();
  const param = details.param?.toLowerCase();

  if (code === 'previous_response_not_found') return true;
  if (
    param === 'previous_response_id' &&
    code &&
    PREVIOUS_RESPONSE_NOT_FOUND_CODES.has(code)
  ) {
    return true;
  }
  if (
    details.status !== 400 &&
    details.status !== 403 &&
    details.status !== 404 &&
    details.status !== 422
  ) {
    return false;
  }

  const normalizedMessage = details.message.toLowerCase();
  const identifiesPreviousResponse = (
    param === 'previous_response_id' ||
    normalizedMessage.includes('previous_response_id') ||
    normalizedMessage.includes('previous response')
  );
  const cannotResolveResponse = (
    normalizedMessage.includes('not found') ||
    normalizedMessage.includes('cannot be resolved') ||
    normalizedMessage.includes('could not be resolved') ||
    normalizedMessage.includes('does not exist') ||
    normalizedMessage.includes('no longer exists') ||
    normalizedMessage.includes('expired') ||
    normalizedMessage.includes('not accessible') ||
    normalizedMessage.includes('different project') ||
    normalizedMessage.includes('another project')
  );

  return identifiesPreviousResponse && cannotResolveResponse;
};

const isReasoningSummaryUnavailableError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;

  const status = error.status;
  if (status !== 400 && status !== 403 && status !== 422) return false;

  const nestedError = isRecord(error.error) ? error.error : undefined;
  const details = [
    getStringProperty(error, 'message'),
    getStringProperty(error, 'code'),
    getStringProperty(error, 'param'),
    getStringProperty(error, 'type'),
    nestedError && getStringProperty(nestedError, 'message'),
    nestedError && getStringProperty(nestedError, 'code'),
    nestedError && getStringProperty(nestedError, 'param'),
    nestedError && getStringProperty(nestedError, 'type')
  ].filter((detail): detail is string => Boolean(detail));
  const normalizedDetails = details.join(' ').toLowerCase();

  return normalizedDetails.includes('reasoning.summary') ||
    normalizedDetails.includes('reasoning summary') ||
    normalizedDetails.includes('reasoning summaries') ||
    (normalizedDetails.includes('organization') && normalizedDetails.includes('verif'));
};

const withoutReasoningSummary = (
  payload: OpenAIResponsesStreamingConfig
): OpenAIResponsesStreamingConfig => {
  if (!payload.reasoning) return payload;

  const reasoning = { ...payload.reasoning };
  delete reasoning.summary;

  return {
    ...payload,
    reasoning
  };
};

export const generateResponse = async (
  messages: Message[],
  config: ChatConfig,
  providedApiKey?: string,
  systemInstruction?: string,
  options: GenerateResponseOptions = {}
): Promise<GenerateResponseResult> => {
  const apiKey = providedApiKey || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    throw new Error('OpenAI API Key is missing. Please set OPENAI_API_KEY in your environment or enter it in the settings.');
  }

  const latestMessage = messages[messages.length - 1];

  if (!latestMessage || latestMessage.role !== 'user') {
    throw new Error('A user message is required to generate a response.');
  }

  // Error rows are local UI state, not assistant output. Replaying them when
  // response threading is unavailable would present failures as conversation.
  const replayableMessages = messages.filter(message => message.status !== 'error');

  // Initialize OpenAI Client per request to support dynamic keys
  const openai = new OpenAI({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true, // Required for client-side usage
    maxRetries: 0, // Disable auto-retries to prevent duplicate API calls
    timeout: 60 * 60 * 1000 // 1 hour timeout for long-running reasoning requests
  });
  const normalizedConfig = normalizeChatConfig(config);
  const modelConfig = getModelConfig(normalizedConfig.model);
  const previousResponseId = getPreviousResponseId(replayableMessages);
  const resolvedMessageCache = new Map<Message, Promise<Message>>();
  const getResolvedMessage = (message: Message): Promise<Message> => {
    let resolvedMessage = resolvedMessageCache.get(message);
    if (!resolvedMessage) {
      resolvedMessage = resolveMessageAttachmentContent(
        message,
        options.resolveAttachmentContent
      );
      resolvedMessageCache.set(message, resolvedMessage);
    }
    return resolvedMessage;
  };
  const buildApiInput = async (inputMessages: Message[]): Promise<OpenAIResponsesInput[]> => (
    Promise.all(inputMessages.map(getResolvedMessage))
      .then(resolvedMessages => resolvedMessages.map(mapMessageToResponseInput))
  );
  const apiInput = await buildApiInput(
    previousResponseId ? [latestMessage] : replayableMessages
  );

  const tools: NonNullable<OpenAIResponsesConfig['tools']> = [];

  if (normalizedConfig.tools.webSearch) {
    tools.push({
      type: 'web_search',
      user_location: {
        type: 'approximate',
        country: 'US',
        region: 'NY',
        city: 'New York'
      },
      search_context_size: 'medium'
    });
  }

  if (normalizedConfig.tools.codeInterpreter) {
    tools.push({
      type: 'code_interpreter',
      container: {
        type: 'auto'
      }
    });
  }

  const textConfig: NonNullable<OpenAIResponsesConfig['text']> = {
    format: { type: 'text' }
  };

  if (modelConfig.supportsVerbosity) {
    textConfig.verbosity = normalizedConfig.textVerbosity;
  }

  const payload: OpenAIResponsesStreamingConfig = {
    model: normalizedConfig.model,
    input: apiInput,
    tools: tools,
    store: true,
    stream: true,
    include: [
      'code_interpreter_call.outputs',
      'web_search_call.action.sources'
    ],
    text: textConfig
  };

  payload.instructions = getModelInstructions(normalizedConfig.model, systemInstruction);

  if (previousResponseId) {
    payload.previous_response_id = previousResponseId;
  }

  const reasoningEffort = getNormalizedReasoningEffort(
    normalizedConfig.model,
    normalizedConfig.reasoningEffort
  );

  if (reasoningEffort !== 'none') {
    payload.reasoning = {
      effort: toOpenAIReasoningEffort(reasoningEffort),
      summary: 'auto'
    };
  } else if (modelConfig.reasoningOptions.includes('none')) {
    payload.reasoning = {
      effort: 'none'
    };
  }

  try {
    const startTime = getMonotonicTime();
    const createStream = (streamPayload: OpenAIResponsesStreamingConfig) => (
      openai.responses.create(
        streamPayload,
        options.signal ? { signal: options.signal } : undefined
      )
    );
    const createStreamWithCapabilityFallback = async (
      streamPayload: OpenAIResponsesStreamingConfig
    ): Promise<Awaited<ReturnType<typeof createStream>>> => {
      try {
        return await createStream(streamPayload);
      } catch (error) {
        if (
          !streamPayload.reasoning?.summary ||
          !isReasoningSummaryUnavailableError(error)
        ) {
          throw error;
        }

        // Some accounts or models cannot request summaries. The first request was
        // rejected before a stream existed, so retry once without that optional field.
        return createStream(withoutReasoningSummary(streamPayload));
      }
    };
    let stream: Awaited<ReturnType<typeof createStream>>;

    try {
      stream = await createStreamWithCapabilityFallback(payload);
    } catch (error) {
      if (
        !previousResponseId ||
        !isUnresolvablePreviousResponseError(error)
      ) {
        throw error;
      }

      if (options.signal?.aborted) throw createAbortError();

      const fallbackPayload: OpenAIResponsesStreamingConfig = {
        ...payload,
        input: await buildApiInput(replayableMessages)
      };
      delete fallbackPayload.previous_response_id;
      stream = await createStreamWithCapabilityFallback(fallbackPayload);
    }

    let completedResponse: OpenAIResponse | undefined;
    let streamedThinking = '';
    let activeReasoningSummaryPart: string | undefined;
    let timeToFirstToken = 0;

    for await (const event of stream) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }

      if (event.type === 'response.created') {
        options.onResponseCreated?.(event.response.id);
      } else if (event.type === 'response.reasoning_summary_text.delta') {
        const summaryPart = `${event.output_index}:${event.summary_index}`;
        const separator = streamedThinking && activeReasoningSummaryPart !== summaryPart
          ? '\n\n'
          : '';
        const delta = separator + event.delta;

        activeReasoningSummaryPart = summaryPart;
        streamedThinking += delta;
        options.onReasoningSummaryDelta?.(delta);
      } else if (event.type === 'response.output_text.delta') {
        if (timeToFirstToken === 0 && event.delta.length > 0) {
          timeToFirstToken = getMonotonicTime() - startTime;
        }
        options.onTextDelta?.(event.delta);
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        // Incomplete responses (token limit, content filter) still carry the
        // partial output, citations, and usage — surface them like completions.
        completedResponse = event.response;
      } else if (event.type === 'response.failed' || event.type === 'error') {
        throw getStreamEventError(event);
      }
    }

    if (options.signal?.aborted) {
      throw createAbortError();
    }

    if (!completedResponse) {
      throw new Error('Response stream ended before completion.');
    }

    return parseGenerateResponse(
      completedResponse,
      timeToFirstToken,
      normalizedConfig,
      streamedThinking
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }

    console.error('OpenAI API Error:', error);
    if (error instanceof Error) throw error;
    throw new OpenAIServiceError(getOpenAIErrorDetails(error));
  }
};

export const cancelResponse = async (
  responseId: string,
  providedApiKey?: string
): Promise<void> => {
  const apiKey = providedApiKey || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    throw new Error('OpenAI API Key is missing. Please enter it in the settings before cancelling a response.');
  }

  const openai = new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 0
  });

  await openai.responses.cancel(responseId);
};

export const fetchGeneratedFileContent = async (
  generatedFile: GeneratedFile,
  providedApiKey?: string
): Promise<Blob> => {
  const apiKey = providedApiKey || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    throw new Error('OpenAI API Key is missing. Please enter it in the settings before downloading generated files.');
  }

  if (!generatedFile.containerId || !generatedFile.fileId) {
    throw new Error('Generated file metadata is incomplete.');
  }

  const openai = new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true
  });

  const response = await openai.containers.files.content.retrieve(
    generatedFile.fileId,
    { container_id: generatedFile.containerId }
  );

  if (!response.ok) {
    throw new Error(`Failed to download generated file (${response.status}).`);
  }

  return response.blob();
};

export const generateChatTitle = async (
  content: string,
  providedApiKey?: string
): Promise<string> => {
  const apiKey = providedApiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey) return 'New Chat';

  const openai = new OpenAI({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true
  });

  try {
    const payload: OpenAIResponsesConfig = {
      model: ModelId.GPT_5_NANO,
      instructions: TITLE_GENERATION_INSTRUCTIONS,
      input: [
        { role: 'user', content: content || 'Analysis request' }
      ],
      text: {
        format: { type: 'text' },
        verbosity: 'low'
      },
      reasoning: {
        effort: 'minimal'
      },
      store: true
    };

    const response = await openai.responses.create(payload);

    let title = '';
    const responseOutput = Array.isArray(response.output) ? response.output : undefined;

    if (responseOutput) {
      for (const item of responseOutput) {
        if (item.type === 'message') {
          title += getResponseOutputMessageText(item);
        }
      }
    } else {
      if (response.output_text) title = response.output_text;
      else title = getLegacyStringProperty(response, 'content') || '';
    }

    return title?.replace(/^"|"$/g, '').trim() || 'New Chat';
  } catch (error) {
    console.warn('Failed to generate title:', error);
    return content.slice(0, 30) + (content.length > 30 ? '...' : '');
  }
};
