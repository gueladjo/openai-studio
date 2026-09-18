// @vitest-environment happy-dom

import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeValue, findButton, useReactView } from '../test/reactView';
import {
  AssistantMarkdown,
  ChatArea,
  ContextWindowUsage,
  getResponseModelLabel,
  MessageRow
} from './ChatArea';
import { DEFAULT_CONFIG, Message, ModelId, Session } from '../types';

const renderMarkdown = (markdown: string): string => renderToStaticMarkup(
  <AssistantMarkdown>{markdown}</AssistantMarkdown>
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
        cache_write_tokens: 0,
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

describe('response token usage details', () => {
  const view = useReactView();

  it('displays cache writes when reported by the API', async () => {
    const message: Message = {
      id: 'assistant-cache-write',
      role: 'assistant',
      content: 'Response',
      status: 'complete',
      timestamp: 1,
      usage: {
        input_tokens: 5_000,
        input_tokens_details: {
          cache_write_tokens: 1_234,
          cached_tokens: 567
        },
        output_tokens: 89,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 5_089
      }
    };

    const container = await view.render(
      <MessageRow
        message={message}
        canRetry={false}
        canRegenerate={false}
        apiKey=""
        onRetryFailedMessage={() => undefined}
        onRegenerateResponse={() => undefined}
      />
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Show response details"]'
      )?.click();
    });

    const cacheWriteLabel = Array.from(container.querySelectorAll('span'))
      .find(element => element.textContent === 'Cache write');
    expect(cacheWriteLabel?.parentElement?.textContent).toBe('Cache write1,234');
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

  it('renders bracket-delimited TeX, including a currency dollar sign', () => {
    const html = renderMarkdown(
      String.raw`\[ 8{,}100 \times \max(\text{NVDA price}-$170,0) \]`
    );

    expect(html).toContain('class="katex-display"');
    expect(html).toContain('8,100');
    expect(html).toContain('NVDA price');
    expect(html).toContain('$170');
    expect(html).not.toContain('\\[');
  });

  it('renders parenthesis- and dollar-delimited inline TeX', () => {
    const html = renderMarkdown(String.raw`Use \(x^2\) or $y^2$.`);

    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain('<p>Use ');
  });

  it('does not treat currency amounts and intervening Markdown as TeX', () => {
    const html = renderMarkdown(
      'Your **2,040 NFLX employee options** have approximately ' +
      '**$20,769 of intrinsic value**, calculated grant by grant at ' +
      'NFLX’s $78.25 quote.'
    );

    expect(html).not.toContain('class="katex"');
    expect(html).toContain('<strong>$20,769 of intrinsic value</strong>');
    expect(html).toContain('NFLX’s $78.25 quote.');
  });

  it('renders numeric-leading display math without escaping its delimiters', () => {
    const html = renderMarkdown('The answer is $$5x$$ here, but $5 is money.');

    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
    expect(html).toContain('$5 is money.');
  });

  it('opens only absolute web links in a new tab', () => {
    const html = renderMarkdown(
      'See [docs](https://example.com/docs) and a note[^1].\n\n[^1]: The note.'
    );
    const externalLink = html.match(/<a [^>]*href="https:\/\/example.com\/docs"[^>]*>/)?.[0];
    const footnoteLink = html.match(/<a [^>]*href="#user-content-fn-1"[^>]*>/)?.[0];

    expect(externalLink).toContain('target="_blank"');
    expect(externalLink).toContain('rel="noopener noreferrer"');
    expect(footnoteLink).toBeDefined();
    expect(footnoteLink).not.toContain('target=');
  });

  it('renders links with unsafe protocols as plain text', () => {
    const html = renderMarkdown('[run](javascript:alert(1))');

    expect(html).not.toContain('<a ');
    expect(html).toContain('<span class="text-accent underline');
    expect(html).toContain('run</span>');
  });

  it('does not interpret TeX delimiters inside Markdown code', () => {
    const html = renderMarkdown(
      'Keep `\\(x\\)` and:\n\n```text\n\\[y\\]\n```'
    );

    expect(html).not.toContain('class="katex"');
    expect(html).toContain('\\(x\\)');
    expect(html).toContain('\\[y\\]');
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

    expect(html.match(/flex w-full min-w-0 flex-col items-end/g)).toHaveLength(1);
    expect(html.match(/flex w-full min-w-0 flex-col items-start/g)).toHaveLength(1);
    expect(html.match(/class="message-content min-w-0 max-w-\[85%\]/g)).toHaveLength(1);
    expect(html.match(/class="message-content min-w-0 max-w-full/g)).toHaveLength(1);
  });
});

describe('ChatArea conversation header', () => {
  const renderChat = (project?: { name: string; icon: 'health' }): string => (
    renderToStaticMarkup(
      <ChatArea
        session={createSessionWithUsage(ModelId.GPT_5_NANO)}
        availableSessionIds={['session-gpt-5-nano']}
        onSendMessage={async () => true}
        onStopGenerating={() => undefined}
        onRetryFailedMessage={() => undefined}
        onRemoveFailedAttachment={() => undefined}
        onReplaceFailedAttachments={async () => undefined}
        onRegenerateResponse={() => undefined}
        onShareConversation={() => undefined}
        apiKey=""
        isLoading={false}
        project={project}
      />
    )
  );

  it('shows a project icon and breadcrumb while leaving standalone titles unchanged', () => {
    const projectHtml = renderChat({ name: 'Health', icon: 'health' });
    expect(projectHtml).toContain('lucide-stethoscope');
    expect(projectHtml).toContain('>Health</span>');
    expect(projectHtml).toContain('>Context window test</h2>');

    const standaloneHtml = renderChat();
    expect(standaloneHtml).not.toContain('lucide-stethoscope');
    expect(standaloneHtml).not.toContain('>Health</span>');
    expect(standaloneHtml).toContain('>Context window test</h2>');
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

describe('ChatArea assistant phases', () => {
  const view = useReactView();

  it('renders final output as primary content and commentary as collapsible progress', async () => {
    const message: Message = {
      id: 'assistant-phases',
      role: 'assistant',
      content: 'Checking sources.\n\nFinal result.',
      outputMessages: [{
        content: 'Checking sources.',
        phase: 'commentary'
      }, {
        content: 'Final result.',
        phase: 'final_answer'
      }],
      status: 'complete',
      timestamp: 1
    };

    const container = await view.render(
      <MessageRow
        message={message}
        canRetry={false}
        canRegenerate={false}
        apiKey=""
        onRetryFailedMessage={() => undefined}
        onRegenerateResponse={() => undefined}
      />
    );

    expect(container.querySelector('.message-content')?.textContent).toBe(
      'Final result.'
    );
    expect(container.textContent).not.toContain('Checking sources.');
    const progressButton = findButton(container, 'Progress');
    expect(progressButton?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      progressButton?.click();
    });

    expect(progressButton?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Checking sources.');
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

describe('ChatArea composer', () => {
  const view = useReactView();

  const renderComposer = async ({
    onSendMessage = vi.fn(async () => true),
    strictMode = false
  }: {
    onSendMessage?: (sessionId: string, content: string, attachments: File[]) => Promise<boolean>;
    strictMode?: boolean;
  } = {}) => {
    const element = (
      <ChatArea
        session={createSessionWithUsage(ModelId.GPT_5_NANO)}
        availableSessionIds={['session-gpt-5-nano']}
        onSendMessage={onSendMessage}
        onStopGenerating={() => undefined}
        onRetryFailedMessage={() => undefined}
        onRemoveFailedAttachment={() => undefined}
        onReplaceFailedAttachments={async () => undefined}
        onRegenerateResponse={() => undefined}
        onShareConversation={() => undefined}
        apiKey=""
        isLoading={false}
      />
    );
    return view.render(strictMode ? <React.StrictMode>{element}</React.StrictMode> : element);
  };

  const pressEnter = async (target: Element, init: KeyboardEventInit = {}) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...init
      }));
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ignores Enter while an IME composition is in progress', async () => {
    const onSendMessage = vi.fn(async () => true);
    const container = await renderComposer({ onSendMessage });
    const textarea = container.querySelector('textarea')!;

    await changeValue(textarea, 'こんにちは');
    await pressEnter(textarea, { isComposing: true });
    expect(onSendMessage).not.toHaveBeenCalled();

    await pressEnter(textarea);
    expect(onSendMessage).toHaveBeenCalledWith('session-gpt-5-nano', 'こんにちは', []);
  });

  it('shows a live preview URL for image drafts under StrictMode', async () => {
    let nextUrl = 0;
    const revoked = new Set<string>();
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: vi.fn(() => `blob:preview-${nextUrl += 1}`),
      revokeObjectURL: vi.fn((url: string) => { revoked.add(url); })
    }));
    const container = await renderComposer({ strictMode: true });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [image], configurable: true });

    // The picker records the target session before the change event lands.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!.click();
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const preview = container.querySelector<HTMLImageElement>('img[alt="photo.png"]')!;
    expect(preview.getAttribute('src')).toMatch(/^blob:preview-/);
    expect(revoked.has(preview.getAttribute('src')!)).toBe(false);
  });
});
