
import OpenAI from "openai";
import { ChatConfig, Message, OpenAIResponsesConfig, OpenAIResponsesInput, Source, ModelId } from "../types";

// System prompt restricted to citations only.
// We have removed instructions regarding <think> tags.
const CITATION_SYSTEM_PROMPT = `
CITATIONS: If you have access to web search or external knowledge, cite your sources using the Markdown format [Title](URL).
`;

export const generateResponse = async (
  messages: Message[], 
  config: ChatConfig,
  providedApiKey?: string,
  systemInstruction?: string
): Promise<{ content: string; thinking?: string; sources?: Source[]; thinkingDuration: number }> => {
  
  const apiKey = providedApiKey || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    throw new Error("OpenAI API Key is missing. Please set OPENAI_API_KEY in your environment or enter it in the settings.");
  }

  // Initialize OpenAI Client per request to support dynamic keys
  const openai = new OpenAI({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true, // Required for client-side usage
    maxRetries: 0,                 // Disable auto-retries to prevent duplicate API calls
    timeout: 60 * 60 * 1000        // 1 hour timeout for long-running reasoning requests
  });

  // Map internal messages to API input format
  const apiInput: OpenAIResponsesInput[] = messages.map(m => {
    // Separate images (which have base64 content) from other files
    const images = m.attachments?.filter(a => a.type.startsWith('image/') && a.content) || [];
    const otherAttachments = m.attachments?.filter(a => !a.type.startsWith('image/')) || [];
    
    // If no images are present, we use the simple string format (appending filenames of docs)
    if (images.length === 0) {
        return {
            role: m.role,
            content: m.content + (otherAttachments.length > 0 ? `\n\n[Attached Files: ${otherAttachments.map(a => a.name).join(', ')}]` : '')
        };
    }

    // Construct Multimodal Array
    const contentParts: any[] = [];
    
    // 1. Add Text
    if (m.content) {
        contentParts.push({ type: "input_text", text: m.content });
    }

    // 2. Add Images
    images.forEach(img => {
        contentParts.push({
            type: "input_image",
            image_url: img.content // Direct string for input_image type
        });
    });

    // 3. Add Other Attachments (Text note)
    if (otherAttachments.length > 0) {
        contentParts.push({ 
            type: "input_text", 
            text: `\n\n[Attached Files: ${otherAttachments.map(a => a.name).join(', ')}]` 
        });
    }

    return {
        role: m.role,
        content: contentParts
    };
  });

  // Prepend System Instruction if present
  const fullSystemInstruction = systemInstruction 
    ? `${CITATION_SYSTEM_PROMPT}\n\n${systemInstruction}`
    : CITATION_SYSTEM_PROMPT;

  apiInput.unshift({
    role: 'system',
    content: fullSystemInstruction
  });

  // Construct Tools Array
  const tools = [];
  
  if (config.tools.webSearch) {
    tools.push({
      "type": "web_search",
      "user_location": {
        "type": "approximate",
        "country": "US",
        "region": "NY",
        "city": "New York"
      },
      "search_context_size": "medium"
    });
  }

  if (config.tools.codeInterpreter) {
    tools.push({
      "type": "code_interpreter",
      "container": {
        "type": "auto",
        "file_ids": [] // In a full implementation, we'd upload files first and pass IDs here
      }
    });
  }

  // Construct the payload matching the prompt's experimental structure
  const payload: OpenAIResponsesConfig = {
    model: config.model,
    input: apiInput,
    tools: tools,
    store: true,
    include: [
      "code_interpreter_call.outputs",
      "web_search_call.action.sources"
    ]
  };

  // 1. Text Config (Verbosity) - Skip for O3
  if (config.model !== ModelId.GPT_O3) {
      payload.text = {
          format: { type: "text" },
          verbosity: config.textVerbosity
      };
  } else {
      // For o3, we might still need to specify format, but usually defaults to text.
      // If the API requires it without verbosity:
      payload.text = {
          format: { type: "text" }
      };
  }

  // 2. Reasoning Config
  if (config.reasoningEffort && config.reasoningEffort !== 'none') {
    payload.reasoning = {
      effort: config.reasoningEffort
    };
  } else if (config.model === ModelId.GPT_5_2 && config.reasoningEffort === 'none') {
     payload.reasoning = {
       effort: 'none'
     };
  }

  try {
    const startTime = Date.now();
    // We are casting to any because the SDK types installed might not have 'responses' yet
    const response = await (openai as any).responses.create(payload);
    const endTime = Date.now();
    const thinkingDuration = endTime - startTime;
    
    // We define thinking as undefined/empty because we are no longer extracting it.
    let thinking = "";
    let content = "";
    let sources: Source[] = [];

    // Parse the output array items
    if (response.output && Array.isArray(response.output)) {
        for (const item of response.output) {
            // We specifically ignore 'reasoning' type items now as requested.
            if (item.type === 'message') {
                if (typeof item.content === 'string') {
                    content += item.content;
                } else if (Array.isArray(item.content)) {
                    content += item.content.map((c: any) => c.text || "").join("");
                }
            } else if (item.type === 'web_search_call') {
                 if (item.action?.sources) {
                     const callSources = item.action.sources.map((s: any) => ({
                        title: s.title || new URL(s.uri || s.url).hostname,
                        url: s.uri || s.url
                     }));
                     sources.push(...callSources);
                 }
            }
        }
    } else {
        // Fallback for unexpected API structure
        if (response.output_text) content = response.output_text;
        else if (response.content) content = response.content;
        
        // Try to recover sources from legacy location if not found in output items
        if (sources.length === 0 && response.web_search_call?.action?.sources) {
            sources = response.web_search_call.action.sources.map((s: any) => ({
                title: s.title || new URL(s.uri || s.url).hostname,
                url: s.uri || s.url
            }));
        }
    }

    // 2. Format Content (Footnotes) & Fallback Source Extraction
    // Replace [Title](URL) with [[n]](URL) and collect sources
    const linkRegex = /\[([^\]]+?)\]\((https?:\/\/[^\)]+?)\)/g;
    const extractedSources: Source[] = [];
    let counter = 1;

    content = content.replace(linkRegex, (match, title, url) => {
         extractedSources.push({ title, url });
         // Return a markdown link where text is [n]
         return `[[${counter++}]](${url})`;
    });

    // Merge sources: Prioritize structured sources from API, but if text contains footnotes,
    // we use the extracted ones to match the footnote numbers [1], [2], etc.
    if (extractedSources.length > 0) {
        sources = extractedSources; 
    }

    return { content, thinking, sources, thinkingDuration };

  } catch (error: any) {
    console.error("OpenAI API Error:", error);
    throw new Error(error.message || "Failed to generate response");
  }
};

