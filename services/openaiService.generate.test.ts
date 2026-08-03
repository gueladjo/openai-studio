import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Response as OpenAIResponse,
  ResponseOutputText
} from 'openai/resources/responses/responses';
import {
  DEFAULT_CONFIG,
  ModelId,
  type GeneratedFile,
  type Message,
  type OpenAIResponsesStreamEvent
} from '../types';
import { MAX_ATTACHMENT_BYTES } from '../utils/attachmentValidation';

const {
  cancelBackgroundResponseMock,
  createResponseMock,
  openAIConstructorMock,
  retrieveContainerFileMock
} = vi.hoisted(() => ({
  cancelBackgroundResponseMock: vi.fn(),
  createResponseMock: vi.fn(),
  openAIConstructorMock: vi.fn(),
  retrieveContainerFileMock: vi.fn()
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(options: unknown) {
      openAIConstructorMock(options);
    }

    responses = {
      cancel: cancelBackgroundResponseMock,
      create: createResponseMock
    };

    containers = {
      files: {
        content: {
          retrieve: retrieveContainerFileMock
        }
      }
    };
  }
}));

import {
  cancelBackgroundResponse,
  fetchGeneratedFileContent,
  generateChatTitle,
  generateResponse
} from './openaiService';

const userMessage: Message = {
  id: 'user-1',
  role: 'user',
  content: 'Solve this problem.',
  timestamp: 1
};

const createCompletedResponse = (
  output: OpenAIResponse['output']
): OpenAIResponse => ({
  id: 'resp-1',
  output,
  output_text: 'The answer is 42.'
} as unknown as OpenAIResponse);

const createStream = (events: OpenAIResponsesStreamEvent[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
  }
});

const messageOutput = {
  id: 'msg-1',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{
    type: 'output_text',
    text: 'The answer is 42.',
    annotations: [],
    logprobs: []
  }]
} as OpenAIResponse['output'][number];

const createPhasedMessageOutput = (
  id: string,
  text: string,
  phase: 'commentary' | 'final_answer'
) => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  phase,
  content: [{
    type: 'output_text',
    text,
    annotations: [],
    logprobs: []
  }]
} as OpenAIResponse['output'][number]);

