import OpenAI from 'openai';
import type {
  Response as OpenAIResponse,
  ResponseFunctionWebSearch,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputText
} from 'openai/resources/responses/responses';
import { getModelConfig, getNormalizedReasoningEffort, normalizeChatConfig } from '../constants';
import {
  ChatConfig,
  GeneratedFile,
  Message,
  ModelId,
  OpenAIResponsesConfig,
  OpenAIResponsesContentPart,
  OpenAIResponsesInput,
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
}

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
  action: ResponseFunctionWebSearch['action']
): OpenAIResponseSource[] => {
  if (!('sources' in action) || !Array.isArray(action.sources)) return [];

  return action.sources;
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

const isCitationMarkerSpan = (text: string): boolean => {
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

const stripAdjacentCitationSourceLabels = (content: string): string => {
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
        isDomainLikeSourceLabel(label) ? marker : match
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
  const linkRegex = /\[([^\]]+?)\]\((https?:\/\/[^\)]+?)\)/g;
  const extractedSources: Source[] = [];
  const sourceIndexByUrl = new Map<string, number>();

  const updatedContent = content.replace(linkRegex, (match, title, url) => {
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

    return formatCitationMarkdownLink(citationNumber, extractedSource.url);
  });

  return {
    content: updatedContent,
    sources: extractedSources
  };
};

interface CitationRegistry {
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

const applyCitationAnnotations = (
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

export const generateResponse = async (
  messages: Message[],
  config: ChatConfig,
  providedApiKey?: string,
  systemInstruction?: string
): Promise<GenerateResponseResult> => {
  const apiKey = providedApiKey || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    throw new Error('OpenAI API Key is missing. Please set OPENAI_API_KEY in your environment or enter it in the settings.');
  }

  const latestMessage = messages[messages.length - 1];

  if (!latestMessage || latestMessage.role !== 'user') {
    throw new Error('A user message is required to generate a response.');
  }

  // Initialize OpenAI Client per request to support dynamic keys
  const openai = new OpenAI({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true, // Required for client-side usage
    maxRetries: 0, // Disable auto-retries to prevent duplicate API calls
    timeout: 60 * 60 * 1000 // 1 hour timeout for long-running reasoning requests
  });
  const normalizedConfig = normalizeChatConfig(config);
  const modelConfig = getModelConfig(normalizedConfig.model);
  const previousResponseId = getPreviousResponseId(messages);
  const inputMessages = previousResponseId ? [latestMessage] : messages;
  const apiInput = inputMessages.map(mapMessageToResponseInput);

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

  const payload: OpenAIResponsesConfig = {
    model: normalizedConfig.model,
    input: apiInput,
    tools: tools,
    store: true,
    include: [
      'code_interpreter_call.outputs',
      'web_search_call.action.sources'
    ],
    text: textConfig
  };

  if (systemInstruction) {
    payload.instructions = systemInstruction;
  }

  if (previousResponseId) {
    payload.previous_response_id = previousResponseId;
  }

  const reasoningEffort = getNormalizedReasoningEffort(
    normalizedConfig.model,
    normalizedConfig.reasoningEffort
  );

  if (reasoningEffort !== 'none') {
    payload.reasoning = {
      effort: reasoningEffort
    };
  } else if (modelConfig.reasoningOptions.includes('none')) {
    payload.reasoning = {
      effort: 'none'
    };
  }

  try {
    const startTime = Date.now();
    const response = await openai.responses.create(payload);
    const endTime = Date.now();
    const thinkingDuration = endTime - startTime;

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
          content += getResponseOutputMessageText(item, citationRegistry);
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
      thinking,
      sources,
      generatedFiles: generatedFiles.length > 0 ? generatedFiles : undefined,
      thinkingDuration,
      responseId: response.id
    };
  } catch (error: unknown) {
    console.error('OpenAI API Error:', error);
    throw new Error(error instanceof Error ? error.message : 'Failed to generate response');
  }
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
