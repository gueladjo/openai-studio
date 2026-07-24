import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';
import { DEFAULT_CONFIG, type Message } from '../types';

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

import { generateResponse } from './openaiService';

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
      input: [{ role: 'user', content: 'Build on that answer.' }]
    });
    expect(createResponseMock.mock.calls[1][0].previous_response_id).toBeUndefined();
    expect(createResponseMock.mock.calls[1][0].input).toEqual([
      { role: 'user', content: 'Solve this problem.' },
      { role: 'assistant', content: 'The earlier answer.' },
      { role: 'user', content: 'Build on that answer.' }
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