describe('OpenAI request contracts', () => {
  beforeEach(() => {
    cancelBackgroundResponseMock.mockReset();
    createResponseMock.mockReset();
    openAIConstructorMock.mockReset();
    retrieveContainerFileMock.mockReset();
  });

  it('builds the complete stored streaming payload for enabled tools', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([
      {
        type: 'response.created',
        sequence_number: 1,
        response: {
          ...createCompletedResponse([]),
          id: 'resp-created'
        }
      },
      {
        type: 'response.completed',
        sequence_number: 2,
        response: completedResponse
      }
    ]));
    await generateResponse(
      [userMessage],
      {
        ...DEFAULT_CONFIG,
        model: ModelId.GPT_5_6_SOL,
        reasoningEffort: 'max',
        textVerbosity: 'high',
        tools: {
          ...DEFAULT_CONFIG.tools,
          webSearch: true,
          codeInterpreter: true
        }
      },
      'request-contract-key',
      'Respond with concise examples.'
    );

    expect(openAIConstructorMock).toHaveBeenCalledWith({
      apiKey: 'request-contract-key',
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
      timeout: 60 * 60 * 1000
    });
    expect(createResponseMock.mock.calls[0][0]).toEqual({
      model: ModelId.GPT_5_6_SOL,
      input: [{ role: 'user', content: 'Solve this problem.' }],
      tools: [
        {
          type: 'web_search',
          user_location: {
            type: 'approximate',
            country: 'US',
            region: 'NY',
            city: 'New York'
          },
          search_context_size: 'medium'
        },
        {
          type: 'code_interpreter',
          container: { type: 'auto' }
        }
      ],
      tool_choice: 'auto',
      store: true,
      stream: true,
      include: [
        'code_interpreter_call.outputs',
        'web_search_call.action.sources'
      ],
      text: {
        format: { type: 'text' },
        verbosity: 'high'
      },
      instructions: (
        'You are GPT-5.6 Sol, an OpenAI model. '
        + 'Your knowledge cutoff is February 16, 2026.\n\n'
        + 'Respond with concise examples.'
      ),
      reasoning: {
        effort: 'max',
        summary: 'auto'
      }
    });
  });

  it('applies live project context with threaded history and parses file citations', async () => {
    const previousAssistant: Message = {
      id: 'assistant-previous',
      role: 'assistant',
      content: 'Earlier answer.',
      openaiResponseId: 'resp-previous',
      modelName: 'GPT-5.6 Sol',
      timestamp: 2
    };
    const nextUser: Message = {
      id: 'user-next',
      role: 'user',
      content: 'Use the project evidence.',
      timestamp: 3
    };
    const citedMessage = {
      ...messageOutput,
      content: [{
        type: 'output_text',
        text: 'The project says 42.',
        annotations: [{
          type: 'file_citation',
          file_id: 'file-search-source',
          filename: 'evidence.txt'
        }],
        logprobs: []
      }]
    } as unknown as OpenAIResponse['output'][number];
    const fileSearchCall = {
      id: 'search-1',
      type: 'file_search_call',
      status: 'completed',
      queries: ['answer'],
      results: null
    } as unknown as OpenAIResponse['output'][number];
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: createCompletedResponse([fileSearchCall, citedMessage])
    }]));

    const result = await generateResponse(
      [userMessage, previousAssistant, nextUser],
      {
        ...DEFAULT_CONFIG,
        tools: {
          ...DEFAULT_CONFIG.tools,
          webSearch: false,
          codeInterpreter: true
        }
      },
      'project-key',
      'This global instruction must be ignored.',
      {
        projectContext: {
          projectId: 'project-1',
          instructions: 'Use current project instructions.',
          vectorStoreId: 'vector-project-1',
          analysisFileIds: ['file-analysis-1'],
          sourceIdByFileId: {
            'file-search-source': 'source-1'
          }
        }
      }
    );

    expect(createResponseMock.mock.calls[0][0]).toMatchObject({
      input: [{ role: 'user', content: 'Use the project evidence.' }],
      previous_response_id: 'resp-previous',
      instructions: expect.stringContaining('Use current project instructions.'),
      tool_choice: 'auto',
      tools: [{
        type: 'file_search',
        vector_store_ids: ['vector-project-1'],
        max_num_results: 20
      }, {
        type: 'code_interpreter',
        container: {
          type: 'auto',
          file_ids: ['file-analysis-1']
        }
      }]
    });
    expect(createResponseMock.mock.calls[0][0].instructions)
      .not.toContain('global instruction');
    expect(result).toMatchObject({
      fileSearchCallCount: 1,
      sources: [{
        kind: 'file',
        filename: 'evidence.txt',
        fileId: 'file-search-source',
        projectSourceId: 'source-1'
      }]
    });
  });

  it('does not retry a rejected project File Search request without its context', async () => {
    const error = Object.assign(new Error('Vector store is unavailable.'), {
      status: 400,
      param: 'tools[0].vector_store_ids'
    });
    createResponseMock.mockRejectedValue(error);

    await expect(generateResponse(
      [userMessage],
      {
        ...DEFAULT_CONFIG,
        reasoningEffort: 'none',
        tools: { ...DEFAULT_CONFIG.tools, webSearch: false }
      },
      'project-key',
      undefined,
      {
        projectContext: {
          projectId: 'project-1',
          instructions: 'Project instructions.',
          vectorStoreId: 'vector-project-1',
          analysisFileIds: []
        }
      }
    )).rejects.toBe(error);

    expect(createResponseMock).toHaveBeenCalledTimes(1);
    expect(createResponseMock.mock.calls[0][0].tools).toEqual([{
      type: 'file_search',
      vector_store_ids: ['vector-project-1'],
      max_num_results: 20
    }]);
  });

  it('normalizes custom Web Search options and omits blank location fields', async () => {
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: createCompletedResponse([messageOutput])
    }]));

    await generateResponse(
      [userMessage],
      {
        ...DEFAULT_CONFIG,
        tools: {
          ...DEFAULT_CONFIG.tools,
          webSearchOptions: {
            searchContextSize: 'high',
            userLocation: {
              type: 'approximate',
              city: '   ',
              region: ' England  ',
              country: 'gb'
            }
          }
        }
      },
      'custom-search-key'
    );

    expect(createResponseMock.mock.calls[0][0].tools[0]).toEqual({
      type: 'web_search',
      search_context_size: 'high',
      user_location: {
        type: 'approximate',
        region: 'England',
        country: 'GB'
      }
    });
  });

  it('omits Web Search user location when it is cleared', async () => {
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: createCompletedResponse([messageOutput])
    }]));

    await generateResponse(
      [userMessage],
      {
        ...DEFAULT_CONFIG,
        tools: {
          ...DEFAULT_CONFIG.tools,
          webSearchOptions: {
            searchContextSize: 'low',
            userLocation: null
          }
        }
      },
      'no-location-key'
    );

    expect(createResponseMock.mock.calls[0][0].tools[0]).toEqual({
      type: 'web_search',
      search_context_size: 'low'
    });
  });

  it('normalizes unsupported options and omits verbosity for o3', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));

    await generateResponse(
      [userMessage],
      {
        ...DEFAULT_CONFIG,
        model: ModelId.GPT_O3,
        reasoningEffort: 'none',
        textVerbosity: 'high',
        tools: {
          ...DEFAULT_CONFIG.tools,
          webSearch: false,
          codeInterpreter: false
        }
      },
      'o3-contract-key'
    );

    expect(createResponseMock.mock.calls[0][0]).toMatchObject({
      model: ModelId.GPT_O3,
      tools: [],
      text: {
        format: { type: 'text' }
      },
      reasoning: {
        effort: 'medium',
        summary: 'auto'
      }
    });
    expect(createResponseMock.mock.calls[0][0].text).not.toHaveProperty(
      'verbosity'
    );
  });

  it('maps resolved images and documents to their SDK input parts once', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));
    const resolveAttachmentContent = vi.fn(async attachment => (
      attachment.type === 'image/png'
        ? 'data:image/png;base64,AA=='
        : 'data:application/pdf;base64,AA=='
    ));
    const message: Message = {
      ...userMessage,
      attachments: [
        {
          id: 'image-1',
          name: 'diagram.png',
          type: 'image/png',
          size: 1
        },
        {
          id: 'file-1',
          name: 'report.pdf',
          type: 'application/pdf',
          size: 1
        }
      ]
    };

    await generateResponse(
      [message],
      DEFAULT_CONFIG,
      'attachment-contract-key',
      undefined,
      { resolveAttachmentContent }
    );

    expect(resolveAttachmentContent.mock.calls.map(([attachment]) => (
      attachment.name
    ))).toEqual(['diagram.png', 'report.pdf']);
    expect(createResponseMock.mock.calls[0][0].input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Solve this problem.' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,AA==',
          detail: 'auto'
        },
        {
          type: 'input_file',
          filename: 'report.pdf',
          file_data: 'data:application/pdf;base64,AA=='
        }
      ]
    }]);
  });

  it('returns Code Interpreter output and deduplicated generated files', async () => {
    const generatedFileAnnotation = {
      type: 'container_file_citation',
      file_id: 'file-result',
      container_id: 'container-1',
      filename: '/mnt/data/result.csv',
      start_index: 0,
      end_index: 'The analysis is ready.'.length
    } satisfies ResponseOutputText.ContainerFileCitation;
    const annotatedMessage = {
      id: 'msg-generated-file',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: 'The analysis is ready.',
        annotations: [
          generatedFileAnnotation,
          { ...generatedFileAnnotation }
        ],
        logprobs: []
      }]
    } as unknown as OpenAIResponse['output'][number];
    const codeInterpreterOutput = {
      id: 'code-1',
      type: 'code_interpreter_call',
      status: 'completed',
      container_id: 'container-1',
      code: 'print("done")',
      outputs: [
        { type: 'logs', logs: 'done\n' },
        { type: 'image', url: 'https://example.com/chart.png' }
      ]
    } as unknown as OpenAIResponse['output'][number];
    const completedResponse = createCompletedResponse([
      annotatedMessage,
      codeInterpreterOutput
    ]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));

    const result = await generateResponse(
      [userMessage],
      {
        ...DEFAULT_CONFIG,
        tools: {
          ...DEFAULT_CONFIG.tools,
          webSearch: false,
          codeInterpreter: true
        }
      },
      'generated-file-key'
    );

    expect(result.content).toContain('The analysis is ready.');
    expect(result.content).toContain('**Code Interpreter**');
    expect(result.content).toContain('```python\nprint("done")\n```');
    expect(result.content).toContain('```output\ndone\n```');
    expect(result.content).toContain(
      '![Code Interpreter output 2](https://example.com/chart.png)'
    );
    expect(result.generatedFiles).toEqual([{
      filename: '/mnt/data/result.csv',
      fileId: 'file-result',
      containerId: 'container-1',
      displayName: 'result.csv',
      mimeType: 'text/csv',
      source: 'container_file_citation'
    }]);
  });

  it('uses the non-retrying background-cancellation and generated-file endpoints', async () => {
    cancelBackgroundResponseMock.mockResolvedValue(undefined);
    retrieveContainerFileMock.mockResolvedValue(
      new Response('generated bytes', { status: 200 })
    );
    const generatedFile: GeneratedFile = {
      filename: 'result.txt',
      fileId: 'file-result',
      containerId: 'container-1'
    };
    const controller = new AbortController();

    await cancelBackgroundResponse('resp-1', 'cancel-key');
    const blob = await fetchGeneratedFileContent(
      generatedFile,
      'download-key',
      { signal: controller.signal }
    );

    expect(openAIConstructorMock.mock.calls).toEqual([
      [{
        apiKey: 'cancel-key',
        dangerouslyAllowBrowser: true,
        maxRetries: 0
      }],
      [{
        apiKey: 'download-key',
        dangerouslyAllowBrowser: true
      }]
    ]);
    expect(cancelBackgroundResponseMock).toHaveBeenCalledWith('resp-1');
    expect(retrieveContainerFileMock).toHaveBeenCalledWith(
      'file-result',
      { container_id: 'container-1' },
      { signal: controller.signal }
    );
    expect(await blob.text()).toBe('generated bytes');
  });

  it('uses the fixed lightweight title-generation contract', async () => {
    createResponseMock.mockResolvedValue({
      output_text: 'Concise title'
    });

    await expect(generateChatTitle(
      'A long first message',
      'title-contract-key'
    )).resolves.toBe('Concise title');

    expect(openAIConstructorMock).toHaveBeenCalledWith({
      apiKey: 'title-contract-key',
      dangerouslyAllowBrowser: true
    });
    expect(createResponseMock.mock.calls[0][0]).toEqual({
      model: ModelId.GPT_5_NANO,
      instructions: (
        'Summarize the following message into a short, concise title '
        + '(max 5 words). Do not use quotes.'
      ),
      input: [{
        role: 'user',
        content: 'A long first message'
      }],
      text: {
        format: { type: 'text' },
        verbosity: 'low'
      },
      reasoning: {
        effort: 'minimal'
      },
      store: true
    });
  });

  it('rejects incomplete or unsuccessful generated-file downloads', async () => {
    await expect(fetchGeneratedFileContent(
      {
        filename: 'result.txt',
        fileId: '',
        containerId: 'container-1'
      },
      'download-key'
    )).rejects.toThrow('Generated file metadata is incomplete');
    expect(openAIConstructorMock).not.toHaveBeenCalled();

    retrieveContainerFileMock.mockResolvedValue(
      new Response('missing', { status: 404 })
    );
    await expect(fetchGeneratedFileContent(
      {
        filename: 'result.txt',
        fileId: 'file-missing',
        containerId: 'container-1'
      },
      'download-key'
    )).rejects.toThrow('Failed to download generated file (404)');
  });
});

