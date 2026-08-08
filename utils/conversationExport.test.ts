import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Session } from '../types';
import {
  buildConversationFilename,
  formatConversationMarkdown
} from './conversationExport';

const createSession = (): Session => ({
  id: 'session-1',
  title: '  Project Notes  ',
  config: DEFAULT_CONFIG,
  lastModified: 1,
  messages: [
    {
      id: 'user-1',
      role: 'user',
      content: '',
      timestamp: 1,
      attachments: [{
        name: 'private.txt',
        type: 'text/plain',
        size: 14,
        content: 'data:text/plain;base64,c2VjcmV0IHBheWxvYWQ='
      }]
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Summary.',
      timestamp: 2
    }
  ]
});

describe('conversation Markdown export', () => {
  it('uses a placeholder without exporting attachment metadata or bytes', () => {
    const markdown = formatConversationMarkdown(createSession());

    expect(markdown).toBe(
      '# Project Notes\n\n'
      + '## User\n\n'
      + '[Attachment omitted]\n\n'
      + '## Assistant\n\n'
      + 'Summary.\n'
    );
    expect(markdown).not.toContain('private.txt');
    expect(markdown).not.toContain('c2VjcmV0IHBheWxvYWQ');
  });

  it('sanitizes filenames and supplies a fallback for punctuation-only titles', () => {
    const date = new Date('2026-07-24T12:00:00.000Z');

    expect(buildConversationFilename(
      '  ../Quarter: 1 / *Plan*?  ',
      date
    )).toBe('Quarter-1-Plan-2026-07-24.md');
    expect(buildConversationFilename('<>:"/\\|?*', date)).toBe(
      'conversation-2026-07-24.md'
    );
  });

  it('exports assistant progress and final answers as distinct messages', () => {
    const session = createSession();
    session.messages[1].content = 'Checking.\n\nSummary.';
    session.messages[1].outputMessages = [{
      content: 'Checking.',
      phase: 'commentary'
    }, {
      content: 'Summary.',
      phase: 'final_answer'
    }];

    expect(formatConversationMarkdown(session)).toContain(
      '## Assistant (Progress)\n\nChecking.\n\n'
      + '## Assistant (Final Answer)\n\nSummary.\n'
    );
  });
});
