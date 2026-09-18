import React, {
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useState
} from 'react';
import { GeneratedFile, Message, Project, ProjectSource, Session, Source } from '../types';
import {
  AlertCircle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Globe,
  Hash,
  Info,
  Paperclip,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Upload,
  X
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { getModelConfig } from '../constants';
import { getSourcePresentation } from '../utils/sourceUrls';
import {
  ATTACHMENT_INPUT_ACCEPT,
  isSupportedImageAttachment,
  validateAttachments
} from '../utils/attachmentValidation';
import {
  chatDraftsReducer,
  getChatDraft
} from '../utils/chatDrafts';
import {
  registerFileDialogFocusRecovery,
  restoreFocusAfterFileDialog
} from '../utils/focusRecovery';
import { ProjectIconGlyph } from './ProjectIcon';
import { normalizeMarkdownMath } from '../utils/markdownMath';
import { downloadBlobFile, stripInvalidFilenameCharacters } from '../utils/conversationExport';
import {
  BrandMark,
  Button,
  Callout,
  IconButton,
  SidebarControls,
  ViewHeader,
  cx,
  formatCompactCount,
  useDismiss
} from './ui';

interface ChatAreaProps {
  session: Session | null;
  availableSessionIds: string[];
  onSendMessage: (
    sessionId: string,
    content: string,
    attachments: File[]
  ) => Promise<boolean>;
  onStopGenerating: () => void;
  onRetryFailedMessage: (assistantMessageId: string) => void;
  onRemoveFailedAttachment: (userMessageId: string, attachmentIndex: number) => void;
  onReplaceFailedAttachments: (
    userMessageId: string,
    attachments: File[]
  ) => Promise<string | undefined>;
  onRegenerateResponse: () => void;
  onShareConversation: () => void;
  onDownloadGeneratedFile?: (file: GeneratedFile) => Promise<Blob>;
  apiKey: string;
  isLoading: boolean;
  readOnly?: boolean;
  projectSources?: ProjectSource[];
  onLoadProjectSource?: (source: ProjectSource) => Promise<File>;
  project?: Pick<Project, 'name' | 'icon'>;
  onOpenSidebar?: () => void;
  onToggleSidebar?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleConfig?: () => void;
  isConfigOpen?: boolean;
  onNewSession?: () => void;
  onNewProject?: () => void;
}

const AUTO_SCROLL_THRESHOLD_PX = 120;
const PROMPT_INPUT_MIN_HEIGHT_PX = 44;
const PROMPT_INPUT_MAX_HEIGHT_PX = 220;

const resizePromptTextarea = (textarea: HTMLTextAreaElement): void => {
  textarea.style.height = `${PROMPT_INPUT_MIN_HEIGHT_PX}px`;
  textarea.style.height = `${Math.min(
    Math.max(textarea.scrollHeight, PROMPT_INPUT_MIN_HEIGHT_PX),
    PROMPT_INPUT_MAX_HEIGHT_PX
  )}px`;
};

const DraftImagePreview: React.FC<{ file: File }> = ({ file }) => {
  // Created and revoked in the same effect so StrictMode's mount/unmount/mount
  // cycle cannot leave the rendered image pointing at a revoked URL.
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => {
      setImageUrl(current => (current === url ? undefined : current));
      URL.revokeObjectURL(url);
    };
  }, [file]);

  return (
    <img
      src={imageUrl}
      alt={file.name}
      className="h-16 w-16 rounded-lg border border-line object-cover"
    />
  );
};

const formatDuration = (ms: number): string => {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
};

const formatTokenCount = (tokens: number): string => tokens.toLocaleString();

const getLatestContextTokenUsage = (messages: Message[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const totalTokens = messages[index].usage?.total_tokens;
    if (typeof totalTokens === 'number' && Number.isFinite(totalTokens)) {
      return Math.max(0, totalTokens);
    }
  }

  return 0;
};

const MODEL_SUMMARY_CLASS =
  'flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left text-[11px] text-ink-3';

const ModelSummary = ({
  modelName,
  reasoningEffort,
  enabledTools
}: {
  modelName: string;
  reasoningEffort: string;
  enabledTools: string[];
}) => (
  <>
    <SlidersHorizontal size={12} aria-hidden="true" className="shrink-0" />
    <span className="truncate font-medium text-ink-2">{modelName}</span>
    <span className="shrink-0 capitalize">· {reasoningEffort}</span>
    {enabledTools.length > 0 && (
      <span className="hidden truncate sm:inline">· {enabledTools.join(', ')}</span>
    )}
  </>
);

export const ContextWindowUsage: React.FC<{ session: Session }> = ({ session }) => {
  const modelConfig = getModelConfig(session.config.model);
  const contextTokens = getLatestContextTokenUsage(session.messages);
  const usedPercentage = Math.min(
    100,
    (contextTokens / modelConfig.contextWindowTokens) * 100
  );
  const roundedPercentage = Math.round(usedPercentage);
  const percentageLabel = contextTokens > 0 && usedPercentage < 1
    ? '<1%'
    : `${roundedPercentage}%`;
  const compactTokenUsage = `${formatCompactCount(contextTokens)} / ${formatCompactCount(modelConfig.contextWindowTokens)}`;
  const description = contextTokens > 0
    ? `${formatTokenCount(contextTokens)} of ${formatTokenCount(modelConfig.contextWindowTokens)} tokens used through the latest completed response with ${modelConfig.name}.`
    : `No completed request yet. ${modelConfig.name} has a ${formatTokenCount(modelConfig.contextWindowTokens)} token context window.`;

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 text-[10px] text-ink-3"
      title={description}
    >
      <span>Context</span>
      <div
        className="h-1 w-16 overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-label="Context usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPercentage}
        aria-valuetext={`${percentageLabel} used`}
      >
        <div
          className={cx(
            'h-full rounded-full transition-[width] duration-300',
            usedPercentage > 90 ? 'bg-danger' : 'bg-accent'
          )}
          style={{ width: `${usedPercentage}%` }}
        />
      </div>
      <span className="tabular-nums">{percentageLabel} used</span>
      <span className="hidden tabular-nums sm:inline">· {compactTokenUsage}</span>
    </div>
  );
};

const formatMessageTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const timeLabel = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);

  if (date.toDateString() === now.toDateString()) {
    return `Today, ${timeLabel}`;
  }

  const dateLabel = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {})
  }).format(date);

  return `${dateLabel}, ${timeLabel}`;
};

const getIncompleteResponseMessage = (
  reason: Message['incompleteReason']
): string => {
  if (reason === 'max_output_tokens') {
    return 'Response incomplete: the output token limit was reached.';
  }
  if (reason === 'content_filter') {
    return 'Response incomplete: some output was filtered.';
  }
  return 'Response incomplete.';
};

const getCodeBlockLabel = (className?: string): string => {
  const language = className?.match(/language-(\S+)/)?.[1];

  if (!language) return 'Code';

  return language
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const copyTextWithExecCommandFallback = (text: string): void => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const existingRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const didCopy = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (selection) {
    selection.removeAllRanges();
    if (existingRange) {
      selection.addRange(existingRange);
    }
  }

  if (!didCopy) {
    throw new Error('Copy command was unsuccessful.');
  }
};

const copyTextToClipboard = async (text: string): Promise<void> => {
  const clipboardWriters: Array<() => Promise<void>> = [
    async () => {
      if (!window.electronAPI?.writeClipboardText) {
        throw new Error('Electron clipboard API is unavailable.');
      }
      await window.electronAPI.writeClipboardText(text);
    },
    async () => {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Navigator clipboard API is unavailable.');
      }
      await navigator.clipboard.writeText(text);
    },
    async () => {
      copyTextWithExecCommandFallback(text);
    }
  ];

  let lastError: unknown;

  for (const writeClipboardText of clipboardWriters) {
    try {
      await writeClipboardText();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Unable to copy response.');
};

const formatThinkingLabel = (ms?: number): string => {
  if (typeof ms !== 'number' || ms <= 0) return 'Thought process';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `Thought for ${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Thought for ${minutes}m ${seconds}s`;
};

const DISCLOSURE_TONES = {
  muted: {
    button: 'text-ink-3 hover:text-ink',
    body: 'border-line'
  },
  accent: {
    button: 'text-accent hover:text-accent-hover',
    body: 'border-accent/40'
  }
};

// Collapsible Markdown section; `collapseWhen` closes it once streaming ends.
const DisclosureBlock = ({
  label,
  text,
  tone,
  defaultOpen = false,
  collapseWhen = false
}: {
  label: string;
  text: string;
  tone: keyof typeof DISCLOSURE_TONES;
  defaultOpen?: boolean;
  collapseWhen?: boolean;
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (collapseWhen) setIsOpen(false);
  }, [collapseWhen]);

  if (!text) return null;

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className={cx(
          'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md py-0.5 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          DISCLOSURE_TONES[tone].button
        )}
      >
        <span>{label}</span>
        {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {isOpen && (
        <div className={cx(
          'markdown-content mt-1.5 min-w-0 max-w-full border-l-2 pl-3 text-sm text-ink-2',
          DISCLOSURE_TONES[tone].body
        )}>
          <AssistantMarkdown>{text}</AssistantMarkdown>
        </div>
      )}
    </div>
  );
};

const ThinkingBlock = ({ text, durationMs }: { text: string; durationMs?: number }) => (
  <DisclosureBlock label={formatThinkingLabel(durationMs)} text={text} tone="muted" />
);

const getAssistantContentPresentation = (message: Message): {
  commentary: string;
  primary: string;
} => {
  if (message.role !== 'assistant' || !message.outputMessages?.length) {
    return { commentary: '', primary: message.content };
  }

  const joinOutputs = (phase: 'commentary' | 'primary') => (
    message.outputMessages
      ?.filter(output => (
        phase === 'commentary'
          ? output.phase === 'commentary'
          : output.phase !== 'commentary'
      ))
      .map(output => output.content.trim())
      .filter(Boolean)
      .join('\n\n') || ''
  );

  return {
    commentary: joinOutputs('commentary'),
    primary: joinOutputs('primary')
  };
};

const CommentaryBlock = ({ text, isStreaming }: { text: string; isStreaming: boolean }) => (
  <DisclosureBlock
    label="Progress"
    text={text}
    tone="accent"
    defaultOpen={isStreaming}
    collapseWhen={!isStreaming}
  />
);

const TypingIndicator = () => (
  <div className="flex items-center gap-2 text-sm text-ink-3">
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map(index => (
        <span
          key={index}
          className="h-1.5 w-1.5 rounded-full bg-ink-3 animate-pulse-dot"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
    </span>
    <span>Thinking…</span>
  </div>
);

const DetailRow = ({
  icon: Icon,
  label,
  value
}: {
  icon: typeof Bot;
  label: string;
  value: React.ReactNode;
}) => (
  <div className="flex items-start gap-3">
    <Icon size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        {label}
      </div>
      <div className="text-sm text-ink">{value}</div>
    </div>
  </div>
);

const ResponseDetailsMenu = ({ message }: { message: Message }) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(menuRef, isOpen, close);

  const modelLabel = getResponseModelLabel(message);
  const hasThinkingDuration = typeof message.thinkingDuration === 'number' && message.thinkingDuration > 0;
  const hasTokenUsage = Boolean(message.usage);
  const cacheWriteTokens = message.usage?.input_tokens_details.cache_write_tokens;
  const hasCacheWriteTokens = typeof cacheWriteTokens === 'number';

  const tokenRow = (label: string, value: number) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-2">{label}</span>
      <span className="tabular-nums text-ink">{formatTokenCount(value)}</span>
    </div>
  );

  return (
    <div ref={menuRef} className="relative">
      {isOpen && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-xl border border-line bg-surface p-4 shadow-pop animate-pop-in">
          <div className="text-xs font-medium text-ink-3">
            {formatMessageTimestamp(message.timestamp)}
          </div>

          <div className="mt-3 space-y-3">
            {modelLabel && <DetailRow icon={Bot} label="Model" value={modelLabel} />}

            {hasThinkingDuration && (
              <DetailRow
                icon={Clock}
                label="Thinking time"
                value={formatDuration(message.thinkingDuration!)}
              />
            )}

            {hasTokenUsage && (
              <div className="flex items-start gap-3">
                <Hash size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                    Tokens
                  </div>
                  <div className="mt-1 space-y-1 text-sm">
                    {tokenRow('Input', message.usage!.input_tokens)}
                    {hasCacheWriteTokens && tokenRow('Cache write', cacheWriteTokens)}
                    {tokenRow('Cached input', message.usage!.input_tokens_details.cached_tokens)}
                    {tokenRow('Output', message.usage!.output_tokens)}
                  </div>
                </div>
              </div>
            )}

            {typeof message.fileSearchCallCount === 'number' && (
              <DetailRow
                icon={FileText}
                label="File Search"
                value={`${message.fileSearchCallCount} invocation${message.fileSearchCallCount === 1 ? '' : 's'}`}
              />
            )}
          </div>
        </div>
      )}

      <IconButton
        size="sm"
        iconSize={15}
        label={isOpen ? 'Hide response details' : 'Show response details'}
        icon={Info}
        active={isOpen}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(prev => !prev)}
      />
    </div>
  );
};