describe('generateResponse reasoning summaries', () => {
  beforeEach(() => {
    createResponseMock.mockReset();
  });

  it('requests, streams, and returns a reasoning summary', async () => {
    const completedResponse = createCompletedResponse([
      {
        id: 'rs-1',
        type: 'reasoning',
        status: 'completed',
        summary: [{
          type: 'summary_text',
          text: 'Final reasoning summary.'
        }]
      },
      messageOutput
    ]);
    createResponseMock.mockResolvedValue(createStream([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs-1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 1,
        delta: 'Live reasoning '
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs-1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 2,
        delta: 'summary.'
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg-1',
        output_index: 1,
        content_index: 0,
        sequence_number: 3,
        delta: 'The answer is 42.',
        logprobs: []
      },
      {
        type: 'response.completed',
        sequence_number: 4,
        response: completedResponse
      }
    ]));
    const onReasoningSummaryDelta = vi.fn();

    const result = await generateResponse(
      [userMessage],
      DEFAULT_CONFIG,
      'summary-enabled-key',
      undefined,
      { onReasoningSummaryDelta }
    );

    expect(createResponseMock).toHaveBeenCalledTimes(1);
    expect(createResponseMock.mock.calls[0][0].reasoning).toEqual({
      effort: 'medium',
      summary: 'auto'
    });
    expect(onReasoningSummaryDelta.mock.calls).toEqual([
      ['Live reasoning '],
      ['summary.']
    ]);
    expect(result.thinking).toBe('Final reasoning summary.');
    expect(result.content).toBe('The answer is 42.');
  });

  it('retries without summaries when the API rejects that optional capability', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock
      .mockRejectedValueOnce(Object.assign(
        new Error('Your organization must be verified to use this feature.'),
        { status: 403 }
      ))
      .mockResolvedValueOnce(createStream([{
        type: 'response.completed',
        sequence_number: 1,
        response: completedResponse
      }]));

    const result = await generateResponse(
      [userMessage],
      DEFAULT_CONFIG,
      'summary-disabled-key'
    );

    expect(createResponseMock).toHaveBeenCalledTimes(2);
    expect(createResponseMock.mock.calls[0][0].reasoning.summary).toBe('auto');
    expect(createResponseMock.mock.calls[1][0].reasoning).toEqual({
      effort: 'medium'
    });
    expect(result.content).toBe('The answer is 42.');
    expect(result.thinking).toBe('');
  });

  it('does not request a summary when reasoning is disabled', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));

    await generateResponse(
      [userMessage],
      { ...DEFAULT_CONFIG, reasoningEffort: 'none' },
      'reasoning-disabled-key'
    );

    expect(createResponseMock).toHaveBeenCalledTimes(1);
    expect(createResponseMock.mock.calls[0][0].reasoning).toEqual({
      effort: 'none'
    });
  });

  it('does not retry unrelated API failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const apiError = Object.assign(
      new Error('Rate limit exceeded.'),
      {
        status: 429,
        code: 'rate_limit_exceeded',
        param: 'input',
        type: 'requests'
      }
    );
    createResponseMock.mockRejectedValue(apiError);

    await expect(generateResponse(
      [userMessage],
      DEFAULT_CONFIG,
      'rate-limited-key'
    )).rejects.toBe(apiError);
    expect(createResponseMock).toHaveBeenCalledTimes(1);
    expect(apiError.code).toBe('rate_limit_exceeded');
    consoleError.mockRestore();
  });

  it('preserves structured errors emitted by the response stream', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'error',
      code: 'rate_limit_exceeded',
      message: 'Rate limit exceeded.',
      param: 'input',
      sequence_number: 1
    }]));

    let caught: unknown;
    try {
      await generateResponse([userMessage], DEFAULT_CONFIG, 'rate-limited-key');
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      message: 'Rate limit exceeded.',
      code: 'rate_limit_exceeded',
      param: 'input'
    });
    consoleError.mockRestore();
  });
});

