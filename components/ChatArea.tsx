
import React, {
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState
} from 'react';
import { GeneratedFile, Message, Session, Source } from '../types';
import { Send, Bot, User, Paperclip, X, FileText, ChevronDown, ChevronRight, Globe, Clock, MoreHorizontal, Copy, Check, AlertCircle, Upload, Download, Loader2, RefreshCw, RotateCcw, Square, Hash } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  isMobile?: boolean;
  readOnly?: boolean;
}

const AUTO_SCROLL_THRESHOLD_PX = 120;
const PROMPT_INPUT_MIN_HEIGHT_PX = 52;
const PROMPT_INPUT_MAX_HEIGHT_PX = 192;

const resizePromptTextarea = (textarea: HTMLTextAreaElement): void => {
  textarea.style.height = `${PROMPT_INPUT_MIN_HEIGHT_PX}px`;
  textarea.style.height = `${Math.min(
    Math.max(textarea.scrollHeight, PROMPT_INPUT_MIN_HEIGHT_PX),
    PROMPT_INPUT_MAX_HEIGHT_PX
  )}px`;
};

const DraftImagePreview: React.FC<{ file: File }> = ({ file }) => {
  const imageUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => () => {
    URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  return (
    <img
      src={imageUrl}
      alt={file.name}
      className="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
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

const formatCompactTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  }
  if (tokens >= 1_000) {
    return `${Number((tokens / 1_000).toFixed(1))}K`;
  }
  return formatTokenCount(tokens);
};

const getLatestContextTokenUsage = (messages: Message[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const totalTokens = messages[index].usage?.total_tokens;
    if (typeof totalTokens === 'number' && Number.isFinite(totalTokens)) {
      return Math.max(0, totalTokens);
    }
  }

  return 0;
};

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
  const compactTokenUsage = `${formatCompactTokenCount(contextTokens)} / ${formatCompactTokenCount(modelConfig.contextWindowTokens)}`;
  const description = contextTokens > 0
    ? `${formatTokenCount(contextTokens)} of ${formatTokenCount(modelConfig.contextWindowTokens)} tokens used through the latest completed response with ${modelConfig.name}.`
    : `No completed request yet. ${modelConfig.name} has a ${formatTokenCount(modelConfig.contextWindowTokens)} token context window.`;

  return (
    <div
      className="mt-2 flex items-center justify-end gap-2 px-1 text-[10px] text-gray-400 dark:text-gray-500"
      title={description}
    >
      <span>Context</span>
      <div
        className="h-1 w-20 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
        role="progressbar"
        aria-label="Context usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPercentage}
        aria-valuetext={`${percentageLabel} used`}
      >
        <div
          className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
          style={{ width: `${usedPercentage}%` }}
        />
      </div>
      <span className="min-w-[44px] text-right tabular-nums">{percentageLabel} used</span>
      <span className="tabular-nums">· {compactTokenUsage}</span>
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

const ThinkingBlock = ({ text, durationMs }: { text: string; durationMs?: number }) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!text) return null;

  return (
    <div className="mb-2 min-w-0 max-w-full">
        <button
            onClick={() => setIsOpen(!isOpen)}
            aria-expanded={isOpen}
            className="flex min-w-0 max-w-full items-center gap-1 text-sm text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
            <span>{formatThinkingLabel(durationMs)}</span>
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {isOpen && (
            <div className="mt-2 min-w-0 max-w-full pl-3 border-l-2 border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400 text-sm leading-relaxed markdown-content">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownComponents}
                >
                    {text}
                </ReactMarkdown>
            </div>
        )}
    </div>
    );
};

