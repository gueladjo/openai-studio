import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ReactMarkdown from 'react-markdown';
import {
  ContextWindowUsage,
  getResponseModelLabel,
  markdownComponents,
  MessageRow
} from './ChatArea';
import { DEFAULT_CONFIG, Message, ModelId, Session } from '../types';

const renderMarkdown = (markdown: string): string => renderToStaticMarkup(
  <ReactMarkdown components={markdownComponents}>{markdown}</ReactMarkdown>
);

const createSessionWithUsage = (
  model: ModelId,
  inputTokens?: number,
  outputTokens = 0
): Session => ({
  id: `session-${model}`,
  title: 'Context window test',
  messages: inputTokens === undefined ? [] : [{
    id: 'assistant-usage',
    role: 'assistant',
    content: 'Response',
    status: 'complete',
    timestamp: 1,
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: {
        cached_tokens: 0
      },
      output_tokens: outputTokens,
      output_tokens_details: {
        reasoning_tokens: 0
      },
      total_tokens: inputTokens + outputTokens
    }
  }],
  config: {
    ...DEFAULT_CONFIG,
    model
  },
  lastModified: 1
});

describe('ChatArea context window usage', () => {
  it('uses total response tokens and the selected model context window', () => {
    const solHtml = renderToStaticMarkup(
      <ContextWindowUsage session={createSessionWithUsage(ModelId.GPT_5_6_SOL, 200_000, 10_000)} />
    );
    const lunaHtml = renderToStaticMarkup(
      <ContextWindowUsage session={createSessionWithUsage(ModelId.GPT_5_6_LUNA, 150_000, 50_000)} />
    );
    const o3Html = renderToStaticMarkup(
      <ContextWindowUsage session={createSessionWithUsage(ModelId.GPT_O3, 150_000, 50_000)} />
    );

    expect(solHtml).toContain('20% used');
    expect(solHtml).toContain('· 210K / 1.05M');
    expect(lunaHtml).toContain('19% used');
    expect(lunaHtml).toContain('· 200K / 1.05M');
    expect(o3Html).toContain('100% used');
    expect(o3Html).toContain('· 200K / 200K');
  });

  it('shows an empty context window before the first completed request', () => {
    const html = renderToStaticMarkup(
      <ContextWindowUsage session={createSessionWithUsage(ModelId.GPT_5_NANO)} />
    );

    expect(html).toContain('0% used');
    expect(html).toContain('>Context</span>');
    expect(html).toContain('· 0 / 400K');
    expect(html).toContain('GPT-5 Nano has a 400,000 token context window.');
  });
});

describe('response model labels', () => {
  it('uses the name stored on the answer without resolving its model id', () => {
    expect(getResponseModelLabel({
      role: 'assistant',
      content: 'Historical answer',
      timestamp: 1,
      model: 'deleted-model',
      modelName: 'Historical Model',
      reasoningEffort: 'high'
    })).toBe('Historical Model high');
  });
});

describe('ChatArea markdown code rendering', () => {
  it('renders inline code inside its paragraph without a block card', () => {
    const html = renderMarkdown('Call `foo()` here.');

    expect(html).toContain('<p>Call <code');
    expect(html).toContain('>foo()</code> here.</p>');
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('>Code</div>');
  });

  it('renders fenced code as one labeled block', () => {
    const html = renderMarkdown('```js\nfoo();\n```');

    expect(html).toContain('>Js</div>');
    expect(html).toContain('<pre');
    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html).toContain('<code class="language-js">foo();');
  });
});

describe('ChatArea responsive message layout', () => {
  it('keeps user and assistant message rows shrinkable within the available width', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'A-very-long-unbroken-user-message-that-must-not-widen-the-conversation',
        timestamp: 1
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'A-very-long-unbroken-assistant-message-that-must-not-widen-the-conversation',
        timestamp: 2
      }
    ];

    const html = renderToStaticMarkup(
      <>
        {messages.map(message => (
          <MessageRow
            key={message.id}
            message={message}
            canRetry={false}
            canRegenerate={false}
            apiKey=""
            onRetryFailedMessage={() => undefined}
            onRegenerateResponse={() => undefined}
          />
        ))}
      </>
    );

    expect(html.match(/flex w-full min-w-0 gap-4 max-w-4xl/g)).toHaveLength(2);
    expect(html.match(/flex min-w-0 max-w-\[85%\] flex-col/g)).toHaveLength(2);
    expect(html.match(/class="message-content min-w-0 max-w-full/g)).toHaveLength(2);
  });
});

describe('ChatArea incomplete-response status', () => {
  it('shows output-limit and content-filter reasons without hiding partial output', () => {
    const messages: Message[] = [
      {
        id: 'assistant-output-limit',
        role: 'assistant',
        content: 'Partial output before the limit.',
        status: 'incomplete',
        incompleteReason: 'max_output_tokens',
        timestamp: 1
      },
      {
        id: 'assistant-content-filter',
        role: 'assistant',
        content: 'Allowed partial output.',
        status: 'incomplete',
        incompleteReason: 'content_filter',
        timestamp: 2
      }
    ];

    const html = renderToStaticMarkup(
      <>
        {messages.map(message => (
          <MessageRow
            key={message.id}
            message={message}
            canRetry={false}
            canRegenerate={false}
            apiKey=""
            onRetryFailedMessage={() => undefined}
            onRegenerateResponse={() => undefined}
          />
        ))}
      </>
    );

    expect(html).toContain('Partial output before the limit.');
    expect(html).toContain('Response incomplete: the output token limit was reached.');
    expect(html).toContain('Allowed partial output.');
    expect(html).toContain('Response incomplete: some output was filtered.');
  });
});

describe('ChatArea failed attachment controls', () => {
  it('lets a failed user turn remove or replace its attachments', () => {
    const message: Message = {
      id: 'user-with-failed-file',
      role: 'user',
      content: 'Analyze this.',
      timestamp: 1,
      attachments: [{
        id: 'attachment-1',
        name: 'report.pdf',
        type: 'application/pdf',
        size: 1024
      }]
    };

    const html = renderToStaticMarkup(
      <MessageRow
        message={message}
        canRetry={false}
        canRegenerate={false}
        canEditAttachments={true}
        apiKey=""
        onRetryFailedMessage={() => undefined}
        onRemoveFailedAttachment={() => undefined}
        onReplaceFailedAttachments={async () => undefined}
        onRegenerateResponse={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Remove report.pdf"');
    expect(html).toContain('Replace attachments');
    expect(html).toContain('accept="');
  });
});