export const generateChatTitle = async (
  content: string, 
  providedApiKey?: string
): Promise<string> => {
  const apiKey = providedApiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey) return "New Chat";

  const openai = new OpenAI({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true 
  });

  try {
    // Using gpt-5-nano with the responses API structure
    const payload: OpenAIResponsesConfig = {
      model: ModelId.GPT_5_NANO,
      input: [
        { role: "system", content: "Summarize the following message into a short, concise title (max 5 words). Do not use quotes." },
        { role: "user", content: content || "Analysis request" }
      ],
      text: {
        format: { type: "text" },
        verbosity: "low"
      },
      reasoning: {
        effort: "minimal"
      },
      store: true
    };

    const response = await (openai as any).responses.create(payload);

    let title = "";
    // Parse response from the responses API
    if (response.output && Array.isArray(response.output)) {
        for (const item of response.output) {
            if (item.type === 'message') {
                if (typeof item.content === 'string') {
                    title += item.content;
                } else if (Array.isArray(item.content)) {
                    title += item.content.map((c: any) => c.text || "").join("");
                }
            }
        }
    } else {
        // Fallback
        if (response.output_text) title = response.output_text;
        else if (response.content) title = response.content;
    }

    return title?.replace(/^"|"$/g, '').trim() || "New Chat";
  } catch (error) {
    console.warn("Failed to generate title:", error);
    return content.slice(0, 30) + (content.length > 30 ? '...' : '');
  }
};