const CopyResponseButton = ({ text }: { text: string }) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
  }, []);

  const handleCopy = async () => {
    if (!text) return;
    let nextState: 'copied' | 'error' = 'copied';
    try {
      await copyTextToClipboard(text);
    } catch (error) {
      console.error('Failed to copy response.', error);
      nextState = 'error';
    }
    setCopyState(nextState);
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setCopyState('idle');
      timeoutRef.current = null;
    }, 2000);
  };

  return (
    <IconButton
      size="sm"
      iconSize={15}
      label={copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy response'}
      icon={copyState === 'copied' ? Check : copyState === 'error' ? AlertCircle : Copy}
      tone={copyState === 'error' ? 'danger' : 'default'}
      className={copyState === 'copied' ? 'text-accent' : undefined}
      disabled={!text}
      onClick={handleCopy}
    />
  );
};

export const getResponseModelLabel = (message: Message): string | null => (
  message.modelName
    ? `${message.modelName}${message.reasoningEffort ? ` ${message.reasoningEffort}` : ''}`
    : null
);

const CHIP_CLASS =
  'flex max-w-[220px] items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-2';

const SourcesBlock = ({ sources }: { sources: Source[] }) => {
  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        <Globe size={12} aria-hidden="true" />
        Sources
      </div>
      <div className="flex flex-wrap gap-2">
        {sources.map((source, idx) => {
          const sourcePresentation = getSourcePresentation(source);
          const chipContent = (
            <>
              {source.kind === 'file' ? (
                <FileText size={12} className="shrink-0 text-ink-3" aria-hidden="true" />
              ) : sourcePresentation.hostname ? (
                <img
                  src={`https://www.google.com/s2/favicons?domain=${sourcePresentation.hostname}&sz=32`}
                  alt=""
                  className="h-3.5 w-3.5 rounded-sm opacity-80"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <Globe size={12} className="shrink-0 text-ink-3" aria-hidden="true" />
              )}
              <span className="truncate font-medium">{sourcePresentation.label}</span>
            </>
          );

          if (!sourcePresentation.href) {
            return (
              <div key={idx} title={sourcePresentation.rawUrl} className={CHIP_CLASS}>
                {chipContent}
              </div>
            );
          }

          return (
            <a
              key={idx}
              href={sourcePresentation.href}
              target="_blank"
              rel="noopener noreferrer"
              title={sourcePresentation.rawUrl}
              className={cx(CHIP_CLASS, 'transition-colors hover:border-line-strong hover:bg-surface-3 hover:text-ink')}
            >
              {chipContent}
            </a>
          );
        })}
      </div>
    </div>
  );
};

const getGeneratedFileKey = (file: GeneratedFile, index: number): string => (
  `${file.containerId}:${file.fileId}:${index}`
);

const getGeneratedFileLabel = (file: GeneratedFile): string => (
  file.displayName || file.filename || file.fileId || 'generated-file'
);

const getGeneratedFileDownloadName = (file: GeneratedFile): string => (
  stripInvalidFilenameCharacters(getGeneratedFileLabel(file)) || 'generated-file'
);

const isFailedAssistantMessage = (message: Message): boolean => (
  message.role === 'assistant' &&
  message.status === 'error'
);