const ResponseDetailsMenu = ({ message }: { message: Message }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
    const menuRef = useRef<HTMLDivElement>(null);
    const copyFeedbackTimeoutRef = useRef<number | null>(null);

    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [isOpen]);

    useEffect(() => {
        return () => {
            if (copyFeedbackTimeoutRef.current) {
                window.clearTimeout(copyFeedbackTimeoutRef.current);
            }
        };
    }, []);

    const modelLabel = getResponseModelLabel(message);
    const hasThinkingDuration = typeof message.thinkingDuration === 'number' && message.thinkingDuration > 0;
    const hasTokenUsage = Boolean(message.usage);
    const cacheWriteTokens = message.usage?.input_tokens_details.cache_write_tokens;
    const hasCacheWriteTokens = typeof cacheWriteTokens === 'number';
    const canCopyResponse = message.content.length > 0;

    const setCopyFeedback = (state: 'copied' | 'error') => {
        setCopyState(state);

        if (copyFeedbackTimeoutRef.current) {
            window.clearTimeout(copyFeedbackTimeoutRef.current);
        }

        copyFeedbackTimeoutRef.current = window.setTimeout(() => {
            setCopyState('idle');
            copyFeedbackTimeoutRef.current = null;
        }, 2000);
    };

    const handleCopyResponse = async () => {
        if (!canCopyResponse) return;

        try {
            await copyTextToClipboard(message.content);
            setCopyFeedback('copied');
        } catch (error) {
            console.error('Failed to copy response.', error);
            setCopyFeedback('error');
        }
    };

    return (
        <div ref={menuRef} className="relative">
            {isOpen && (
                <div className="absolute bottom-full right-0 z-10 mb-2 w-64 rounded-[28px] border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#161b22] px-4 py-3 shadow-xl shadow-gray-300/30 dark:shadow-black/30 animate-in slide-in-from-top-2">
                    <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {formatMessageTimestamp(message.timestamp)}
                    </div>

                    <div className="mt-3 space-y-3">
                        {modelLabel && (
                            <div className="flex items-start gap-3 text-gray-700 dark:text-gray-200">
                                <Bot size={17} className="mt-0.5 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                                <div>
                                    <div className="text-[10px] uppercase tracking-[0.2em] text-gray-400 dark:text-gray-500">
                                        Model
                                    </div>
                                    <div className="text-sm font-medium">
                                        {modelLabel}
                                    </div>
                                </div>
                            </div>
                        )}

                        {hasThinkingDuration && (
                            <div className="flex items-start gap-3 text-gray-700 dark:text-gray-200">
                                <Clock size={17} className="mt-0.5 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                                <div>
                                    <div className="text-[10px] uppercase tracking-[0.2em] text-gray-400 dark:text-gray-500">
                                        Thinking Time
                                    </div>
                                    <div className="text-sm font-medium">
                                        {formatDuration(message.thinkingDuration!)}
                                    </div>
                                </div>
                            </div>
                        )}

                        {hasTokenUsage && (
                            <div className="flex items-start gap-3 text-gray-700 dark:text-gray-200">
                                <Hash size={17} className="mt-0.5 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-[10px] uppercase tracking-[0.2em] text-gray-400 dark:text-gray-500">
                                        Tokens
                                    </div>
                                    <div className="mt-1 space-y-1 text-sm font-medium">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-gray-500 dark:text-gray-400">Input</span>
                                            <span>{formatTokenCount(message.usage!.input_tokens)}</span>
                                        </div>
                                        {hasCacheWriteTokens && (
                                            <div className="flex items-center justify-between gap-3">
                                                <span className="text-gray-500 dark:text-gray-400">Cache write</span>
                                                <span>{formatTokenCount(cacheWriteTokens)}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-gray-500 dark:text-gray-400">Cached input</span>
                                            <span>{formatTokenCount(message.usage!.input_tokens_details.cached_tokens)}</span>
                                        </div>
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-gray-500 dark:text-gray-400">Output</span>
                                            <span>{formatTokenCount(message.usage!.output_tokens)}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="my-3 border-t border-gray-200 dark:border-gray-800" />

                    <button
                        type="button"
                        onClick={handleCopyResponse}
                        disabled={!canCopyResponse}
                        className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-[#1f2937] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {copyState === 'copied' ? (
                            <Check size={16} className="flex-shrink-0 text-green-600 dark:text-green-400" />
                        ) : copyState === 'error' ? (
                            <AlertCircle size={16} className="flex-shrink-0 text-red-600 dark:text-red-400" />
                        ) : (
                            <Copy size={16} className="flex-shrink-0 text-gray-500 dark:text-gray-400" />
                        )}
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
                            {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
                        </div>
                    </button>
                </div>
            )}

            <button
                type="button"
                onClick={() => setIsOpen(prev => !prev)}
                aria-label={isOpen ? 'Hide response details' : 'Show response details'}
                aria-expanded={isOpen}
                className="flex h-10 w-10 items-center justify-center rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-[#161b22] text-gray-500 dark:text-gray-400 transition-colors hover:bg-gray-200 dark:hover:bg-[#1f2937] hover:text-gray-700 dark:hover:text-gray-200"
            >
                <MoreHorizontal size={18} />
            </button>
        </div>
    );
};

export const getResponseModelLabel = (message: Message): string | null => (
    message.modelName
        ? `${message.modelName}${message.reasoningEffort ? ` ${message.reasoningEffort}` : ''}`
        : null
);

const SourcesBlock = ({ sources }: { sources: Source[] }) => {
    if (!sources || sources.length === 0) return null;

    return (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                <Globe size={12} />
                Sources
            </div>
            <div className="flex flex-wrap gap-2">
                {sources.map((source, idx) => {
                    const sourcePresentation = getSourcePresentation(source);
                    const chipContent = (
                        <>
                            {sourcePresentation.hostname ? (
                                <img
                                    src={`https://www.google.com/s2/favicons?domain=${sourcePresentation.hostname}&sz=32`}
                                    alt=""
                                    className="w-3.5 h-3.5 opacity-70"
                                    onError={(e) => {
                                        (e.target as HTMLImageElement).style.display = 'none';
                                    }}
                                />
                            ) : (
                                <Globe size={12} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                            )}
                            <span className="text-xs text-gray-700 dark:text-gray-300 truncate font-medium">
                                {sourcePresentation.label}
                            </span>
                        </>
                    );

                    const className = `flex items-center gap-2 bg-gray-100 dark:bg-[#1f2937] border border-gray-200 dark:border-gray-700 rounded-full px-3 py-1.5 max-w-[200px] ${
                        sourcePresentation.href
                            ? 'hover:bg-gray-200 dark:hover:bg-[#2d3748] transition-colors'
                            : 'cursor-default'
                    }`;

                    if (!sourcePresentation.href) {
                        return (
                            <div
                                key={idx}
                                title={sourcePresentation.rawUrl}
                                className={className}
                            >
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
                            className={className}
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

const getGeneratedFileDownloadName = (file: GeneratedFile): string => {
    const label = getGeneratedFileLabel(file)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
        .trim();

    return label || 'generated-file';
};

const saveBlobAsFile = (blob: Blob, filename: string): void => {
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

            saveBlobAsFile(typedBlob, getGeneratedFileDownloadName(file));
            setDownloadState(fileKey, 'idle');
        } catch (error) {
            console.error('Failed to download generated file.', error);
            setDownloadState(fileKey, 'error');
        }
    };

    return (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                <FileText size={12} />
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
                            className={`flex min-w-0 max-w-full sm:max-w-[260px] items-center gap-2 rounded-full border px-3 py-1.5 text-left transition-colors ${
                                canDownload
                                    ? 'bg-gray-100 dark:bg-[#1f2937] border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-[#2d3748]'
                                    : 'bg-gray-50 dark:bg-[#161b22] border-gray-200 dark:border-gray-800 cursor-default'
                            } ${isDownloading ? 'cursor-wait' : ''} disabled:opacity-80`}
                        >
                            <FileText size={12} className="flex-shrink-0 text-gray-500 dark:text-gray-400" />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-medium text-gray-700 dark:text-gray-300">
                                    {label}
                                </span>
                                <span className="block truncate text-[10px] text-gray-500 dark:text-gray-500">
                                    {file.fileId}
                                </span>
                            </span>
                            {isDownloading ? (
                                <Clock size={12} className="flex-shrink-0 text-gray-500 dark:text-gray-400" />
                            ) : didFail ? (
                                <AlertCircle size={12} className="flex-shrink-0 text-red-500 dark:text-red-400" />
                            ) : canDownload ? (
                                <Download size={12} className="flex-shrink-0 text-gray-500 dark:text-gray-400" />
                            ) : null}
                        </button>
                    );
                })}
            </div>
            {!files.some(file => file.localBlob || apiKey.trim().length > 0) && (
                <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-500">
                    API key required until this file has been cached locally.
                </div>
            )}
            {hasDownloadError && (
                <div className="mt-2 text-[11px] text-red-500 dark:text-red-400">
                    Download failed. The container file may have expired.
                </div>
            )}
        </div>
    );
};

const ConversationHeader = ({
  title,
  isMobile,
  canShareConversation,
  onShareConversation
}: {
  title: string;
  isMobile: boolean;
  canShareConversation: boolean;
  onShareConversation: () => void;
}) => {
  const containerClassName = isMobile
    ? 'h-14 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-3 px-4 flex-shrink-0 bg-gray-50 dark:bg-[#0d1117] sticky top-0 z-10 transition-colors'
    : 'h-14 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-4 px-6 flex-shrink-0 bg-white/80 dark:bg-[#0d1117]/80 backdrop-blur-sm sticky top-0 z-10 transition-colors';

  return (
    <div className={containerClassName}>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-gray-800 dark:text-gray-200 select-text truncate">
          {title || 'Untitled Chat'}
        </h2>
      </div>
      <button
        type="button"
        onClick={onShareConversation}
        aria-label="Share conversation"
        title="Share conversation"
        disabled={!canShareConversation}
        className="inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 transition-colors hover:bg-gray-100 dark:hover:bg-[#161b22] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Upload size={18} />
        <span>Share</span>
      </button>
    </div>
  );
};

export const markdownComponents = {
    pre: ({node, children, ...props}: any) => {
        const codeElement = React.Children.toArray(children).find(React.isValidElement) as React.ReactElement<{
            className?: string;
            children?: React.ReactNode;
        }> | undefined;
        const className = codeElement?.props.className;

        return (
            <div className="my-2 min-w-0 max-w-full bg-gray-50 dark:bg-black/30 rounded-md overflow-hidden border border-gray-200 dark:border-gray-700/50">
                <div className="bg-gray-100 dark:bg-gray-800/50 px-3 py-1 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700/50 font-mono">{getCodeBlockLabel(className)}</div>
                <pre className="p-3 overflow-x-auto text-xs font-mono text-gray-800 dark:text-gray-300" {...props}>
                    <code className={className}>{codeElement?.props.children ?? children}</code>
                </pre>
            </div>
        );
    },
    code: ({node, children, ...props}: any) => {
        return (
            <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-xs font-mono text-blue-600 dark:text-blue-300" {...props}>
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
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={href}
                className={`${isFootnote ? "text-blue-500 hover:text-blue-600 font-bold no-underline ml-0.5" : "text-blue-600 dark:text-blue-400 hover:underline"}`}
                {...props}
            >
                {children}
            </a>
        );
    }
};

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
  const replacementInputRef = useRef<HTMLInputElement>(null);
  const [attachmentEditError, setAttachmentEditError] = useState<string | null>(null);

  const handleReplacementSelect = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
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

  return (
    <div
      className={`flex w-full min-w-0 gap-4 max-w-4xl mx-auto ${
        message.role === 'user' ? 'justify-end' : 'justify-start'
      }`}
    >
      {message.role === 'assistant' && (
        <div className="w-8 h-8 rounded-full bg-blue-600 flex-shrink-0 flex items-center justify-center mt-1 text-white shadow-sm">
          <Bot size={16} />
        </div>
      )}

      <div className={`flex min-w-0 max-w-[85%] flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>

          {/* Attachments Section */}
          {((message.attachments && message.attachments.length > 0) || canEditAttachments) && (
              <div className={`flex min-w-0 max-w-full flex-col gap-2 mb-2 ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
                  {/* Images Grid */}
                  <div className={`flex min-w-0 max-w-full flex-wrap gap-2 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {message.attachments?.map((file, index) => (
                        isSupportedImageAttachment({
                          name: file.name,
                          type: file.type
                        }) && (file.previewUrl || file.content) ? (
                          <div
                            key={file.id || `img-${index}`}
                            className="group relative"
                          >
                            <img
                              src={file.previewUrl || file.content}
                              alt={file.name}
                              className="max-w-full sm:max-w-[240px] max-h-[240px] rounded-xl border border-gray-200 dark:border-gray-700 object-cover shadow-sm bg-gray-100 dark:bg-gray-800"
                            />
                            {canEditAttachments && message.id && onRemoveFailedAttachment && (
                              <button
                                type="button"
                                onClick={() => onRemoveFailedAttachment(message.id!, index)}
                                aria-label={`Remove ${file.name}`}
                                title={`Remove ${file.name}`}
                                className="absolute -right-1.5 -top-1.5 rounded-full bg-gray-800 p-1 text-white opacity-90 shadow transition-colors hover:bg-red-500"
                              >
                                <X size={12} />
                              </button>
                            )}
                          </div>
                        ) : null
                      ))}
                  </div>

                  {/* File Chips */}
                  <div className={`flex min-w-0 max-w-full flex-wrap gap-2 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {message.attachments?.map((file, index) => (
                        !isSupportedImageAttachment({
                          name: file.name,
                          type: file.type
                        }) ? (
                          <div key={file.id || `file-${index}`} className="flex min-w-0 max-w-full items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
                              <FileText size={12} className="flex-shrink-0" />
                              <span className="min-w-0 truncate">{file.name}</span>
                              {canEditAttachments && message.id && onRemoveFailedAttachment && (
                                <button
                                  type="button"
                                  onClick={() => onRemoveFailedAttachment(message.id!, index)}
                                  aria-label={`Remove ${file.name}`}
                                  title={`Remove ${file.name}`}
                                  className="rounded p-0.5 hover:text-red-500"
                                >
                                  <X size={12} />
                                </button>
                              )}
                          </div>
                        ) : null
                      ))}
                  </div>
                  {canEditAttachments && message.id && onReplaceFailedAttachments && (
                    <div className="flex max-w-full flex-col items-end gap-1">
                      <button
                        type="button"
                        onClick={() => replacementInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-[#161b22] dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        <Upload size={13} />
                        Replace attachments
                      </button>
                      <input
                        ref={replacementInputRef}
                        type="file"
                        multiple
                        accept={ATTACHMENT_INPUT_ACCEPT}
                        className="hidden"
                        onChange={handleReplacementSelect}
                      />
                      {attachmentEditError && (
                        <span
                          role="alert"
                          className="max-w-sm text-right text-xs text-red-600 dark:text-red-400"
                        >
                          {attachmentEditError}
                        </span>
                      )}
                    </div>
                  )}
              </div>
          )}

          <div className={`w-full min-w-0 ${message.role === 'user' ? '' : 'space-y-2'}`}>

            {/* Thinking/Reasoning Section */}
            {message.role === 'assistant' && message.thinking && (
                <ThinkingBlock text={message.thinking} durationMs={message.thinkingDuration} />
            )}

            {/* Main Content */}
            <div
                className={`message-content min-w-0 max-w-full rounded-2xl px-5 py-3.5 text-sm leading-relaxed shadow-sm ${
                message.role === 'user'
                    ? 'bg-[#2d3748] text-white rounded-br-none whitespace-pre-wrap'
                    : 'bg-white dark:bg-transparent text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-800 rounded-bl-none shadow-sm dark:shadow-none'
                }`}
            >
                {message.role === 'assistant' ? (
                <div className="markdown-content w-full max-w-full">
                    {isAssistantStreaming && !message.content ? (
                        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                            <Loader2 size={14} className="animate-spin" />
                            <span>Thinking...</span>
                        </div>
                    ) : (
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={markdownComponents}
                    >
                        {message.content}
                    </ReactMarkdown>
                    )}
                </div>
                ) : (
                message.content
                )}
            </div>

            {message.role === 'assistant' && message.status === 'incomplete' && (
                <div
                    role="status"
                    className="flex max-w-full items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                >
                    <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                    <span>{getIncompleteResponseMessage(message.incompleteReason)}</span>
                </div>
            )}

            {/* Sources Chips */}
            {message.role === 'assistant' && message.sources && message.sources.length > 0 && (
                <SourcesBlock sources={message.sources} />
            )}

            {/* Generated File Chips */}
            {message.role === 'assistant' && message.generatedFiles && message.generatedFiles.length > 0 && (
                <GeneratedFilesBlock
                  files={message.generatedFiles}
                  apiKey={apiKey}
                  onDownloadGeneratedFile={onDownloadGeneratedFile || (async () => {
                    throw new Error('Generated-file download is unavailable.');
                  })}
                />
            )}

            {/* Message Metadata Footer */}
            {message.role === 'assistant' && (
                <div className="flex justify-end mt-1.5 items-center gap-1.5 select-none">
                    {canRetry && (
                        <button
                            type="button"
                            onClick={() => onRetryFailedMessage(message.id!)}
                            className="inline-flex h-10 items-center gap-2 rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-[#161b22] px-3 text-xs font-medium text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-200 dark:hover:bg-[#1f2937] hover:text-gray-800 dark:hover:text-gray-100"
                        >
                            <RotateCcw size={15} />
                            <span>Retry</span>
                        </button>
                    )}
                    {canRegenerate && (
                        <button
                            type="button"
                            onClick={onRegenerateResponse}
                            aria-label="Regenerate"
                            className="group relative inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-[#161b22] text-xs font-medium text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-200 dark:hover:bg-[#1f2937] hover:text-gray-800 dark:hover:text-gray-100"
                        >
                            <RefreshCw size={15} />
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-md bg-white px-2 py-1 text-[11px] font-medium text-black opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
                            >
                                Regenerate
                            </span>
                        </button>
                    )}
                    <ResponseDetailsMenu message={message} />
                </div>
            )}
          </div>
      </div>

      {message.role === 'user' && (
        <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0 flex items-center justify-center mt-1">
          <User size={16} className="text-gray-600 dark:text-gray-300" />
        </div>
      )}
    </div>
  );
});

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
  isMobile = false,
  readOnly = false
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

  useLayoutEffect(() => {
    onRetryFailedMessageRef.current = onRetryFailedMessage;
    onRegenerateResponseRef.current = onRegenerateResponse;
  });

  const handleRetryFailedMessage = useCallback((assistantMessageId: string) => {
    onRetryFailedMessageRef.current(assistantMessageId);
  }, []);

  const handleRegenerateResponse = useCallback(() => {
    onRegenerateResponseRef.current();
  }, []);

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
  }, [inputValue]);

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
    const targetDraft = getChatDraft(drafts, sessionId);
    const acceptedFiles: File[] = [];
    const errors: string[] = [];

    files.forEach(file => {
      try {
        validateAttachments([...targetDraft.attachments, ...acceptedFiles, file]);
        acceptedFiles.push(file);
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : `"${file.name}" could not be attached.`
        );
      }
    });

    dispatchDraft({
      type: 'set-attachments',
      sessionId,
      attachments: [...targetDraft.attachments, ...acceptedFiles],
      attachmentError: errors.length > 0 ? errors.join(' ') : null
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  if (!session) {
    return (
      <div className="flex-1 min-w-0 w-full flex flex-col items-center justify-center bg-white dark:bg-[#0d1117] text-gray-500 dark:text-gray-500 transition-colors duration-200">
        <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-800 mb-6 flex items-center justify-center transition-colors">
             <Bot size={32} className="text-blue-600 dark:text-blue-500" />
        </div>
        <p className="text-lg font-medium text-gray-700 dark:text-gray-300">Welcome to OpenAI Studio</p>
        <p className="text-sm mt-2 text-gray-500 dark:text-gray-400">Create a new chat to get started with GPT-5 models.</p>
      </div>
    );
  }

  const canShareConversation = session.messages.length > 0;

  return (
    <div className="flex-1 min-w-0 w-full flex flex-col overflow-hidden bg-white dark:bg-[#0d1117] h-full relative transition-colors duration-200">
      <ConversationHeader
        title={session.title}
        isMobile={isMobile}
        canShareConversation={canShareConversation}
        onShareConversation={onShareConversation}
      />

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
        className="flex-1 min-w-0 w-full overflow-y-auto overflow-x-hidden px-4 py-6 space-y-8"
      >
        {session.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-600 opacity-50">
            <Bot size={48} className="mb-4" />
            <p>Start a conversation...</p>
          </div>
        ) : (
          session.messages.map((msg, idx) => {
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
                onRemoveFailedAttachment={onRemoveFailedAttachment}
                onReplaceFailedAttachments={onReplaceFailedAttachments}
                onRegenerateResponse={handleRegenerateResponse}
              />
            );
          })
        )}
        <div className="h-4" />
      </div>

      {/* Input Area */}
      <div className={`w-full min-w-0 p-4 bg-white dark:bg-[#0d1117] transition-colors ${isMobile ? 'safe-area-bottom' : ''}`}>
        <div className="w-full min-w-0 max-w-4xl mx-auto">
          {attachments.length > 0 && (
              <div className="flex gap-2 mb-2 overflow-x-auto pb-2 flex-wrap">
                  {attachments.map((file, index) => {
                      const isImage = isSupportedImageAttachment(file);

                      return isImage ? (
                          <div key={index} className="relative group" title={file.name}>
                              <DraftImagePreview file={file} />
                              <button
                                  onClick={() => removeAttachment(index)}
                                  disabled={readOnly}
                                  className="absolute -top-1.5 -right-1.5 bg-gray-800 dark:bg-gray-600 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
                              >
                                  <X size={12} />
                              </button>
                          </div>
                      ) : (
                          <div
                              key={index}
                              className="flex items-center gap-2 bg-gray-100 dark:bg-[#1f2937] text-gray-700 dark:text-gray-300 px-3 py-1.5 rounded-full text-xs border border-gray-200 dark:border-gray-700 transition-colors"
                              title={file.name}
                          >
                              <FileText size={12} />
                              <span className="max-w-[100px] truncate">{file.name}</span>
                              <button
                                onClick={() => removeAttachment(index)}
                                disabled={readOnly}
                                className="hover:text-red-500 dark:hover:text-white disabled:cursor-not-allowed"
                              >
                                  <X size={12} />
                              </button>
                          </div>
                      );
                  })}
              </div>
          )}
          {attachmentError && (
            <div
              role="alert"
              className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
            >
              {attachmentError}
            </div>
          )}
          <div className="relative bg-gray-50 dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg focus-within:ring-1 focus-within:ring-blue-500/50 focus-within:border-blue-500 transition-all">
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
              placeholder={readOnly ? 'Read-only while another tab is editing' : 'Ask anything...'}
              className="w-full bg-transparent text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 text-sm px-4 py-3 pr-24 rounded-xl focus:outline-none resize-none max-h-48 min-h-[52px] disabled:cursor-not-allowed disabled:opacity-60"
              rows={1}
              style={{ height: `${PROMPT_INPUT_MIN_HEIGHT_PX}px`, minHeight: `${PROMPT_INPUT_MIN_HEIGHT_PX}px` }}
            />
            
            <div className="absolute right-2 bottom-1.5 flex items-center gap-1">
               <button 
                  onClick={openFilePicker}
                  disabled={readOnly}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  title="Attach file"
               >
                  <Paperclip size={18} />
               </button>
               <input
                  type="file"
                  multiple
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  accept={ATTACHMENT_INPUT_ACCEPT}
                  key={fileInputKey}
                  disabled={readOnly}
               />
               {isLoading ? (
                  <button
                    type="button"
                    onClick={onStopGenerating}
                    disabled={readOnly}
                    className="p-2 rounded-lg transition-all bg-gray-500 text-white hover:bg-gray-600 dark:bg-gray-600 dark:hover:bg-gray-500 shadow-md"
                    title="Stop generating"
                    aria-label="Stop generating"
                  >
                    <Square size={18} />
                  </button>
               ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={readOnly || (!inputValue.trim() && attachments.length === 0)}
                    className={`p-2 rounded-lg transition-all ${
                      readOnly || (!inputValue.trim() && attachments.length === 0)
                        ? 'text-gray-400 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 cursor-not-allowed'
                        : 'bg-blue-600 text-white hover:bg-blue-700 shadow-md'
                    }`}
                  >
                    <Send size={18} />
                  </button>
               )}
            </div>
          </div>
          <ContextWindowUsage session={session} />
        </div>
      </div>
    </div>
  );
};
