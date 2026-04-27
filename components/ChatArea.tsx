
import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { GeneratedFile, Message, Session, Source } from '../types';
import { Send, Bot, User, Paperclip, X, FileText, BrainCircuit, ChevronDown, ChevronRight, Globe, Clock, MoreHorizontal, Copy, Check, AlertCircle, Upload, Download, Loader2, RefreshCw, RotateCcw, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getModelConfig } from '../constants';
import { fetchGeneratedFileContent } from '../services/openaiService';
import { getSourcePresentation } from '../utils/sourceUrls';

interface ChatAreaProps {
  session: Session | null;
  onSendMessage: (content: string, attachments: File[]) => void;
  onStopGenerating: () => void;
  onRetryFailedMessage: (assistantMessageId: string) => void;
  onRegenerateResponse: () => void;
  onShareConversation: () => void;
  apiKey: string;
  isLoading: boolean;
  isMobile?: boolean;
}

const AUTO_SCROLL_THRESHOLD_PX = 120;

const formatDuration = (ms: number): string => {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
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

const ThinkingBlock = ({ text }: { text: string }) => {
  const [isOpen, setIsOpen] = useState(true);

  if (!text) return null;

  return (
    <div className="mb-4 bg-gray-50 dark:bg-[#161b22]/50 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
        <button 
            onClick={() => setIsOpen(!isOpen)}
            className="w-full flex items-center gap-2 p-3 text-xs font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-[#161b22] transition-colors"
        >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <BrainCircuit size={14} />
            <span>Reasoning Process</span>
        </button>
        {isOpen && (
            <div className="p-3 pt-0 text-gray-600 dark:text-gray-400 text-sm font-mono leading-relaxed border-t border-transparent whitespace-pre-wrap">
                {text}
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

    const modelName = message.model ? getModelConfig(message.model).name : null;
    const modelLabel = modelName
        ? `${modelName}${message.reasoningEffort ? ` ${message.reasoningEffort}` : ''}`
        : null;
    const hasThinkingDuration = typeof message.thinkingDuration === 'number' && message.thinkingDuration > 0;
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
    (message.status === 'error' || message.content.startsWith('Error:'))
);

const GeneratedFilesBlock = ({
    files,
    apiKey
}: {
    files: GeneratedFile[];
    apiKey: string;
}) => {
    const [downloadStates, setDownloadStates] = useState<Record<string, 'idle' | 'downloading' | 'error'>>({});

    if (!files || files.length === 0) return null;

    const canDownload = apiKey.trim().length > 0;
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
        if (!canDownload) return;

        const fileKey = getGeneratedFileKey(file, index);
        setDownloadState(fileKey, 'downloading');

        try {
            const blob = await fetchGeneratedFileContent(file, apiKey);
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
                            className={`flex max-w-[260px] items-center gap-2 rounded-full border px-3 py-1.5 text-left transition-colors ${
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
            {!canDownload && (
                <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-500">
                    API key required for download. File IDs remain visible for manual retrieval.
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

export const ChatArea: React.FC<ChatAreaProps> = ({
  session,
  onSendMessage,
  onStopGenerating,
  onRetryFailedMessage,
  onRegenerateResponse,
  onShareConversation,
  apiKey,
  isLoading,
  isMobile = false
}) => {
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isPinnedToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const previousSessionIdRef = useRef<string | null>(null);
  const previousMessageCountRef = useRef(0);
  const latestMessage = session?.messages[session.messages.length - 1];

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

  const handleSend = () => {
    if ((!inputValue.trim() && attachments.length === 0) || isLoading) return;
    isPinnedToBottomRef.current = true;
    onSendMessage(inputValue, attachments);
    setInputValue('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setAttachments(prev => [...prev, ...Array.from(e.target.files!)]);
    }
    setFileInputKey(prev => prev + 1);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
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

    if (files.length > 0) {
      setAttachments(prev => [...prev, ...files]);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-white dark:bg-[#0d1117] text-gray-500 dark:text-gray-500 transition-colors duration-200">
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
    <div className="flex-1 flex flex-col bg-white dark:bg-[#0d1117] h-full relative transition-colors duration-200">
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
        className="flex-1 overflow-y-auto px-4 py-6 space-y-8"
      >
        {session.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-600 opacity-50">
            <Bot size={48} className="mb-4" />
            <p>Start a conversation...</p>
          </div>
        ) : (
          session.messages.map((msg, idx) => {
            const isLatestMessage = idx === session.messages.length - 1;
            const isAssistantError = isFailedAssistantMessage(msg);
            const isAssistantStreaming = msg.status === 'streaming';
            const canRetry = (
                isAssistantError &&
                !isLoading &&
                Boolean(msg.id) &&
                idx > 0 &&
                session.messages[idx - 1]?.role === 'user'
            );
            const canRegenerate = (
                msg.role === 'assistant' &&
                isLatestMessage &&
                !isAssistantError &&
                !isAssistantStreaming &&
                !isLoading &&
                idx > 0 &&
                session.messages[idx - 1]?.role === 'user'
            );

            return (
            <div
              key={msg.id || idx}
              className={`flex gap-4 max-w-4xl mx-auto ${
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-blue-600 flex-shrink-0 flex items-center justify-center mt-1 text-white shadow-sm">
                  <Bot size={16} />
                </div>
              )}

              <div className={`flex flex-col max-w-[85%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  
                  {/* Attachments Section */}
                  {msg.attachments && msg.attachments.length > 0 && (
                      <div className={`flex flex-col gap-2 mb-2 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                          {/* Images Grid */}
                          <div className={`flex flex-wrap gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                              {msg.attachments.filter(a => a.type.startsWith('image/') && a.content).map((file, i) => (
                                  <img 
                                    key={`img-${i}`} 
                                    src={file.content} 
                                    alt={file.name} 
                                    className="max-w-[240px] max-h-[240px] rounded-xl border border-gray-200 dark:border-gray-700 object-cover shadow-sm bg-gray-100 dark:bg-gray-800" 
                                  />
                              ))}
                          </div>
                          
                          {/* File Chips */}
                          <div className={`flex flex-wrap gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                              {msg.attachments.filter(a => !a.type.startsWith('image/')).map((file, i) => (
                                  <div key={`file-${i}`} className="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
                                      <FileText size={12} />
                                      <span>{file.name}</span>
                                  </div>
                              ))}
                          </div>
                      </div>
                  )}

                  <div className={`w-full ${msg.role === 'user' ? '' : 'space-y-2'}`}>
                    
                    {/* Thinking/Reasoning Section */}
                    {msg.role === 'assistant' && msg.thinking && (
                        <ThinkingBlock text={msg.thinking} />
                    )}

                    {/* Main Content */}
                    <div
                        className={`rounded-2xl px-5 py-3.5 text-sm leading-relaxed shadow-sm min-w-0 ${
                        msg.role === 'user'
                            ? 'bg-[#2d3748] text-white rounded-br-none whitespace-pre-wrap'
                            : 'bg-white dark:bg-transparent text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-800 rounded-bl-none shadow-sm dark:shadow-none'
                        }`}
                    >
                        {msg.role === 'assistant' ? (
                        <div className="markdown-content">
                            {isAssistantStreaming && !msg.content ? (
                                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                                    <Loader2 size={14} className="animate-spin" />
                                    <span>Thinking...</span>
                                </div>
                            ) : (
                            <ReactMarkdown 
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    code: ({node, inline, className, children, ...props}: any) => {
                                        const codeBlockLabel = getCodeBlockLabel(className);

                                        return !inline ? (
                                            <div className="my-2 bg-gray-50 dark:bg-black/30 rounded-md overflow-hidden border border-gray-200 dark:border-gray-700/50">
                                                <div className="bg-gray-100 dark:bg-gray-800/50 px-3 py-1 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700/50 font-mono">{codeBlockLabel}</div>
                                                <pre className="p-3 overflow-x-auto text-xs font-mono text-gray-800 dark:text-gray-300">
                                                    <code className={className} {...props}>{children}</code>
                                                </pre>
                                            </div>
                                        ) : (
                                            <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-xs font-mono text-blue-600 dark:text-blue-300" {...props}>
                                                {children}
                                            </code>
                                        )
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
                                }}
                            >
                                {msg.content}
                            </ReactMarkdown>
                            )}
                        </div>
                        ) : (
                        msg.content
                        )}
                    </div>

                    {/* Sources Chips */}
                    {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                        <SourcesBlock sources={msg.sources} />
                    )}

                    {/* Generated File Chips */}
                    {msg.role === 'assistant' && msg.generatedFiles && msg.generatedFiles.length > 0 && (
                        <GeneratedFilesBlock files={msg.generatedFiles} apiKey={apiKey} />
                    )}

                    {/* Message Metadata Footer */}
                    {msg.role === 'assistant' && (
                        <div className="flex justify-end mt-1.5 items-center gap-1.5 select-none">
                            {canRetry && (
                                <button
                                    type="button"
                                    onClick={() => onRetryFailedMessage(msg.id!)}
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
                                    className="inline-flex h-10 items-center gap-2 rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-[#161b22] px-3 text-xs font-medium text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-200 dark:hover:bg-[#1f2937] hover:text-gray-800 dark:hover:text-gray-100"
                                >
                                    <RefreshCw size={15} />
                                    <span>Regenerate</span>
                                </button>
                            )}
                            <ResponseDetailsMenu message={msg} />
                        </div>
                    )}
                  </div>
              </div>
              
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0 flex items-center justify-center mt-1">
                  <User size={16} className="text-gray-600 dark:text-gray-300" />
                </div>
              )}
            </div>
            );
          })
        )}
        <div className="h-4" />
      </div>

      {/* Input Area */}
      <div className={`p-4 bg-white dark:bg-[#0d1117] transition-colors ${isMobile ? 'safe-area-bottom' : ''}`}>
        <div className="max-w-4xl mx-auto">
          {attachments.length > 0 && (
              <div className="flex gap-2 mb-2 overflow-x-auto pb-2 flex-wrap">
                  {attachments.map((file, index) => {
                      const isImage = file.type.startsWith('image/');
                      const imageUrl = isImage ? URL.createObjectURL(file) : null;

                      return isImage ? (
                          <div key={index} className="relative group" title={file.name}>
                              <img
                                  src={imageUrl!}
                                  alt={file.name}
                                  className="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
                                  onLoad={() => URL.revokeObjectURL(imageUrl!)}
                              />
                              <button
                                  onClick={() => removeAttachment(index)}
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
                              <button onClick={() => removeAttachment(index)} className="hover:text-red-500 dark:hover:text-white">
                                  <X size={12} />
                              </button>
                          </div>
                      );
                  })}
              </div>
          )}
          <div className="relative bg-gray-50 dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg focus-within:ring-1 focus-within:ring-blue-500/50 focus-within:border-blue-500 transition-all">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Ask anything..."
              className="w-full bg-transparent text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 text-sm px-4 py-3 pr-24 rounded-xl focus:outline-none resize-none max-h-48 min-h-[52px]"
              rows={1}
              style={{ height: 'auto', minHeight: '52px' }}
              onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
              }}
            />
            
            <div className="absolute right-2 bottom-1.5 flex items-center gap-1">
               <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors"
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
                  key={fileInputKey}
               />
               {isLoading ? (
                  <button
                    type="button"
                    onClick={onStopGenerating}
                    className="p-2 rounded-lg transition-all bg-red-600 text-white hover:bg-red-700 shadow-md"
                    title="Stop generating"
                    aria-label="Stop generating"
                  >
                    <Square size={18} />
                  </button>
               ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!inputValue.trim() && attachments.length === 0}
                    className={`p-2 rounded-lg transition-all ${
                      !inputValue.trim() && attachments.length === 0
                        ? 'text-gray-400 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 cursor-not-allowed'
                        : 'bg-blue-600 text-white hover:bg-blue-700 shadow-md'
                    }`}
                  >
                    <Send size={18} />
                  </button>
               )}
            </div>
          </div>
          <div className="text-center mt-2 text-[10px] text-gray-400 dark:text-gray-600">
              GPT-5 can make mistakes. Consider checking important information.
          </div>
        </div>
      </div>
    </div>
  );
};
