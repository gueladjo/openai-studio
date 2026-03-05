import { Session } from '../types';

const ATTACHMENT_PLACEHOLDER = '[Attachment omitted]';
const FALLBACK_FILENAME = 'conversation';
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

const hasVisibleMessageContent = (content: string): boolean => content.trim().length > 0;

export const formatConversationMarkdown = (session: Session): string => {
  const title = session.title.trim() || 'Untitled Chat';
  const sections: string[] = [`# ${title}`];

  session.messages.forEach((message) => {
    const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
    const body = hasVisibleMessageContent(message.content)
      ? message.content
      : message.attachments && message.attachments.length > 0
        ? ATTACHMENT_PLACEHOLDER
        : '';

    sections.push(`## ${roleLabel}`);
    sections.push(body);
  });

  return `${sections.join('\n\n').trimEnd()}\n`;
};

const sanitizeFilenameSegment = (title: string): string => {
  return title
    .trim()
    .replace(INVALID_FILENAME_CHARACTERS, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
};

export const buildConversationFilename = (title: string, date = new Date()): string => {
  const safeTitle = sanitizeFilenameSegment(title) || FALLBACK_FILENAME;
  const dateLabel = date.toISOString().slice(0, 10);

  return `${safeTitle}-${dateLabel}.md`;
};

export const downloadTextFile = (
  filename: string,
  content: string,
  mimeType = 'text/markdown;charset=utf-8'
): void => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
};
