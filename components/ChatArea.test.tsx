import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, MessageRow } from './ChatArea';
import { Message } from '../types';

const renderMarkdown = (markdown: string): string => renderToStaticMarkup(
  <ReactMarkdown components={markdownComponents}>{markdown}</ReactMarkdown>
);

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