describe('generateChatTitle cancellation', () => {
  beforeEach(() => {
    createResponseMock.mockReset();
  });

  it('passes the operation abort signal to the title request', async () => {
    createResponseMock.mockResolvedValue({
      output_text: 'Concise title'
    });
    const controller = new AbortController();

    await expect(generateChatTitle(
      'A long first message',
      'title-key',
      { signal: controller.signal }
    )).resolves.toBe('Concise title');

    expect(createResponseMock.mock.calls[0][1]).toEqual({
      signal: controller.signal
    });
  });

  it('propagates cancellation instead of returning a stale fallback title', async () => {
    const abortError = new Error('Request aborted.');
    abortError.name = 'AbortError';
    createResponseMock.mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort();

    await expect(generateChatTitle(
      'A long first message',
      'title-key',
      { signal: controller.signal }
    )).rejects.toBe(abortError);
  });
});

describe('generateResponse terminal output', () => {
  beforeEach(() => {
    createResponseMock.mockReset();
  });

  it('streams and preserves refusal output', async () => {
    const refusal = 'I cannot help with that request.';
    const refusalOutput = {
      id: 'msg-refusal',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'refusal',
        refusal
      }]
    } as OpenAIResponse['output'][number];
    const completedResponse = createCompletedResponse([refusalOutput]);
    createResponseMock.mockResolvedValue(createStream([
      {
        type: 'response.refusal.delta',
        item_id: 'msg-refusal',
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        delta: 'I cannot help '
      },
      {
        type: 'response.refusal.delta',
        item_id: 'msg-refusal',
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
        delta: 'with that request.'
      },
      {
        type: 'response.completed',
        sequence_number: 3,
        response: completedResponse
      }
    ]));
    const onTextDelta = vi.fn();

    const result = await generateResponse(
      [userMessage],
      DEFAULT_CONFIG,
      'refusal-key',
      undefined,
      { onTextDelta }
    );

    expect(onTextDelta.mock.calls).toEqual([
      ['I cannot help ', 0, undefined],
      ['with that request.', 0, undefined]
    ]);
    expect(result).toMatchObject({
      content: refusal,
      refusal,
      status: 'complete'
    });
  });

  it('preserves incomplete status, reason, partial output, citations, and usage', async () => {
    const partialText = 'Partial answer.';
    const sourceUrl = 'https://example.com/partial';
    const usage = {
      input_tokens: 10,
      input_tokens_details: {
        cache_write_tokens: 0,
        cached_tokens: 2
      },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 15
    };
    const incompleteOutput = {
      id: 'msg-incomplete',
      type: 'message',
      role: 'assistant',
      status: 'incomplete',
      content: [{
        type: 'output_text',
        text: partialText,
        annotations: [{
          type: 'url_citation',
          start_index: 0,
          end_index: 'Partial answer'.length,
          title: 'Partial source',
          url: sourceUrl
        }],
        logprobs: []
      }]
    } as OpenAIResponse['output'][number];
    const incompleteResponse = {
      ...createCompletedResponse([incompleteOutput]),
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage
    } as OpenAIResponse;
    createResponseMock.mockResolvedValue(createStream([
      {
        type: 'response.output_text.delta',
        item_id: 'msg-incomplete',
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        delta: partialText,
        logprobs: []
      },
      {
        type: 'response.incomplete',
        sequence_number: 2,
        response: incompleteResponse
      }
    ]));

    const result = await generateResponse(
      [userMessage],
      DEFAULT_CONFIG,
      'incomplete-key'
    );

    expect(result).toMatchObject({
      content: `Partial answer[[1]](<${sourceUrl}>).`,
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
      sources: [{ kind: 'web', title: 'Partial source', url: sourceUrl }],
      usage,
      responseId: 'resp-1'
    });
  });

  it('retains streamed partial output when an incomplete response omits output items', async () => {
    const incompleteResponse = {
      ...createCompletedResponse([]),
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output_text: ''
    } as OpenAIResponse;
    createResponseMock.mockResolvedValue(createStream([
      {
        type: 'response.output_text.delta',
        item_id: 'msg-incomplete',
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        delta: 'Visible partial output.',
        logprobs: []
      },
      {
        type: 'response.incomplete',
        sequence_number: 2,
        response: incompleteResponse
      }
    ]));

    const result = await generateResponse(
      [userMessage],
      DEFAULT_CONFIG,
      'partial-key'
    );

    expect(result).toMatchObject({
      content: 'Visible partial output.',
      status: 'incomplete',
      incompleteReason: 'content_filter'
    });
  });
});

