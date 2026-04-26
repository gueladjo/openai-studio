
import OpenAI from 'openai';
import { getModelConfig, normalizeChatConfig } from '../constants';
import {
  ChatConfig,
  Message,
  ModelId,
  OpenAIResponsesConfig,
  OpenAIResponsesContentPart,
  OpenAIResponsesInput,
  Source
} from '../types';
import { createSourceRecord } from '../utils/sourceUrls';

// System prompt restricted to citations only.
// We have removed instructions regarding <think> tags.
const CITATION_SYSTEM_PROMPT = `
CITATIONS: If you have access to web search or external knowledge, cite your sources using the Markdown format [Title](URL).
`;

interface OpenAIResponseSource {
  title?: string;
  uri?: string;
  url?: string;
}

interface OpenAIResponseMessageItem {
  type: 'message';
  content?: string | Array<{ text?: string }>;
}

interface OpenAIResponseWebSearchItem {
  type: 'web_search_call';
  action?: {
    sources?: OpenAIResponseSource[];
  };
}

type OpenAIResponseOutputItem =
  | OpenAIResponseMessageItem
  | OpenAIResponseWebSearchItem
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

interface GenerateResponseResult {
  content: string;
  thinking?: string;
  sources?: Source[];
  thinkingDuration: number;
  responseId?: string;
}

const isWebSearchResponseItem = (
  item: OpenAIResponseOutputItem
): item is OpenAIResponseWebSearchItem => item.type === 'web_search_call';

const mapSources = (sources: OpenAIResponseSource[] = []): Source[] => {
  return sources
    .map((source, index) =>
      createSourceRecord(
        source.title,
        source.uri || source.url,
        `OpenAI response source #${index + 1}`
      )
    )
    .filter((source): source is Source => source !== null);
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
  // immediately before the newest user turn.
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

  const fullSystemInstruction = systemInstruction
    ? `${CITATION_SYSTEM_PROMPT}\n\n${systemInstruction}`
    : CITATION_SYSTEM_PROMPT;

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
        type: 'auto',
        file_ids: []
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
    instructions: fullSystemInstruction,
    tools: tools,
    store: true,
    include: [
      'code_interpreter_call.outputs',
      'web_search_call.action.sources'
    ],
    text: textConfig
  };

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

    if (response.output && Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'message') {
          if (typeof item.content === 'string') {
            content += item.content;
          } else if (Array.isArray(item.content)) {
            content += item.content.map(part => part.text || '').join('');
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

    let sources = mapSources(rawSources);

    const linkRegex = /\[([^\]]+?)\]\((https?:\/\/[^\)]+?)\)/g;
    const extractedSources: Source[] = [];
    let counter = 1;

    content = content.replace(linkRegex, (match, title, url) => {
      const extractedSource = createSourceRecord(
        title,
        url,
        `Assistant citation #${counter}`
      );

      if (extractedSource) {
        extractedSources.push(extractedSource);
      }

      return `[[${counter++}]](${url.trim()})`;
    });

    if (extractedSources.length > 0) {
      sources = extractedSources;
    }

    return { content, thinking, sources, thinkingDuration, responseId: response.id };
  } catch (error: unknown) {
    console.error('OpenAI API Error:', error);
    throw new Error(error instanceof Error ? error.message : 'Failed to generate response');
  }
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
      input: [
        { role: 'system', content: 'Summarize the following message into a short, concise title (max 5 words). Do not use quotes.' },
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
