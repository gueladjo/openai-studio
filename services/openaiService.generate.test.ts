import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';
import { DEFAULT_CONFIG, ModelId, type Message } from '../types';
import { MAX_ATTACHMENT_BYTES } from '../utils/attachmentValidation';

const { createResponseMock } = vi.hoisted(() => ({
  createResponseMock: vi.fn()
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = {
      create: createResponseMock
    };
  }
}));

import { generateChatTitle, generateResponse } from './openaiService';

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

const createStream = (events: unknown[]) => ({
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
        delta: 'The answer is 42.'
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

describe('generateResponse context management', () => {
  beforeEach(() => {
    createResponseMock.mockReset();
  });

  it.each([
    ModelId.GPT_5_6_SOL,
    ModelId.GPT_5_6_TERRA,
    ModelId.GPT_5_5
  ])('enables server-side compaction without automatic truncation for %s', async (model) => {
    const compactionOutput = {
      id: 'cmp-1',
      type: 'compaction',
      encrypted_content: 'opaque-compaction-state'
    } as OpenAIResponse['output'][number];
    const completedResponse = createCompletedResponse([
      compactionOutput,
      messageOutput
    ]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));

    const result = await generateResponse(
      [userMessage],
      { ...DEFAULT_CONFIG, model },
      'compaction-key'
    );

    expect(createResponseMock).toHaveBeenCalledTimes(1);
    expect(createResponseMock.mock.calls[0][0]).toMatchObject({
      store: true,
      truncation: 'disabled',
      context_management: [{
        type: 'compaction',
        compact_threshold: 200_000
      }]
    });
    expect(result.content).toBe('The answer is 42.');
  });

  it.each([
    ModelId.GPT_5_MINI,
    ModelId.GPT_5_NANO,
    ModelId.GPT_O3
  ])('omits compaction for %s', async (model) => {
    const completedResponse = createCompletedResponse([messageOutput]);
    createResponseMock.mockResolvedValue(createStream([{
      type: 'response.completed',
      sequence_number: 1,
      response: completedResponse
    }]));

    await generateResponse(
      [userMessage],
      { ...DEFAULT_CONFIG, model },
      'no-compaction-key'
    );

    expect(createResponseMock).toHaveBeenCalledTimes(1);
    expect(createResponseMock.mock.calls[0][0].context_management).toBeUndefined();
    expect(createResponseMock.mock.calls[0][0].truncation).toBe('disabled');
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
      ['I cannot help '],
      ['with that request.']
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
      input_tokens_details: { cached_tokens: 2 },
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
        delta: partialText
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
      sources: [{ title: 'Partial source', url: sourceUrl }],
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
        delta: 'Visible partial output.'
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
        content: 'The earlier answer.',
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
      input: [{ role: 'user', content: 'Build on that answer.' }],
      truncation: 'disabled',
      context_management: [{
        type: 'compaction',
        compact_threshold: 200_000
      }]
    });
    expect(createResponseMock.mock.calls[1][0]).toMatchObject({
      input: [
        { role: 'user', content: 'Solve this problem.' },
        { role: 'assistant', content: 'The earlier answer.' },
        { role: 'user', content: 'Build on that answer.' }
      ],
      truncation: 'disabled',
      context_management: [{
        type: 'compaction',
        compact_threshold: 200_000
      }]
    });
    expect(createResponseMock.mock.calls[1][0].previous_response_id).toBeUndefined();
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