describe('generateResponse assistant phases', () => {
  beforeEach(() => {
    createResponseMock.mockReset();
  });

  it('preserves multiple terminal output messages and streams their phases', async () => {
    const commentaryOutput = createPhasedMessageOutput(
      'msg-commentary',
      'I will check the data.',
      'commentary'
    );
    const finalOutput = createPhasedMessageOutput(
      'msg-final',
      'The data is valid.',
      'final_answer'
    );
    const completedResponse = createCompletedResponse([
      commentaryOutput,
      finalOutput
    ]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.output_item.added',
      output_index: 0,
      sequence_number: 1,
      item: commentaryOutput
    }, {
      type: 'response.output_text.delta',
      item_id: 'msg-commentary',
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      delta: 'I will check the data.',
      logprobs: []
    }, {
      type: 'response.output_item.added',
      output_index: 1,
      sequence_number: 3,
      item: finalOutput
    }, {
      type: 'response.output_text.delta',
      item_id: 'msg-final',
      output_index: 1,
      content_index: 0,
      sequence_number: 4,
      delta: 'The data is valid.',
      logprobs: []
    }, {
      type: 'response.completed',
      sequence_number: 5,
      response: completedResponse
    }]));
    const onTextDelta = vi.fn();

    const result = await generateResponse(
      [userMessage],
      DEFAULT_CONFIG,
      'phase-key',
      undefined,
      { onTextDelta }
    );

    expect(onTextDelta.mock.calls).toEqual([
      ['I will check the data.', 0, 'commentary'],
      ['The data is valid.', 1, 'final_answer']
    ]);
    expect(result).toMatchObject({
      content: 'I will check the data.\n\nThe data is valid.',
      outputMessages: [{
        content: 'I will check the data.',
        phase: 'commentary'
      }, {
        content: 'The data is valid.',
        phase: 'final_answer'
      }]
    });
  });
});

