
import OpenAI from 'openai';
import { getModelConfig, normalizeChatConfig } from '../constants';
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

interface OpenAIResponseSource {
  title?: string;
  uri?: string;
  url?: string;
}

interface OpenAIResponseUrlCitationAnnotation {
  type: 'url_citation';
  start_index?: number;
  end_index?: number;
  url?: string;
  title?: string;
  [key: string]: unknown;
}

interface OpenAIResponseContainerFileCitationAnnotation {
  type: 'container_file_citation';
  start_index?: number;
  end_index?: number;
  container_id?: string;
  file_id?: string;
  filename?: string;
  [key: string]: unknown;
}

type OpenAIResponseAnnotation =
  | OpenAIResponseUrlCitationAnnotation
  | OpenAIResponseContainerFileCitationAnnotation
  | { type?: string; [key: string]: unknown };

interface OpenAIResponseMessageContentPart {
  type?: string;
  text?: string;
  annotations?: OpenAIResponseAnnotation[];
  [key: string]: unknown;
}

interface OpenAIResponseMessageItem {
  type: 'message';
  content?: string | OpenAIResponseMessageContentPart[];
}

interface OpenAIResponseWebSearchItem {
  type: 'web_search_call';
  action?: {
    sources?: OpenAIResponseSource[];
  };
}

interface OpenAIResponseCodeInterpreterItem {
  type: 'code_interpreter_call';
  container_id?: string;
  outputs?: Array<{ type?: string; [key: string]: unknown }> | null;
  [key: string]: unknown;
}

type OpenAIResponseOutputItem =
  | OpenAIResponseMessageItem
  | OpenAIResponseWebSearchItem
  | OpenAIResponseCodeInterpreterItem
  | { type: string; [key: string]: unknown };

interface OpenAIResponsePayload {
  id?: string;
  output?: OpenAIResponseOutputItem[];
  output_text?: string;
  content?: string;
  web_search_call?: {
    action?: {
      sources?: OpenAIResponseSource[];
    };
  };
}

interface OpenAIResponsesClient {
  responses: {
    create: (payload: OpenAIResponsesConfig) => Promise<OpenAIResponsePayload>;
  };
}

interface OpenAIContainersClient {
  containers: {
    files: {
      content: {
        retrieve: (
          fileId: string,
          params: { container_id: string }
        ) => Promise<Response>;
      };
    };
  };
}

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
  item: OpenAIResponseOutputItem
): item is OpenAIResponseWebSearchItem => item.type === 'web_search_call';

const isUrlCitationAnnotation = (
  annotation: OpenAIResponseAnnotation
): annotation is OpenAIResponseUrlCitationAnnotation => {
  return annotation.type === 'url_citation' && typeof annotation.url === 'string';
};

const isContainerFileCitationAnnotation = (
  value: unknown
): value is OpenAIResponseContainerFileCitationAnnotation => (
  isRecord(value) && value.type === 'container_file_citation'
);

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
  annotation: OpenAIResponseContainerFileCitationAnnotation
): GeneratedFile | null => {
  const fileId = getStringProperty(annotation, 'file_id');
  const containerId = getStringProperty(annotation, 'container_id');

  if (!fileId || !containerId) return null;

  const filename = getStringProperty(annotation, 'filename') || fileId;
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
  output: OpenAIResponseOutputItem[] | undefined
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
  annotations: OpenAIResponseAnnotation[] | undefined,
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
  annotations: OpenAIResponseAnnotation[] | undefined,
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
      image_url: img.content as string
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
  const responsesClient = openai as unknown as OpenAIResponsesClient;
  const previousResponseId = getPreviousResponseId(messages);
  const inputMessages = previousResponseId ? [latestMessage] : messages;
  const apiInput: OpenAIResponsesInput[] = inputMessages.map(mapMessageToResponseInput);

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

  if (normalizedConfig.reasoningEffort !== 'none') {
    payload.reasoning = {
      effort: normalizedConfig.reasoningEffort
    };
  } else if (modelConfig.reasoningOptions.includes('none')) {
    payload.reasoning = {
      effort: 'none'
    };
  }

  try {
    const startTime = Date.now();
    const response = await responsesClient.responses.create(payload);
    const endTime = Date.now();
    const thinkingDuration = endTime - startTime;

    let thinking = '';
    let content = '';
    const rawSources: OpenAIResponseSource[] = [];
    const citationRegistry: CitationRegistry = {
      sources: [],
      sourceIndexByUrl: new Map<string, number>()
    };
    const generatedFiles = collectGeneratedFilesFromOutput(response.output);

    if (response.output && Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'message') {
          if (typeof item.content === 'string') {
            content += item.content;
          } else if (Array.isArray(item.content)) {
            content += item.content.map((part) => (
              applyCitationAnnotations(part.text || '', part.annotations, citationRegistry)
            )).join('');
          }
        } else if (isWebSearchResponseItem(item)) {
          rawSources.push(...(item.action?.sources || []));
        }
      }
    } else {
      if (response.output_text) content = response.output_text;
      else if (response.content) content = response.content;

      if (rawSources.length === 0 && response.web_search_call?.action?.sources) {
        rawSources.push(...response.web_search_call.action.sources);
      }
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
  const containersClient = openai as unknown as OpenAIContainersClient;

  const response = await containersClient.containers.files.content.retrieve(
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
  const responsesClient = openai as unknown as OpenAIResponsesClient;

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

    const response = await responsesClient.responses.create(payload);

    let title = '';
    if (response.output && Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'message') {
          if (typeof item.content === 'string') {
            title += item.content;
          } else if (Array.isArray(item.content)) {
            title += item.content.map(part => part.text || '').join('');
          }
        }
      }
    } else {
      if (response.output_text) title = response.output_text;
      else if (response.content) title = response.content;
    }

    return title?.replace(/^"|"$/g, '').trim() || 'New Chat';
  } catch (error) {
    console.warn('Failed to generate title:', error);
    return content.slice(0, 30) + (content.length > 30 ? '...' : '');
  }
};
