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
    createResponseMock.mockRejectedValue(Object.assign(
      new Error('Rate limit exceeded.'),
      { status: 429 }
    ));

    await expect(generateResponse(
      [userMessage],
      DEFAULT_CONFIG,
      'rate-limited-key'
    )).rejects.toThrow('Rate limit exceeded.');
    expect(createResponseMock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