describe('generateResponse conversation history', () => {
  beforeEach(() => {
    createResponseMock.mockReset();
  });

  it('does not replay local assistant error rows', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));
    const messages: Message[] = [
      userMessage,
      {
        id: 'assistant-error',
        role: 'assistant',
        content: 'Error: Rate limit exceeded.',
        status: 'error',
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Try a different approach.',
        timestamp: 3
      }
    ];

    await generateResponse(messages, DEFAULT_CONFIG, 'history-key');

    expect(createResponseMock.mock.calls[0][0].input).toEqual([
      { role: 'user', content: 'Solve this problem.' },
      { role: 'user', content: 'Try a different approach.' }
    ]);
  });

  it('does not replay attachments from a failed user turn', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));
    const resolveAttachmentContent = vi.fn();
    const messages: Message[] = [
      {
        ...userMessage,
        attachments: [{
          id: 'failed-file',
          name: 'failed.pdf',
          type: 'application/pdf',
          size: 1024
        }]
      },
      {
        id: 'assistant-error',
        role: 'assistant',
        content: 'Error: Invalid file.',
        status: 'error',
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Continue without that file.',
        timestamp: 3
      }
    ];

    await generateResponse(
      messages,
      DEFAULT_CONFIG,
      'history-key',
      undefined,
      { resolveAttachmentContent }
    );

    expect(resolveAttachmentContent).not.toHaveBeenCalled();
    expect(createResponseMock.mock.calls[0][0].input).toEqual([
      { role: 'user', content: 'Solve this problem.' },
      { role: 'user', content: 'Continue without that file.' }
    ]);
  });

  it('rejects invalid attachment metadata before content resolution or an API call', async () => {
    const resolveAttachmentContent = vi.fn();
    const oversizedMessage: Message = {
      ...userMessage,
      attachments: [{
        id: 'oversized-file',
        name: 'oversized.pdf',
        type: 'application/pdf',
        size: MAX_ATTACHMENT_BYTES
      }]
    };

    await expect(generateResponse(
      [oversizedMessage],
      DEFAULT_CONFIG,
      'history-key',
      undefined,
      { resolveAttachmentContent }
    )).rejects.toThrow('must be smaller than 50 MB');

    expect(resolveAttachmentContent).not.toHaveBeenCalled();
    expect(createResponseMock).not.toHaveBeenCalled();
  });

  it('enforces the combined attachment limit across full-history messages', async () => {
    const messages: Message[] = [
      {
        ...userMessage,
        attachments: [{
          id: 'first-file',
          name: 'first.pdf',
          type: 'application/pdf',
          size: 30 * 1024 * 1024
        }]
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'First answer.',
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Continue.',
        timestamp: 3,
        attachments: [{
          id: 'second-file',
          name: 'second.pdf',
          type: 'application/pdf',
          size: 20 * 1024 * 1024
        }]
      }
    ];

    await expect(generateResponse(
      messages,
      DEFAULT_CONFIG,
      'history-key',
      undefined,
      { resolveAttachmentContent: vi.fn() }
    )).rejects.toThrow('smaller than 50 MB combined');

    expect(createResponseMock).not.toHaveBeenCalled();
  });

  it('keeps stopped partial assistant output in local history', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));
    const messages: Message[] = [
      userMessage,
      {
        id: 'assistant-stopped',
        role: 'assistant',
        content: 'A useful partial answer.',
        status: 'stopped',
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Continue from there.',
        timestamp: 3
      }
    ];

    await generateResponse(messages, DEFAULT_CONFIG, 'history-key');

    expect(createResponseMock.mock.calls[0][0].input).toEqual([
      { role: 'user', content: 'Solve this problem.' },
      { role: 'assistant', content: 'A useful partial answer.' },
      { role: 'user', content: 'Continue from there.' }
    ]);
  });

  it('retries an unresolvable previous response once with full local history', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    const staleResponseError = Object.assign(
      new Error("Previous response with id 'resp-expired' not found."),
      {
        status: 404,
        code: 'previous_response_not_found',
        param: 'previous_response_id',
        type: 'invalid_request_error'
      }
    );
    createResponseMock
      .mockRejectedValueOnce(staleResponseError)
      .mockResolvedValueOnce(createStream([{
        type: 'response.completed',
        sequence_number: 1,
        response: completedResponse
      }]));
    const messages: Message[] = [
      userMessage,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Working on it.\n\nThe earlier answer.',
        outputMessages: [{
          content: 'Working on it.',
          phase: 'commentary'
        }, {
          content: 'The earlier answer.',
          phase: 'final_answer'
        }],
        status: 'complete',
        openaiResponseId: 'resp-expired',
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Build on that answer.',
        timestamp: 3
      }
    ];

    const result = await generateResponse(messages, DEFAULT_CONFIG, 'history-key');

    expect(result.content).toBe('The answer is 42.');
    expect(createResponseMock).toHaveBeenCalledTimes(2);
    expect(createResponseMock.mock.calls[0][0]).toMatchObject({
      previous_response_id: 'resp-expired',
      input: [{ role: 'user', content: 'Build on that answer.' }]
    });
    expect(createResponseMock.mock.calls[1][0].previous_response_id).toBeUndefined();
    expect(createResponseMock.mock.calls[1][0].input).toEqual([
      { role: 'user', content: 'Solve this problem.' },
      { role: 'assistant', content: 'Working on it.', phase: 'commentary' },
      { role: 'assistant', content: 'The earlier answer.', phase: 'final_answer' },
      { role: 'user', content: 'Build on that answer.' }
    ]);
  });

  it('round-trips phased assistant messages in ordinary manual history', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));
    const messages: Message[] = [
      userMessage,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Inspecting.\n\nFirst answer.',
        outputMessages: [{
          content: 'Inspecting.',
          phase: 'commentary'
        }, {
          content: 'First answer.',
          phase: 'final_answer'
        }],
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Continue.',
        timestamp: 3
      }
    ];

    await generateResponse(messages, DEFAULT_CONFIG, 'history-key');

    expect(createResponseMock.mock.calls[0][0].input).toEqual([
      { role: 'user', content: 'Solve this problem.' },
      { role: 'assistant', content: 'Inspecting.', phase: 'commentary' },
      { role: 'assistant', content: 'First answer.', phase: 'final_answer' },
      { role: 'user', content: 'Continue.' }
    ]);
  });

  it('recognizes a foreign response from a definite HTTP error message', async () => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock
      .mockRejectedValueOnce(Object.assign(
        new Error(
          "Previous response 'resp-foreign' is not accessible from this project."
        ),
        {
          status: 403,
          code: 'invalid_request_error',
          param: 'previous_response_id'
        }
      ))
      .mockResolvedValueOnce(createStream([{
        type: 'response.completed',
        sequence_number: 1,
        response: completedResponse
      }]));
    const messages: Message[] = [
      userMessage,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'The earlier answer.',
        openaiResponseId: 'resp-foreign',
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Continue.',
        timestamp: 3
      }
    ];

    await generateResponse(messages, DEFAULT_CONFIG, 'history-key');

    expect(createResponseMock).toHaveBeenCalledTimes(2);
    expect(createResponseMock.mock.calls[1][0].previous_response_id).toBeUndefined();
  });

  it('does not retry ambiguous previous_response_id validation failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const validationError = Object.assign(
      new Error('previous_response_id cannot be used with this request.'),
      {
        status: 400,
        code: 'invalid_request_error',
        param: 'previous_response_id'
      }
    );
    createResponseMock.mockRejectedValue(validationError);
    const messages: Message[] = [
      userMessage,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'The earlier answer.',
        openaiResponseId: 'resp-current',
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Continue.',
        timestamp: 3
      }
    ];

    await expect(generateResponse(
      messages,
      DEFAULT_CONFIG,
      'history-key'
    )).rejects.toBe(validationError);
    expect(createResponseMock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('attempts the full-history recovery only once', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const firstError = Object.assign(
      new Error('Previous response cannot be resolved.'),
      {
        status: 404,
        code: 'previous_response_not_found',
        param: 'previous_response_id'
      }
    );
    const fallbackError = Object.assign(
      new Error('Fallback request failed.'),
      {
        status: 500,
        code: 'server_error'
      }
    );
    createResponseMock
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(fallbackError);
    const messages: Message[] = [
      userMessage,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'The earlier answer.',
        openaiResponseId: 'resp-expired',
        timestamp: 2
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Continue.',
        timestamp: 3
      }
    ];

    await expect(generateResponse(
      messages,
      DEFAULT_CONFIG,
      'history-key'
    )).rejects.toBe(fallbackError);
    expect(createResponseMock).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