const GeneratedFilesBlock = ({
  files,
  apiKey,
  onDownloadGeneratedFile
}: {
  files: GeneratedFile[];
  apiKey: string;
  onDownloadGeneratedFile: (file: GeneratedFile) => Promise<Blob>;
}) => {
  const [downloadStates, setDownloadStates] = useState<Record<string, 'idle' | 'downloading' | 'error'>>({});

  if (!files || files.length === 0) return null;

  const hasDownloadError = Object.values(downloadStates).includes('error');

  const setDownloadState = (
    fileKey: string,
    state: 'idle' | 'downloading' | 'error'
  ) => {
    setDownloadStates(prev => ({
      ...prev,
      [fileKey]: state
    }));
  };

  const handleDownload = async (file: GeneratedFile, index: number) => {
    const canDownload = Boolean(file.localBlob) || apiKey.trim().length > 0;
    if (!canDownload) return;

    const fileKey = getGeneratedFileKey(file, index);
    setDownloadState(fileKey, 'downloading');

    try {
      const blob = await onDownloadGeneratedFile(file);
      const typedBlob = !blob.type && file.mimeType
        ? new Blob([blob], { type: file.mimeType })
        : blob;

      downloadBlobFile(getGeneratedFileDownloadName(file), typedBlob);
      setDownloadState(fileKey, 'idle');
    } catch (error) {
      console.error('Failed to download generated file.', error);
      setDownloadState(fileKey, 'error');
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        <FileText size={12} aria-hidden="true" />
        Generated files
      </div>
      <div className="flex flex-wrap gap-2">
        {files.map((file, index) => {
          const fileKey = getGeneratedFileKey(file, index);
          const downloadState = downloadStates[fileKey] || 'idle';
          const isDownloading = downloadState === 'downloading';
          const didFail = downloadState === 'error';
          const canDownload = Boolean(file.localBlob) || apiKey.trim().length > 0;
          const label = getGeneratedFileLabel(file);
          const title = `${label}\nContainer: ${file.containerId}\nFile: ${file.fileId}`;

          return (
            <button
              key={fileKey}
              type="button"
              onClick={() => handleDownload(file, index)}
              disabled={isDownloading}
              aria-disabled={!canDownload || isDownloading}
              title={title}
              className={cx(
                'flex min-w-0 max-w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors sm:max-w-[280px]',
                canDownload
                  ? 'border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3'
                  : 'cursor-default border-line bg-surface',
                isDownloading && 'cursor-wait',
                'disabled:opacity-80'
              )}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-2">
                <FileText size={14} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-ink">
                  {label}
                </span>
                <span className="block truncate font-mono text-[10px] text-ink-3">
                  {file.fileId}
                </span>
              </span>
              {isDownloading ? (
                <Clock size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
              ) : didFail ? (
                <AlertCircle size={13} className="shrink-0 text-danger" aria-hidden="true" />
              ) : canDownload ? (
                <Download size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
      </div>
      {!files.some(file => file.localBlob || apiKey.trim().length > 0) && (
        <div className="mt-2 text-[11px] text-ink-3">
          API key required until this file has been cached locally.
        </div>
      )}
      {hasDownloadError && (
        <div className="mt-2 text-[11px] text-danger">
          Download failed. The container file may have expired.
        </div>
      )}
    </div>
  );
};

const ConversationHeader = ({
  title,
  project,
  canShareConversation,
  onShareConversation,
  onOpenSidebar,
  onToggleSidebar,
  isSidebarCollapsed,
  onToggleConfig,
  isConfigOpen
}: {
  title: string;
  project?: Pick<Project, 'name' | 'icon'>;
  canShareConversation: boolean;
  onShareConversation: () => void;
  onOpenSidebar?: () => void;
  onToggleSidebar?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleConfig?: () => void;
  isConfigOpen?: boolean;
}) => (
  <ViewHeader>
    <SidebarControls
      onOpenSidebar={onOpenSidebar}
      onToggleSidebar={onToggleSidebar}
      isSidebarCollapsed={isSidebarCollapsed}
    />
    <div className="flex min-w-0 flex-1 select-text items-center gap-1.5 px-1">
      {project ? (
        <>
          <ProjectIconGlyph
            icon={project.icon}
            size={16}
            className="shrink-0 text-ink-3"
          />
          <span className="max-w-[40%] truncate text-sm font-medium text-ink-2">
            {project.name}
          </span>
          <span className="shrink-0 text-ink-3">/</span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {title || 'Untitled Chat'}
          </h2>
        </>
      ) : (
        <h2 className="truncate text-sm font-semibold text-ink">
          {title || 'Untitled Chat'}
        </h2>
      )}
    </div>
    <Button
      variant="ghost"
      size="sm"
      icon={Download}
      onClick={onShareConversation}
      aria-label="Export conversation"
      title="Download this conversation as Markdown"
      disabled={!canShareConversation}
    >
      <span className="hidden sm:inline">Export</span>
    </Button>
    {onToggleConfig && (
      <IconButton
        label={isConfigOpen ? 'Close chat settings' : 'Open chat settings'}
        icon={SlidersHorizontal}
        iconSize={17}
        active={isConfigOpen}
        aria-expanded={isConfigOpen}
        onClick={onToggleConfig}
      />
    )}
  </ViewHeader>
);

export const markdownComponents = {
  pre: ({node, children, ...props}: any) => {
    const codeElement = React.Children.toArray(children).find(React.isValidElement) as React.ReactElement<{
      className?: string;
      children?: React.ReactNode;
    }> | undefined;
    const className = codeElement?.props.className;

    return (
      <div className="my-3 min-w-0 max-w-full overflow-hidden rounded-xl border border-line bg-code">
        <div className="flex items-center justify-between border-b border-line px-3 py-1.5 font-mono text-[11px] text-ink-3">{getCodeBlockLabel(className)}</div>
        <pre className="overflow-x-auto p-3.5 font-mono text-[12.5px] leading-relaxed text-ink" {...props}>
          <code className={className}>{codeElement?.props.children ?? children}</code>
        </pre>
      </div>
    );
  },
  code: ({node, children, ...props}: any) => {
    return (
      <code className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[0.85em] text-ink" {...props}>
        {children}
      </code>
    );
  },
  table: ({node, children, ...props}: any) => (
    <div className="markdown-table-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
  a: ({node, href, children, ...props}: any) => {
    const isFootnote = /^\[\d+\]$/.test(String(children));
    const className = isFootnote
      ? 'ml-0.5 font-semibold text-accent no-underline hover:text-accent-hover'
      : 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent';
    // react-markdown blanks unsafe URLs; a bare anchor would reload the app.
    if (!href) {
      return <span className={className}>{children}</span>;
    }
    // Only absolute web links leave the app; fragments and footnotes stay in-page.
    const opensNewTab = /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        target={opensNewTab ? '_blank' : undefined}
        rel={opensNewTab ? 'noopener noreferrer' : undefined}
        title={href}
        className={className}
        {...props}
      >
        {children}
      </a>
    );
  }
};

export const AssistantMarkdown = ({ children }: { children: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
    components={markdownComponents}
  >
    {normalizeMarkdownMath(children)}
  </ReactMarkdown>
);

interface MessageRowProps {
  message: Message;
  canRetry: boolean;
  canRegenerate: boolean;
  canEditAttachments?: boolean;
  apiKey: string;
  onDownloadGeneratedFile?: (file: GeneratedFile) => Promise<Blob>;
  onRetryFailedMessage: (assistantMessageId: string) => void;
  onRemoveFailedAttachment?: (userMessageId: string, attachmentIndex: number) => void;
  onReplaceFailedAttachments?: (
    userMessageId: string,
    attachments: File[]
  ) => Promise<string | undefined>;
  onRegenerateResponse: () => void;
}

const AttachmentList = ({
  message,
  canEditAttachments,
  onRemoveFailedAttachment
}: {
  message: Message;
  canEditAttachments: boolean;
  onRemoveFailedAttachment?: (userMessageId: string, attachmentIndex: number) => void;
}) => {
  const alignment = message.role === 'user' ? 'justify-end' : 'justify-start';
  const canRemove = canEditAttachments && Boolean(message.id) && Boolean(onRemoveFailedAttachment);
  return (
    <>
      <div className={cx('flex min-w-0 max-w-full flex-wrap gap-2', alignment)}>
        {message.attachments?.map((file, index) => (
          isSupportedImageAttachment({ name: file.name, type: file.type }) && (file.previewUrl || file.content) ? (
            <div key={`img-${index}`} className="relative">
              <img
                src={file.previewUrl || file.content}
                alt={file.name}
                className="max-h-[240px] max-w-full rounded-xl border border-line bg-surface-3 object-cover sm:max-w-[240px]"
              />
              {canRemove && (
                <button
                  type="button"
                  onClick={() => onRemoveFailedAttachment!(message.id!, index)}
                  aria-label={`Remove ${file.name}`}
                  title={`Remove ${file.name}`}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-ink p-1 text-surface shadow transition-colors hover:bg-danger"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          ) : null
        ))}
      </div>
      <div className={cx('flex min-w-0 max-w-full flex-wrap gap-2', alignment)}>
        {message.attachments?.map((file, index) => (
          !isSupportedImageAttachment({ name: file.name, type: file.type }) ? (
            <div key={`file-${index}`} className={CHIP_CLASS}>
              <FileText size={12} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{file.name}</span>
              {canRemove && (
                <button
                  type="button"
                  onClick={() => onRemoveFailedAttachment!(message.id!, index)}
                  aria-label={`Remove ${file.name}`}
                  title={`Remove ${file.name}`}
                  className="rounded p-0.5 hover:text-danger"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          ) : null
        ))}
      </div>
    </>
  );
};

// Memoized so a streaming delta only re-renders (and re-parses markdown for) the
// message it touches; App's session updaters keep untouched message identities stable.
export const MessageRow = React.memo(({
  message,
  canRetry,
  canRegenerate,
  canEditAttachments = false,
  apiKey,
  onDownloadGeneratedFile,
  onRetryFailedMessage,
  onRemoveFailedAttachment,
  onReplaceFailedAttachments,
  onRegenerateResponse
}: MessageRowProps) => {
  const isAssistantStreaming = message.status === 'streaming';
  const assistantContent = getAssistantContentPresentation(message);
  const replacementInputRef = useRef<HTMLInputElement>(null);
  const [attachmentEditError, setAttachmentEditError] = useState<string | null>(null);

  const handleReplacementSelect = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    restoreFocusAfterFileDialog();
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!message.id || files.length === 0 || !onReplaceFailedAttachments) return;

    try {
      validateAttachments(files);
      const error = await onReplaceFailedAttachments(message.id, files);
      setAttachmentEditError(error || null);
    } catch (error) {
      setAttachmentEditError(
        error instanceof Error ? error.message : 'Attachments could not be replaced.'
      );
    }
  };

  const hasAttachments = Boolean(message.attachments && message.attachments.length > 0);

  if (message.role === 'user') {
    return (
      <div className="flex w-full min-w-0 flex-col items-end gap-2">
        {(hasAttachments || canEditAttachments) && (
          <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-2">
            <AttachmentList
              message={message}
              canEditAttachments={canEditAttachments}
              onRemoveFailedAttachment={onRemoveFailedAttachment}
            />
            {canEditAttachments && message.id && onReplaceFailedAttachments && (
              <div className="flex max-w-full flex-col items-end gap-1">
                <Button
                  size="sm"
                  icon={Upload}
                  iconSize={13}
                  onClick={() => replacementInputRef.current?.click()}
                >
                  Replace attachments
                </Button>
                <input
                  ref={input => {
                    replacementInputRef.current = input;
                    registerFileDialogFocusRecovery(input);
                  }}
                  type="file"
                  multiple
                  accept={ATTACHMENT_INPUT_ACCEPT}
                  className="hidden"
                  onChange={handleReplacementSelect}
                />
                {attachmentEditError && (
                  <span role="alert" className="max-w-sm text-right text-xs text-danger">
                    {attachmentEditError}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {message.content && (
          <div className="message-content min-w-0 max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5 text-[15px] leading-relaxed text-ink">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="group flex w-full min-w-0 flex-col items-start gap-2">
      <BrandMark size={20} className="rounded-md" />

      <div className="w-full min-w-0 space-y-2 pl-0 sm:pl-7">
        {message.thinking && (
          <ThinkingBlock text={message.thinking} durationMs={message.thinkingDuration} />
        )}

        {assistantContent.commentary && (
          <CommentaryBlock
            text={assistantContent.commentary}
            isStreaming={isAssistantStreaming}
          />
        )}

        <div className="message-content min-w-0 max-w-full text-[15px] leading-relaxed text-ink">
          <div className="markdown-content w-full max-w-full">
            {isAssistantStreaming && !assistantContent.primary ? (
              <TypingIndicator />
            ) : (
              <AssistantMarkdown>
                {assistantContent.primary}
              </AssistantMarkdown>
            )}
          </div>
        </div>

        {message.status === 'incomplete' && (
          <Callout role="status" tone="warn" icon={AlertCircle}>
            {getIncompleteResponseMessage(message.incompleteReason)}
          </Callout>
        )}

        {message.status === 'error' && !assistantContent.primary && (
          <Callout role="status" tone="danger" icon={AlertCircle}>
            The response failed before any output arrived.
          </Callout>
        )}

        {message.sources && message.sources.length > 0 && (
          <SourcesBlock sources={message.sources} />
        )}

        {message.generatedFiles && message.generatedFiles.length > 0 && (
          <GeneratedFilesBlock
            files={message.generatedFiles}
            apiKey={apiKey}
            onDownloadGeneratedFile={onDownloadGeneratedFile || (async () => {
              throw new Error('Generated-file download is unavailable.');
            })}
          />
        )}

        {!isAssistantStreaming && (
          <div className="flex select-none items-center gap-0.5 pt-0.5">
            <CopyResponseButton text={assistantContent.primary || message.content} />
            {canRegenerate && (
              <IconButton
                size="sm"
                iconSize={15}
                label="Regenerate"
                icon={RefreshCw}
                onClick={onRegenerateResponse}
              />
            )}
            <ResponseDetailsMenu message={message} />
            {canRetry && (
              <Button
                size="sm"
                icon={RotateCcw}
                iconSize={13}
                onClick={() => onRetryFailedMessage(message.id!)}
                className="ml-1"
              >
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

const ProjectLibraryMenu = ({
  sources,
  disabled,
  onSelect
}: {
  sources: ProjectSource[];
  disabled: boolean;
  onSelect: (source: ProjectSource) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(menuRef, isOpen, close);

  return (
    <div ref={menuRef} className="relative">
      <IconButton
        size="sm"
        label="Attach project source"
        title="Attach a file from the project library"
        icon={FolderOpen}
        iconSize={17}
        active={isOpen}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setIsOpen(open => !open)}
      />
      {isOpen && (
        <div
          role="menu"
          aria-label="Project library"
          className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-72 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop animate-pop-in"
        >
          <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
            Attach from project library
          </div>
          {sources.map(source => (
            <button
              key={source.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                onSelect(source);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-3"
            >
              <FileText size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{source.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const WelcomeScreen = ({
  onOpenSidebar,
  onToggleSidebar,
  isSidebarCollapsed,
  onNewSession,
  onNewProject
}: Pick<
  ChatAreaProps,
  'onOpenSidebar' | 'onToggleSidebar' | 'isSidebarCollapsed' | 'onNewSession' | 'onNewProject'
>) => (
  <div className="flex h-full min-w-0 flex-1 flex-col bg-surface">
    <ViewHeader className="border-b-0 bg-transparent">
      <SidebarControls
        onOpenSidebar={onOpenSidebar}
        onToggleSidebar={onToggleSidebar}
        isSidebarCollapsed={isSidebarCollapsed}
      />
    </ViewHeader>
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
      <BrandMark size={56} className="rounded-2xl shadow-card" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink">Welcome to OpenAI Studio</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-2">
        Start a chat with the Responses API, or create a project to keep instructions
        and reusable sources together.
      </p>
      {(onNewSession || onNewProject) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {onNewSession && (
            <Button variant="primary" size="lg" icon={ArrowUp} onClick={onNewSession}>
              New chat
            </Button>
          )}
          {onNewProject && (
            <Button size="lg" icon={FolderPlus} onClick={onNewProject}>
              New project
            </Button>
          )}
        </div>
      )}
    </div>
  </div>
);

export const ChatArea: React.FC<ChatAreaProps> = ({
  session,
  availableSessionIds,
  onSendMessage,
  onStopGenerating,
  onRetryFailedMessage,
  onRemoveFailedAttachment,
  onReplaceFailedAttachments,
  onRegenerateResponse,
  onShareConversation,
  onDownloadGeneratedFile,
  apiKey,
  isLoading,
  readOnly = false,
  projectSources = [],
  onLoadProjectSource,
  project,
  onOpenSidebar,
  onToggleSidebar,
  isSidebarCollapsed,
  onToggleConfig,
  isConfigOpen,
  onNewSession,
  onNewProject
}) => {
  const [drafts, dispatchDraft] = useReducer(chatDraftsReducer, {});
  const [fileInputKey, setFileInputKey] = useState(0);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileSelectionSessionIdRef = useRef<string | null>(null);
  const availableSessionIdsRef = useRef(new Set(availableSessionIds));
  availableSessionIdsRef.current = new Set(availableSessionIds);
  const isPinnedToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const previousSessionIdRef = useRef<string | null>(null);
  const previousMessageCountRef = useRef(0);
  const latestMessage = session?.messages[session.messages.length - 1];
  const activeSessionId = session?.id || null;
  const activeDraft = getChatDraft(drafts, activeSessionId);
  const inputValue = activeDraft.content;
  const attachments = activeDraft.attachments;
  const attachmentError = activeDraft.attachmentError;
  const availableSessionIdsKey = availableSessionIds.join('\u0000');

  // App recreates these handlers on every render; hand memoized rows
  // stable wrappers instead so streaming updates don't defeat React.memo.
  const onRetryFailedMessageRef = useRef(onRetryFailedMessage);
  const onRegenerateResponseRef = useRef(onRegenerateResponse);
  const onRemoveFailedAttachmentRef = useRef(onRemoveFailedAttachment);
  const onReplaceFailedAttachmentsRef = useRef(onReplaceFailedAttachments);

  useLayoutEffect(() => {
    onRetryFailedMessageRef.current = onRetryFailedMessage;
    onRegenerateResponseRef.current = onRegenerateResponse;
    onRemoveFailedAttachmentRef.current = onRemoveFailedAttachment;
    onReplaceFailedAttachmentsRef.current = onReplaceFailedAttachments;
  });

  const handleRetryFailedMessage = useCallback((assistantMessageId: string) => {
    onRetryFailedMessageRef.current(assistantMessageId);
  }, []);

  const handleRegenerateResponse = useCallback(() => {
    onRegenerateResponseRef.current();
  }, []);

  const handleRemoveFailedAttachment = useCallback((
    userMessageId: string,
    attachmentIndex: number
  ) => {
    onRemoveFailedAttachmentRef.current(userMessageId, attachmentIndex);
  }, []);

  const handleReplaceFailedAttachments = useCallback((
    userMessageId: string,
    files: File[]
  ) => onReplaceFailedAttachmentsRef.current(userMessageId, files), []);

  const isNearBottom = (element: HTMLDivElement): boolean => {
    return element.scrollHeight - element.scrollTop - element.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
  };

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const container = messagesContainerRef.current;
    if (!container) return;

    if (scrollFrameRef.current) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior
      });
      scrollFrameRef.current = null;
    });
  };

  const handleMessagesScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;

    isPinnedToBottomRef.current = isNearBottom(container);
  };

  useLayoutEffect(() => {
    if (!session) return;

    const didSwitchSession = previousSessionIdRef.current !== session.id;
    const didAddMessage = previousMessageCountRef.current !== session.messages.length;
    const shouldFollowStreaming = isPinnedToBottomRef.current && latestMessage?.status === 'streaming';

    if (didSwitchSession) {
      isPinnedToBottomRef.current = true;
      scrollToBottom('auto');
    } else if (shouldFollowStreaming) {
      scrollToBottom('auto');
    } else if (didAddMessage && isPinnedToBottomRef.current) {
      scrollToBottom('smooth');
    }

    previousSessionIdRef.current = session.id;
    previousMessageCountRef.current = session.messages.length;
  }, [
    session?.id,
    session?.messages.length,
    latestMessage?.content,
    latestMessage?.status
  ]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    dispatchDraft({
      type: 'prune',
      sessionIds: availableSessionIds
    });
  }, [availableSessionIdsKey]);

  useLayoutEffect(() => {
    if (!textareaRef.current) return;

    resizePromptTextarea(textareaRef.current);
  }, [inputValue, activeSessionId]);

  const handleSend = async () => {
    if (
      readOnly ||
      !activeSessionId ||
      (!inputValue.trim() && attachments.length === 0) ||
      isLoading
    ) {
      return;
    }
    try {
      validateAttachments(attachments);
    } catch (error) {
      dispatchDraft({
        type: 'set-attachment-error',
        sessionId: activeSessionId,
        attachmentError: error instanceof Error
          ? error.message
          : 'Attachments could not be sent.'
      });
      return;
    }
    isPinnedToBottomRef.current = true;
    const targetSessionId = activeSessionId;
    const submittedContent = inputValue;
    const submittedAttachments = attachments;
    dispatchDraft({
      type: 'clear',
      sessionId: targetSessionId
    });

    const accepted = await onSendMessage(
      targetSessionId,
      submittedContent,
      submittedAttachments
    );
    if (!accepted && availableSessionIdsRef.current.has(targetSessionId)) {
      dispatchDraft({
        type: 'restore-submission',
        sessionId: targetSessionId,
        content: submittedContent,
        attachments: submittedAttachments
      });
    }
  };

  const addAttachments = (sessionId: string, files: File[]) => {
    if (!availableSessionIdsRef.current.has(sessionId)) return;
    // The reducer validates against the draft as it is when the action lands,
    // so asynchronous project-source loads cannot overwrite newer attachments.
    dispatchDraft({
      type: 'append-attachments',
      sessionId,
      attachments: files
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter commits an IME candidate; only an uncomposed Enter sends.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    restoreFocusAfterFileDialog();
    const targetSessionId = fileSelectionSessionIdRef.current;
    fileSelectionSessionIdRef.current = null;
    if (
      !readOnly &&
      targetSessionId &&
      e.target.files &&
      e.target.files.length > 0
    ) {
      addAttachments(targetSessionId, Array.from(e.target.files));
    }
    setFileInputKey(prev => prev + 1);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (readOnly) return;
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          // For pasted images without a proper name, generate one
          if (file.type.startsWith('image/') && file.name === 'image.png') {
            const ext = file.type.split('/')[1] || 'png';
            const namedFile = new File([file], `pasted-image-${Date.now()}.${ext}`, { type: file.type });
            files.push(namedFile);
          } else {
            files.push(file);
          }
        }
      }
    }

    if (files.length > 0 && activeSessionId) {
      addAttachments(activeSessionId, files);
    }
  };

  const removeAttachment = (index: number) => {
    if (readOnly || !activeSessionId) return;
    dispatchDraft({
      type: 'remove-attachment',
      sessionId: activeSessionId,
      attachmentIndex: index
    });
  };

  const openFilePicker = () => {
    if (readOnly || !activeSessionId) return;
    fileSelectionSessionIdRef.current = activeSessionId;
    fileInputRef.current?.click();
  };

  const attachProjectSource = (source: ProjectSource) => {
    if (!onLoadProjectSource || !activeSessionId) return;
    const targetSessionId = activeSessionId;
    void onLoadProjectSource(source)
      .then(file => addAttachments(targetSessionId, [file]))
      .catch(error => dispatchDraft({
        type: 'set-attachment-error',
        sessionId: targetSessionId,
        attachmentError: error instanceof Error
          ? error.message
          : 'Project source could not be attached.'
      }));
  };

  if (!session) {
    return (
      <WelcomeScreen
        onOpenSidebar={onOpenSidebar}
        onToggleSidebar={onToggleSidebar}
        isSidebarCollapsed={isSidebarCollapsed}
        onNewSession={onNewSession}
        onNewProject={onNewProject}
      />
    );
  }

  const canShareConversation = session.messages.length > 0;
  const canSend = !readOnly && (Boolean(inputValue.trim()) || attachments.length > 0);
  const modelConfig = getModelConfig(session.config.model);
  const enabledTools = [
    session.config.tools.webSearch ? 'Web' : null,
    session.config.tools.codeInterpreter ? 'Code' : null
  ].filter((tool): tool is string => tool !== null);
  const modelSummary = (
    <ModelSummary
      modelName={modelConfig.name}
      reasoningEffort={session.config.reasoningEffort}
      enabledTools={enabledTools}
    />
  );

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <ConversationHeader
        title={session.title}
        project={project}
        canShareConversation={canShareConversation}
        onShareConversation={onShareConversation}
        onOpenSidebar={onOpenSidebar}
        onToggleSidebar={onToggleSidebar}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleConfig={onToggleConfig}
        isConfigOpen={isConfigOpen}
      />

      <div
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
        className="min-h-0 w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {session.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <BrandMark size={44} className="rounded-2xl" />
            <h3 className="mt-5 text-xl font-semibold tracking-tight text-ink">
              What can I help with?
            </h3>
            {project && (
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-2">
                Instructions and sources from {project.name} apply to this chat.
              </p>
            )}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-6">
            {session.messages.map((msg, idx) => {
              const isLatestMessage = idx === session.messages.length - 1;
              const hasPrecedingUserMessage = idx > 0 && session.messages[idx - 1]?.role === 'user';
              const canRetry = (
                isFailedAssistantMessage(msg) &&
                isLatestMessage &&
                !isLoading &&
                !readOnly &&
                Boolean(msg.id) &&
                hasPrecedingUserMessage
              );
              const canRegenerate = (
                msg.role === 'assistant' &&
                isLatestMessage &&
                !isFailedAssistantMessage(msg) &&
                msg.status !== 'streaming' &&
                !isLoading &&
                !readOnly &&
                hasPrecedingUserMessage
              );
              const canEditAttachments = (
                msg.role === 'user' &&
                msg.attachments !== undefined &&
                idx === session.messages.length - 2 &&
                session.messages[idx + 1]?.role === 'assistant' &&
                session.messages[idx + 1]?.status === 'error' &&
                !isLoading &&
                !readOnly &&
                Boolean(msg.id)
              );

              return (
                <MessageRow
                  key={msg.id || idx}
                  message={msg}
                  canRetry={canRetry}
                  canRegenerate={canRegenerate}
                  canEditAttachments={canEditAttachments}
                  apiKey={apiKey}
                  onDownloadGeneratedFile={onDownloadGeneratedFile}
                  onRetryFailedMessage={handleRetryFailedMessage}
                  onRemoveFailedAttachment={handleRemoveFailedAttachment}
                  onReplaceFailedAttachments={handleReplaceFailedAttachments}
                  onRegenerateResponse={handleRegenerateResponse}
                />
              );
            })}
            <div className="h-2" />
          </div>
        )}
      </div>

      <div className="w-full min-w-0 shrink-0 bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1 sm:px-6">
        <div className="mx-auto w-full min-w-0 max-w-3xl space-y-2">
          {attachmentError && (
            <Callout role="alert" tone="danger" icon={AlertCircle}>{attachmentError}</Callout>
          )}
          <div className="rounded-2xl border border-line bg-surface-2 shadow-card transition-[border-color,box-shadow] focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {attachments.map((file, index) => {
                  const isImage = isSupportedImageAttachment(file);

                  return isImage ? (
                    <div key={index} className="group relative" title={file.name}>
                      <DraftImagePreview file={file} />
                      <button
                        type="button"
                        onClick={() => removeAttachment(index)}
                        disabled={readOnly}
                        aria-label={`Remove ${file.name}`}
                        className="absolute -right-1.5 -top-1.5 rounded-full bg-ink p-0.5 text-surface shadow transition-colors hover:bg-danger"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <div key={index} className={cx(CHIP_CLASS, 'bg-surface')} title={file.name}>
                      <FileText size={12} className="shrink-0" aria-hidden="true" />
                      <span className="max-w-[140px] truncate">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(index)}
                        disabled={readOnly}
                        aria-label={`Remove ${file.name}`}
                        className="rounded p-0.5 hover:text-danger disabled:cursor-not-allowed"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => {
                if (!activeSessionId) return;
                dispatchDraft({
                  type: 'set-content',
                  sessionId: activeSessionId,
                  content: e.target.value
                });
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={readOnly}
              aria-label="Message"
              placeholder={readOnly ? 'Read-only while another tab is editing' : 'Ask anything…'}
              className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[15px] leading-6 text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-60"
              rows={1}
              style={{ height: `${PROMPT_INPUT_MIN_HEIGHT_PX}px`, minHeight: `${PROMPT_INPUT_MIN_HEIGHT_PX}px` }}
            />

            <div className="flex items-center gap-1 px-2 pb-2">
              <IconButton
                size="sm"
                label="Attach files"
                icon={Paperclip}
                iconSize={17}
                onClick={openFilePicker}
                disabled={readOnly}
              />
              <input
                type="file"
                multiple
                className="hidden"
                ref={input => {
                  fileInputRef.current = input;
                  registerFileDialogFocusRecovery(input);
                }}
                onChange={handleFileSelect}
                accept={ATTACHMENT_INPUT_ACCEPT}
                key={fileInputKey}
                disabled={readOnly}
              />
              {projectSources.length > 0 && onLoadProjectSource && (
                <ProjectLibraryMenu
                  sources={projectSources}
                  disabled={readOnly || isLoading}
                  onSelect={attachProjectSource}
                />
              )}
              <div className="min-w-0 flex-1" />
              {isLoading ? (
                <button
                  type="button"
                  onClick={onStopGenerating}
                  disabled={readOnly}
                  className="ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-colors hover:bg-ink-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
                  title="Stop generating"
                  aria-label="Stop generating"
                >
                  <Square size={14} fill="currentColor" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend}
                  aria-label="Send message"
                  title="Send (Enter)"
                  className={cx(
                    'ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    canSend
                      ? 'bg-accent text-accent-ink shadow-card hover:bg-accent-hover'
                      : 'cursor-not-allowed bg-surface-3 text-ink-3'
                  )}
                >
                  <ArrowUp size={18} strokeWidth={2.4} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3 px-1">
            {onToggleConfig ? (
              <button
                type="button"
                onClick={onToggleConfig}
                aria-label="Open chat settings"
                title="Model, reasoning, and tools"
                className={cx(MODEL_SUMMARY_CLASS, 'transition-colors hover:bg-surface-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40')}
              >
                {modelSummary}
              </button>
            ) : (
              <span className={MODEL_SUMMARY_CLASS}>{modelSummary}</span>
            )}
            <ContextWindowUsage session={session} />
          </div>
        </div>
      </div>
    </div>
  );
};
