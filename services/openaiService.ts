
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

const isWebSearchResponseItem = (
  item: OpenAIResponseOutputItem
): item is OpenAIResponseWebSearchItem => item.type === 'web_search_call';

const mapSources = (sources: OpenAIResponseSource[] = []): Source[] => {
  return sources
    .map(source => {
      const url = source.uri || source.url;
      if (!url) return null;

      return {
        title: source.title || new URL(url).hostname,
        url
      };
    })
    .filter((source): source is Source => source !== null);
};

export const generateResponse = async (
  messages: Message[],
  config: ChatConfig,
  providedApiKey?: string,
  systemInstruction?: string
): Promise<{ content: string; thinking?: string; sources?: Source[]; thinkingDuration: number }> => {
  const apiKey = providedApiKey || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    throw new Error('OpenAI API Key is missing. Please set OPENAI_API_KEY in your environment or enter it in the settings.');
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

  // Map internal messages to API input format
  const apiInput: OpenAIResponsesInput[] = messages.map(m => {
    const images = m.attachments?.filter(a => a.type.startsWith('image/') && a.content) || [];
    const otherAttachments = m.attachments?.filter(a => !a.type.startsWith('image/')) || [];

    if (images.length === 0) {
      return {
        role: m.role,
        content: m.content + (otherAttachments.length > 0 ? `\n\n[Attached Files: ${otherAttachments.map(a => a.name).join(', ')}]` : '')
      };
    }

    const contentParts: OpenAIResponsesContentPart[] = [];

    if (m.content) {
      contentParts.push({ type: 'input_text', text: m.content });
    }

    images.forEach(img => {
      contentParts.push({
        type: 'input_image',
        image_url: img.content as string
      });
    });

    if (otherAttachments.length > 0) {
      contentParts.push({
        type: 'input_text',
        text: `\n\n[Attached Files: ${otherAttachments.map(a => a.name).join(', ')}]`
      });
    }

    return {
      role: m.role,
      content: contentParts
    };
  });

  const fullSystemInstruction = systemInstruction
    ? `${CITATION_SYSTEM_PROMPT}\n\n${systemInstruction}`
    : CITATION_SYSTEM_PROMPT;

  apiInput.unshift({
    role: 'system',
    content: fullSystemInstruction
  });

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
    tools: tools,
    store: true,
    include: [
      'code_interpreter_call.outputs',
      'web_search_call.action.sources'
    ],
    text: textConfig
  };

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
    let sources: Source[] = [];

    if (response.output && Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'message') {
          if (typeof item.content === 'string') {
            content += item.content;
          } else if (Array.isArray(item.content)) {
            content += item.content.map(part => part.text || '').join('');
          }
        } else if (isWebSearchResponseItem(item)) {
          sources.push(...mapSources(item.action?.sources));
        }
      }
    } else {
      if (response.output_text) content = response.output_text;
      else if (response.content) content = response.content;

      if (sources.length === 0 && response.web_search_call?.action?.sources) {
        sources = mapSources(response.web_search_call.action.sources);
      }
    }

    const linkRegex = /\[([^\]]+?)\]\((https?:\/\/[^\)]+?)\)/g;
    const extractedSources: Source[] = [];
    let counter = 1;

    content = content.replace(linkRegex, (match, title, url) => {
      extractedSources.push({ title, url });
      return `[[${counter++}]](${url})`;
    });

    if (extractedSources.length > 0) {
      sources = extractedSources;
    }

    return { content, thinking, sources, thinkingDuration };
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
