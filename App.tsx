
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Sidebar } from './components/Sidebar';
import { ConfigPanel } from './components/ConfigPanel';
import { ChatArea } from './components/ChatArea';
import { TitleBar } from './components/TitleBar';
import {
  Session,
  ChatConfig,
  FileAttachment,
  GeneratedFile,
  Message,
  DEFAULT_CONFIG,
  SystemInstruction
} from './types';
import {
  fetchGeneratedFileContent,
  generateResponse,
  generateChatTitle
} from './services/openaiService';
import {
  getStorageHandle,
  getActiveStorageBackend,
  subscribeToStorageBackendChanges,
  readJsonFile,
  writeJsonFile,
  readSessions,
  writeSessions,
  storeAttachmentBlob,
  readLocalBlob,
  storeLocalBlob,
  getAttachmentDataUrl,
  readWorkspaceSnapshot,
  synchronizeWorkspaceRevision,
  getWorkspaceRevision,
  WorkspaceRevisionConflictError,
  StorageBackendChoice,
  StorageBackendChoiceRequest,
  STORAGE_FILES,
  AppSettings,
  validateWorkspaceReferences
} from './services/storage';
import {
  BackupArchivePreview,
  BackupArchiveProgress,
  MAX_BACKUP_ARCHIVE_BYTES,
  createWorkspaceArchive,
  inspectWorkspaceArchive,
  UnsupportedLegacyBackupError
} from './services/workspaceArchive';
import {
  restoreWorkspaceArchive,
  undoLastWorkspaceMutation,
  WorkspaceRecoveryAction
} from './services/workspaceRestore';
import { mergeWorkspaceArchive } from './services/workspaceMerge';
import {
  BackupScheduler,
  BackupSchedulerState
} from './services/backupScheduler';
import {
  chooseBackupDestination,
  createManagedBackupFilename,
  loadBackupDestination,
  reconnectBackupDestination,
  supportsAutomaticBackupDestination
} from './services/backupDestination';
import { WorkspaceCoordinator, WorkspaceRole } from './services/workspaceSync';
import {
  SaveQueueFailure,
  VersionedSaveQueue
} from './services/saveQueue';
import {
  OperationRecord,
  OperationRegistry
} from './services/operationRegistry';
import {
  SerializedOperationOptions,
  SerializedOperationQueue
} from './services/serializedOperationQueue';
import {
  buildConversationFilename,
  downloadTextFile,
  formatConversationMarkdown
} from './utils/conversationExport';
import { confirmChatDeletion } from './utils/chatDeletion';
import { getModelConfig, normalizeChatConfig } from './constants';
import { AlertTriangle, Loader2, Menu, RefreshCw, Settings, X } from 'lucide-react';
import { validateAttachments } from './utils/attachmentValidation';

// Hook for detecting mobile viewport
const useIsMobile = (breakpoint = 768) => {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false
  );

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [breakpoint]);

  return isMobile;
};

// Add global declaration for Electron API
declare global {
  interface Window {
    electronAPI?: {
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      isMaximized: () => Promise<boolean>;
      onMaximizedChange: (callback: (isMaximized: boolean) => void) => void;
      writeClipboardText: (text: string) => Promise<void>;
      onCloseRequested: (callback: () => void) => () => void;
      confirmClose: () => void;
      cancelClose: () => void;
      chooseBackupDirectory?: () => Promise<boolean>;
      getBackupDestinationStatus?: () => Promise<
        'connected' | 'permission-required' | 'unavailable'
      >;
      writeBackupArchive?: (
        filename: string,
        readChunk: () => Promise<Uint8Array | null>,
        expectedSize: number,
        expectedSha256: string
      ) => Promise<void>;
      listBackupArchives?: () => Promise<Array<{
        filename: string;
        size: number;
        lastModified: number;
      }>>;
      readBackupArchive?: (filename: string) => Promise<ArrayBuffer>;
      deleteBackupArchive?: (filename: string) => Promise<void>;
    }
  }
}

type SaveKey = 'sessions' | 'instructions' | 'settings';

const SAVE_KEYS: SaveKey[] = ['sessions', 'instructions', 'settings'];
const SAVE_DELAYS: Record<SaveKey, number> = {
  sessions: 1000,
  instructions: 500,
  settings: 500
};
const SESSION_SAVE_MAX_WAIT_MS = 5000;
const SAVE_RETRY_DELAYS_MS = [500, 1500, 5000] as const;
const DEFAULT_BACKUP_STATE: BackupSchedulerState = {
  supported: false,
  enabled: false,
  destinationStatus: 'unavailable',
  running: false,
  backups: []
};

interface PortableBackupFileHandle {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}

type PortableBackupSavePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<PortableBackupFileHandle>;

const downloadBlobFile = (filename: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const revokeAttachmentPreviewUrls = (sessions: Session[]): void => {
  sessions.forEach(session => {
    session.messages.forEach(message => {
      message.attachments?.forEach(attachment => {
        if (attachment.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    });
  });
};

const storeMessageAttachments = async (
  dirHandle: FileSystemDirectoryHandle,
  files: File[]
): Promise<FileAttachment[]> => {
  const formats = validateAttachments(files);
  const storedAttachments = await Promise.all(files.map(async file => ({
    file,
    localBlob: await storeAttachmentBlob(dirHandle, file)
  })));

  return storedAttachments.map(({ file, localBlob }, index) => ({
    localBlob,
    name: file.name,
    type: formats[index].mimeType,
    size: file.size,
    ...(formats[index].kind === 'image'
      ? { previewUrl: URL.createObjectURL(file) }
      : {})
  }));
};

interface ActiveChatRequest {
  controller: AbortController;
  operationId: string;
  assistantMessageId: string;
  getPartialContent?: () => string;
  getPartialThinking?: () => string;
  checkpointPartialContent?: () => string;
  checkpointPartialThinking?: () => string;
}

const isAbortError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();

  return error.name === 'AbortError' || message.includes('abort');
};

const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unknown error'
);

const createOperationAbortError = (): Error => {
  const error = new Error('Operation is no longer current.');
  error.name = 'AbortError';
  return error;
};

const resolveStorageBackendChoice = (
  request: StorageBackendChoiceRequest
): StorageBackendChoice => {
  if (request.kind === 'migration') {
    const shouldMigrate = window.confirm(
      [
        'This workspace is stored in IndexedDB, and OPFS is now available.',
        '',
        'Select OK to copy and verify the entire workspace in OPFS before switching.',
        window.electronAPI
          ? 'The IndexedDB source will be retained. Select Cancel to stop loading without switching stores.'
          : 'The IndexedDB source will be retained. Select Cancel to keep using IndexedDB.'
      ].join('\n')
    );
    return shouldMigrate ? 'migrate-to-opfs' : 'indexeddb';
  }

  const formatSnapshot = (
    label: string,
    snapshot: StorageBackendChoiceRequest['opfs']
  ): string => (
    `${label}: ${snapshot.recordCount} stored record${snapshot.recordCount === 1 ? '' : 's'}` +
    `${snapshot.revision === null ? '' : `, revision ${snapshot.revision}`}`
  );
  const persistedLabel = request.persistedBackend
    ? `The saved backend choice is ${request.persistedBackend === 'opfs' ? 'OPFS' : 'IndexedDB'}, but its workspace is empty.`
    : 'No saved backend choice is available.';
  const useOpfs = window.confirm(
    [
      'Different workspace data was found in OPFS and IndexedDB.',
      persistedLabel,
      formatSnapshot('OPFS', request.opfs),
      formatSnapshot('IndexedDB', request.indexeddb),
      '',
      'No data will be deleted. Select OK to use OPFS or Cancel to use IndexedDB.'
    ].join('\n')
  );
  return useOpfs ? 'opfs' : 'indexeddb';
};

type AssistantModelSnapshot = Required<Pick<
  Message,
  'model' | 'modelName' | 'reasoningEffort'
>>;

const getAssistantModelSnapshot = (session: Session): AssistantModelSnapshot => ({
  model: session.config.model,
  modelName: getModelConfig(session.config.model).name,
  reasoningEffort: session.config.reasoningEffort
});

function App() {
  // Storage State
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);

  // App State
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isWorkspaceLoaded, setIsWorkspaceLoaded] = useState(false);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null);
  const [isWorkspaceReadOnly, setIsWorkspaceReadOnly] = useState(false);
  const [draftWorkspaceEpoch, setDraftWorkspaceEpoch] = useState(0);
  const [saveFailure, setSaveFailure] = useState<SaveQueueFailure<SaveKey> | null>(null);
  const [isRetryingSave, setIsRetryingSave] = useState(false);
  const [closeSaveError, setCloseSaveError] = useState<string | null>(null);
  const [backupState, setBackupState] = useState<BackupSchedulerState>(
    DEFAULT_BACKUP_STATE
  );
  const [backupActionError, setBackupActionError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{
    file: File;
    preview: BackupArchivePreview;
  } | null>(null);
  const [preparedPortableBackup, setPreparedPortableBackup] = useState<{
    file: File;
    canShare: boolean;
  } | null>(null);
  const [archiveProgress, setArchiveProgress] = useState<BackupArchiveProgress | null>(null);
  const [undoWorkspaceAction, setUndoWorkspaceAction] =
    useState<WorkspaceRecoveryAction | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);
  const dirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const isWorkspaceLoadedRef = useRef(false);
  const workspaceCanWriteRef = useRef(false);
  const workspaceCoordinatorRef = useRef<WorkspaceCoordinator | null>(null);
  const workspaceReloadPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const unsubscribeBackendChangesRef = useRef<(() => void) | null>(null);
  const saveQueueRef = useRef<VersionedSaveQueue<SaveKey> | null>(null);
  const backupSchedulerRef = useRef<BackupScheduler | null>(null);
  const archiveAbortRef = useRef<AbortController | null>(null);
  const closeRequestPendingRef = useRef(false);
  const initializationStartedRef = useRef(false);
  const operationRegistryRef = useRef(new OperationRegistry());
  const workspaceMutationBlockedRef = useRef(false);
  const [isWorkspaceMutating, setIsWorkspaceMutating] = useState(false);
  const destructiveOperationQueueRef = useRef<SerializedOperationQueue | null>(null);
  if (!destructiveOperationQueueRef.current) {
    destructiveOperationQueueRef.current = new SerializedOperationQueue(isPending => {
      workspaceMutationBlockedRef.current = isPending;
      setIsWorkspaceMutating(isPending);
    });
  }

  // Replaced single boolean with a Set to track multiple active sessions
  const [processingSessionIds, setProcessingSessionIds] = useState<Set<string>>(new Set());
  const processingSessionIdsRef = useRef<Set<string>>(new Set());
  const activeRequestsRef = useRef<Map<string, ActiveChatRequest>>(new Map());

  const [isDarkMode, setIsDarkMode] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [systemInstructions, setSystemInstructions] = useState<SystemInstruction[]>([]);
  const systemInstructionsRef = useRef<SystemInstruction[]>([]);
  const settingsRef = useRef<AppSettings>({
    theme: 'dark',
    apiKey: ''
  });

  // Mobile responsive state
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);

  // Close mobile panels when switching to desktop
  useEffect(() => {
    if (!isMobile) {
      setIsSidebarOpen(false);
      setIsConfigOpen(false);
    }
  }, [isMobile]);

  useLayoutEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useLayoutEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const updateSessionsState = useCallback((
    update: React.SetStateAction<Session[]>
  ): Session[] => {
    const nextSessions = typeof update === 'function'
      ? update(sessionsRef.current)
      : update;
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    return nextSessions;
  }, []);

  const updateCurrentSessionId = useCallback((sessionId: string | null): void => {
    currentSessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
  }, []);

  useLayoutEffect(() => {
    systemInstructionsRef.current = systemInstructions;
  }, [systemInstructions]);

  useLayoutEffect(() => {
    dirHandleRef.current = dirHandle;
    isWorkspaceLoadedRef.current = isWorkspaceLoaded;
  }, [dirHandle, isWorkspaceLoaded]);

  useLayoutEffect(() => {
    settingsRef.current = {
      theme: isDarkMode ? 'dark' : 'light',
      apiKey,
      lastActiveSessionId: currentSessionId || undefined
    };
  }, [isDarkMode, apiKey, currentSessionId]);

  // Close sidebar when selecting a session on mobile
  const handleSelectSession = useCallback((id: string) => {
    updateCurrentSessionId(id);
    if (isMobile) setIsSidebarOpen(false);
  }, [isMobile, updateCurrentSessionId]);

  const forceImmediateSessionSaveRef = useRef(false);
  const skipNextSessionEffectSaveRef = useRef(false);

  const persistSaveKey = useCallback(async (key: SaveKey): Promise<void> => {
    const handle = dirHandleRef.current;
    if (!handle || !isWorkspaceLoadedRef.current) {
      throw new Error('Workspace storage is unavailable.');
    }
    if (!workspaceCanWriteRef.current) {
      throw new Error('This tab no longer has permission to save the workspace.');
    }

    try {
      let revision: number;
      if (key === 'sessions') {
        revision = await writeSessions(handle, sessionsRef.current);
      } else if (key === 'instructions') {
        revision = await writeJsonFile(
          handle,
          STORAGE_FILES.INSTRUCTIONS,
          systemInstructionsRef.current
        );
      } else {
        revision = await writeJsonFile(handle, STORAGE_FILES.SETTINGS, settingsRef.current);
      }
      workspaceCoordinatorRef.current?.publishUpdate(revision);
      void backupSchedulerRef.current?.evaluate().catch(() => undefined);
    } catch (error) {
      if (error instanceof WorkspaceRevisionConflictError) {
        workspaceCanWriteRef.current = false;
        setIsWorkspaceReadOnly(true);
        workspaceCoordinatorRef.current?.relinquishWriter();
      }
      throw error;
    }
  }, []);

  const getSaveQueue = useCallback((): VersionedSaveQueue<SaveKey> => {
    if (!saveQueueRef.current || saveQueueRef.current.isDisposed) {
      saveQueueRef.current = new VersionedSaveQueue<SaveKey>({
        keys: SAVE_KEYS,
        persist: async key => persistSaveKey(key),
        getDelayMs: (key, dirtyForMs, immediate) => (
          immediate
            ? 0
            : key === 'sessions'
              ? Math.min(
                  SAVE_DELAYS[key],
                  Math.max(0, SESSION_SAVE_MAX_WAIT_MS - dirtyForMs)
                )
              : SAVE_DELAYS[key]
        ),
        retryDelaysMs: SAVE_RETRY_DELAYS_MS,
        onFailure: setSaveFailure,
        onRecovered: () => setSaveFailure(null)
      });
    }
    return saveQueueRef.current;
  }, [persistSaveKey]);

  const scheduleSave = useCallback((key: SaveKey, immediate = false): void => {
    if (
      !dirHandleRef.current ||
      !isWorkspaceLoadedRef.current ||
      !workspaceCanWriteRef.current
    ) {
      return;
    }

    getSaveQueue().markDirty(key, immediate);
  }, [getSaveQueue]);

  const cacheGeneratedFile = useCallback(async (
    generatedFile: GeneratedFile,
    options: {
      sessionId?: string;
      messageId?: string;
      apiKey?: string;
      operation?: OperationRecord;
    } = {}
  ): Promise<Blob> => {
    const handle = dirHandleRef.current;
    if (!handle) throw new Error('Workspace storage is unavailable.');
    if (generatedFile.localBlob) {
      const cached = await readLocalBlob(handle, generatedFile.localBlob);
      if (cached) return cached;
    }

    const apiKey = options.apiKey ?? settingsRef.current.apiKey;
    const blob = await fetchGeneratedFileContent(generatedFile, apiKey, {
      signal: options.operation?.controller.signal
    });
    const typedBlob = !blob.type && generatedFile.mimeType
      ? new Blob([blob], { type: generatedFile.mimeType })
      : blob;
    const localBlob = await storeLocalBlob(
      handle,
      typedBlob,
      generatedFile.mimeType || typedBlob.type
    );
    if (
      options.operation &&
      !operationRegistryRef.current.isCurrent(options.operation)
    ) {
      throw createOperationAbortError();
    }

    let changed = false;
    const nextSessions = sessionsRef.current.map(session => {
      if (options.sessionId && session.id !== options.sessionId) return session;
      let changedSession = false;
      const messages = session.messages.map(message => {
        if (options.messageId && message.id !== options.messageId) return message;
        if (!message.generatedFiles) return message;
        let changedMessage = false;
        const generatedFiles = message.generatedFiles.map(file => {
          if (
            file.containerId !== generatedFile.containerId ||
            file.fileId !== generatedFile.fileId
          ) {
            return file;
          }
          changedMessage = true;
          return { ...file, localBlob };
        });
        if (!changedMessage) return message;
        changedSession = true;
        return { ...message, generatedFiles };
      });
      if (!changedSession) return session;
      changed = true;
      return { ...session, messages, lastModified: Date.now() };
    });
    if (changed && workspaceCanWriteRef.current) {
      forceImmediateSessionSaveRef.current = false;
      updateSessionsState(nextSessions);
      scheduleSave('sessions', true);
    }
    return typedBlob;
  }, [scheduleSave, updateSessionsState]);

  const cacheGeneratedFilesInBackground = useCallback((
    sessionId: string,
    messageId: string,
    files: GeneratedFile[],
    requestApiKey: string
  ): void => {
    files.filter(file => !file.localBlob).forEach(file => {
      const operation = operationRegistryRef.current.begin({
        id: uuidv4(),
        kind: 'generated-file-cache',
        sessionId
      });
      void cacheGeneratedFile(file, {
        sessionId,
        messageId,
        apiKey: requestApiKey,
        operation
      }).catch(error => {
        if (!isAbortError(error)) {
          console.warn(`Generated file ${file.filename} could not be cached.`, error);
        }
      }).finally(() => {
        operationRegistryRef.current.complete(operation);
        const hasPendingCache = operationRegistryRef.current.getOperations()
          .some(item => item.kind === 'generated-file-cache');
        if (!hasPendingCache && workspaceCanWriteRef.current) {
          void getSaveQueue().flush(['sessions'])
            .then(() => backupSchedulerRef.current?.evaluate())
            .catch(() => undefined);
        }
      });
    });
  }, [cacheGeneratedFile, getSaveQueue]);

  const flushPendingSaves = useCallback(async (
    keys: readonly SaveKey[] = SAVE_KEYS
  ): Promise<void> => {
    if (
      !dirHandleRef.current ||
      !isWorkspaceLoadedRef.current ||
      !workspaceCanWriteRef.current
    ) {
      return;
    }

    await getSaveQueue().flush(keys);
  }, [getSaveQueue]);

  const retryPendingSaves = useCallback(async (): Promise<boolean> => {
    if (!workspaceCanWriteRef.current) return false;

    setIsRetryingSave(true);
    try {
      await getSaveQueue().retryNow();
      return true;
    } catch (error) {
      console.error('Failed to retry workspace saves.', error);
      return false;
    } finally {
      setIsRetryingSave(false);
    }
  }, [getSaveQueue]);

  const enqueueDestructiveOperation = useCallback(<T,>(
    operation: () => Promise<T>,
    options?: SerializedOperationOptions
  ): Promise<T> => (
    destructiveOperationQueueRef.current!.enqueue(operation, options)
  ), []);

  const addProcessingSession = (sessionId: string) => {
    processingSessionIdsRef.current.add(sessionId);
    setProcessingSessionIds(new Set(processingSessionIdsRef.current));
  };

  const removeProcessingSession = (sessionId: string) => {
    processingSessionIdsRef.current.delete(sessionId);
    setProcessingSessionIds(new Set(processingSessionIdsRef.current));
  };

  const isOperationCurrent = (
    operation: OperationRecord,
    requireSession = Boolean(operation.sessionId)
  ): boolean => (
    operationRegistryRef.current.isCurrent(operation) &&
    workspaceCanWriteRef.current &&
    (
      !requireSession ||
      !operation.sessionId ||
      sessionsRef.current.some(session => session.id === operation.sessionId)
    )
  );

  const abortActiveRequest = (sessionId: string): ActiveChatRequest | undefined => {
    const activeRequest = activeRequestsRef.current.get(sessionId);
    if (!activeRequest) return undefined;

    activeRequest.controller.abort();
    activeRequestsRef.current.delete(sessionId);
    return activeRequest;
  };

  const invalidateSessionOperations = (
    sessionId: string
  ): ActiveChatRequest | undefined => {
    operationRegistryRef.current.invalidateSession(sessionId);
    const activeRequest = abortActiveRequest(sessionId);
    removeProcessingSession(sessionId);
    return activeRequest;
  };

  const invalidateWorkspaceOperations = (): void => {
    operationRegistryRef.current.invalidateWorkspace();
    activeRequestsRef.current.forEach((_, sessionId) => {
      abortActiveRequest(sessionId);
    });
    activeRequestsRef.current.clear();
    processingSessionIdsRef.current.clear();
    setProcessingSessionIds(new Set());
  };

  const markPendingRequestsFailed = (loadedSessions: Session[]): Session[] => {
    const now = Date.now();
    let hasChanges = false;

    const updatedSessions = loadedSessions.map(session => {
      if (!session.pendingRequest) return session;

      hasChanges = true;
      const interruptedContent = 'Error: Previous request was interrupted and has been marked as failed. Please retry if needed.';
      const modelSnapshot = getAssistantModelSnapshot(session);
      const failureMessage: Message = {
        id: uuidv4(),
        requestId: session.pendingRequest.id,
        role: 'assistant',
        content: interruptedContent,
        status: 'error',
        timestamp: now,
        ...modelSnapshot
      };
      const hasPendingAssistant = Boolean(session.pendingRequest.assistantMessageId);
      const pendingAssistantExists = session.messages.some(message => (
        message.id === session.pendingRequest?.assistantMessageId
      ));
      const messages = hasPendingAssistant && pendingAssistantExists
        ? session.messages.map(message => (
          message.id === session.pendingRequest?.assistantMessageId
            ? {
              ...message,
              content: message.content || interruptedContent,
              status: 'error' as const,
              timestamp: message.timestamp || now
            }
            : message
        ))
        : [...session.messages, failureMessage];

      return {
        ...session,
        pendingRequest: undefined,
        messages,
        lastModified: now
      };
    });

    return hasChanges ? updatedSessions : loadedSessions;
  };

  const normalizeSessionConfigs = (loadedSessions: Session[]): Session[] => {
    let hasChanges = false;
    const normalizedSessions = loadedSessions.map(session => {
      const config = normalizeChatConfig(session.config);
      const isNormalized = (
        session.config?.model === config.model &&
        session.config?.reasoningEffort === config.reasoningEffort &&
        session.config?.textVerbosity === config.textVerbosity &&
        session.config?.tools?.webSearch === config.tools.webSearch &&
        session.config?.tools?.codeInterpreter === config.tools.codeInterpreter
      );

      if (isNormalized) return session;
      hasChanges = true;
      return { ...session, config };
    });

    return hasChanges ? normalizedSessions : loadedSessions;
  };

  // Helper: Load all data from disk
  const loadWorkspaceData = async (
    handle: FileSystemDirectoryHandle,
    role: WorkspaceRole,
    isStillCurrent: () => boolean = () => true
  ) => {
    let loadedSessions: Session[] = [];
    let loadedSettings: AppSettings | null = null;
    let loadedInstructions: SystemInstruction[] | null = null;

    // A reader retries if a broadcast lands while its snapshot is being read.
    // The writer is already protected by the exclusive workspace lock.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revisionBeforeRead = await synchronizeWorkspaceRevision(handle);
      if (!isStillCurrent()) throw createOperationAbortError();
      [loadedSessions, loadedSettings, loadedInstructions] = await Promise.all([
        readSessions(handle, { readOnly: role === 'reader' }),
        readJsonFile(handle, STORAGE_FILES.SETTINGS),
        readJsonFile(handle, STORAGE_FILES.INSTRUCTIONS)
      ]);
      if (!isStillCurrent()) throw createOperationAbortError();
      validateWorkspaceReferences({
        sessions: loadedSessions,
        settings: loadedSettings,
        instructions: loadedInstructions || []
      }, {
        allowDanglingSelections: true
      });
      const revisionAfterRead = await synchronizeWorkspaceRevision(handle);
      if (!isStillCurrent()) throw createOperationAbortError();

      if (role === 'writer' || revisionBeforeRead === revisionAfterRead) break;
    }

    const normalizedSessions = normalizeSessionConfigs(loadedSessions);
    const cleanedSessions = role === 'writer'
      ? markPendingRequestsFailed(normalizedSessions)
      : normalizedSessions;
    const nextInstructions = loadedInstructions || [];
    const nextCurrentSessionId = (
      loadedSettings?.lastActiveSessionId &&
      cleanedSessions.some(session => session.id === loadedSettings.lastActiveSessionId)
    )
      ? loadedSettings.lastActiveSessionId
      : cleanedSessions[0]?.id || null;

    if (!isStillCurrent()) throw createOperationAbortError();
    setDraftWorkspaceEpoch(epoch => epoch + 1);
    revokeAttachmentPreviewUrls(sessionsRef.current);
    sessionsRef.current = cleanedSessions;
    systemInstructionsRef.current = nextInstructions;
    settingsRef.current = {
      theme: loadedSettings?.theme === 'light' ? 'light' : 'dark',
      apiKey: loadedSettings?.apiKey || '',
      lastActiveSessionId: nextCurrentSessionId || undefined
    };
    forceImmediateSessionSaveRef.current = (
      role === 'writer' && cleanedSessions !== loadedSessions
    );

    updateSessionsState(cleanedSessions);
    setSystemInstructions(nextInstructions);
    setIsDarkMode(loadedSettings ? loadedSettings.theme === 'dark' : true);
    setApiKey(loadedSettings?.apiKey || '');
    updateCurrentSessionId(nextCurrentSessionId);
  };

  // 1. Initial Mount: Automatically access storage
  useEffect(() => {
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;

    const init = async () => {
      try {
        const coordinator = await WorkspaceCoordinator.create();
        workspaceCoordinatorRef.current = coordinator;
        let announcedBackend: ReturnType<typeof getActiveStorageBackend> = null;
        unsubscribeBackendChangesRef.current = subscribeToStorageBackendChanges(backend => {
          announcedBackend = backend;
          const activeBackend = getActiveStorageBackend();
          if (
            (
              !activeBackend ||
              activeBackend !== backend
            ) &&
            !workspaceCanWriteRef.current
          ) {
            window.location.reload();
          }
        });
        const handle = await getStorageHandle({
          readOnly: !coordinator.canWrite,
          resolveBackendChoice: coordinator.canWrite
            ? resolveStorageBackendChoice
            : undefined
        });
        const activeBackend = getActiveStorageBackend();
        if (announcedBackend && activeBackend !== announcedBackend) {
          window.location.reload();
          return;
        }
        dirHandleRef.current = handle;
        const initialRole = coordinator.currentRole;
        workspaceCanWriteRef.current = initialRole === 'writer';
        setIsWorkspaceReadOnly(initialRole === 'reader');

        coordinator.subscribeToUpdates(() => {
          if (workspaceCanWriteRef.current || !isWorkspaceLoadedRef.current) return;

          workspaceReloadPromiseRef.current = workspaceReloadPromiseRef.current
            .catch(() => undefined)
            .then(() => loadWorkspaceData(handle, 'reader'))
            .catch(error => {
              console.error('Failed to synchronize workspace changes from another tab.', error);
            });
        });

        coordinator.subscribeToRole(role => {
          workspaceCanWriteRef.current = false;
          setIsWorkspaceReadOnly(true);
          if (role === 'reader') {
            invalidateWorkspaceOperations();
          }
          if (!isWorkspaceLoadedRef.current) return;

          workspaceReloadPromiseRef.current = workspaceReloadPromiseRef.current
            .catch(() => undefined)
            .then(async () => {
              await loadWorkspaceData(handle, role);
              if (role === 'writer' && coordinator.canWrite) {
                workspaceCanWriteRef.current = true;
                setIsWorkspaceReadOnly(false);
                coordinator.publishUpdate(getWorkspaceRevision());
                void backupSchedulerRef.current?.evaluate().catch(() => undefined);
              }
            })
            .catch(error => {
              console.error('Failed to change workspace tab role.', error);
              setWorkspaceLoadError(getErrorMessage(error));
            });
        });

        await loadWorkspaceData(handle, initialRole);
        const roleAfterLoad = coordinator.currentRole;
        if (roleAfterLoad !== initialRole) {
          await loadWorkspaceData(handle, roleAfterLoad);
        }
        workspaceCanWriteRef.current = roleAfterLoad === 'writer';
        setIsWorkspaceReadOnly(roleAfterLoad === 'reader');
        isWorkspaceLoadedRef.current = true;
        setDirHandle(handle);
        setWorkspaceLoadError(null);
        setIsWorkspaceLoaded(true);
        if (roleAfterLoad === 'writer') {
          coordinator.publishUpdate(getWorkspaceRevision());
        }
        try {
          const backupDestination = await loadBackupDestination();
          const backupScheduler = new BackupScheduler({
            dirHandle: handle,
            destination: backupDestination,
            supported: supportsAutomaticBackupDestination(),
            canRun: () => (
              workspaceCanWriteRef.current &&
              !workspaceMutationBlockedRef.current &&
              activeRequestsRef.current.size === 0 &&
              operationRegistryRef.current.getOperations().length === 0
            ),
            onStateChange: setBackupState
          });
          backupSchedulerRef.current?.dispose();
          backupSchedulerRef.current = backupScheduler;
          await backupScheduler.initialize();
        } catch (backupError) {
          console.error('Backup scheduling could not be initialized.', backupError);
          const message = getErrorMessage(backupError);
          setBackupActionError(message);
          if (!backupSchedulerRef.current) {
            setBackupState({
              ...DEFAULT_BACKUP_STATE,
              supported: supportsAutomaticBackupDestination(),
              error: message
            });
          }
        }
      } catch (e) {
        console.error("Critical: Failed to initialize storage", e);
        dirHandleRef.current = null;
        isWorkspaceLoadedRef.current = false;
        setDirHandle(null);
        setIsWorkspaceLoaded(false);
        workspaceCanWriteRef.current = false;
        setWorkspaceLoadError(getErrorMessage(e));
      } finally {
        // Add a small artificial delay to ensure smooth transition from the HTML loader
        // if the OPFS loads extremely fast.
        setTimeout(() => setIsInitializing(false), 300);
      }
    };
    init();
  }, []);

  // Effect: Persist Sessions
  useEffect(() => {
    if (skipNextSessionEffectSaveRef.current) {
      skipNextSessionEffectSaveRef.current = false;
      return;
    }

    const immediate = forceImmediateSessionSaveRef.current;
    forceImmediateSessionSaveRef.current = false;
    scheduleSave('sessions', immediate);
  }, [sessions, dirHandle, isWorkspaceLoaded, scheduleSave]);

  // Effect: Persist Instructions
  useEffect(() => {
    scheduleSave('instructions');
  }, [systemInstructions, dirHandle, isWorkspaceLoaded, scheduleSave]);

  // Effect: Persist Settings (Theme, API Key, Active Session)
  useEffect(() => {
    scheduleSave('settings');
  }, [isDarkMode, apiKey, currentSessionId, dirHandle, isWorkspaceLoaded, scheduleSave]);

  useEffect(() => {
    if (!isWorkspaceLoaded) return;

    const flushForLifecycle = () => {
      let hasStreamingChanges = false;
      const checkpointedSessions = sessionsRef.current.map(session => {
        const activeRequest = activeRequestsRef.current.get(session.id);
        const partialContent = activeRequest?.checkpointPartialContent?.() ||
          activeRequest?.getPartialContent?.();
        const partialThinking = activeRequest?.checkpointPartialThinking?.() ||
          activeRequest?.getPartialThinking?.();
        if (!activeRequest || (!partialContent && !partialThinking)) return session;

        let didUpdateMessage = false;
        const messages = session.messages.map(message => {
          if (
            message.id !== activeRequest.assistantMessageId ||
            (
              message.content === partialContent &&
              (message.thinking || '') === (partialThinking || '')
            )
          ) {
            return message;
          }

          didUpdateMessage = true;
          return {
            ...message,
            content: partialContent || message.content,
            thinking: partialThinking || message.thinking,
            status: 'streaming' as const
          };
        });
        if (!didUpdateMessage) return session;

        hasStreamingChanges = true;
        return {
          ...session,
          messages,
          lastModified: Date.now()
        };
      });

      if (hasStreamingChanges) {
        sessionsRef.current = checkpointedSessions;
        forceImmediateSessionSaveRef.current = false;
        skipNextSessionEffectSaveRef.current = true;
        updateSessionsState(checkpointedSessions);
        scheduleSave('sessions', true);
      }

      void flushPendingSaves().catch(error => {
        console.error('Failed to flush workspace data before suspension.', error);
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushForLifecycle();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', flushForLifecycle);
    window.addEventListener('beforeunload', flushForLifecycle);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', flushForLifecycle);
      window.removeEventListener('beforeunload', flushForLifecycle);
    };
  }, [flushPendingSaves, isWorkspaceLoaded, scheduleSave]);

  useEffect(() => {
    if (!isWorkspaceLoaded) return;
    const evaluateBackup = () => {
      if (document.visibilityState === 'visible') {
        void backupSchedulerRef.current?.evaluate().catch(() => undefined);
      }
    };
    window.addEventListener('focus', evaluateBackup);
    window.addEventListener('pageshow', evaluateBackup);
    document.addEventListener('visibilitychange', evaluateBackup);
    return () => {
      window.removeEventListener('focus', evaluateBackup);
      window.removeEventListener('pageshow', evaluateBackup);
      document.removeEventListener('visibilitychange', evaluateBackup);
    };
  }, [isWorkspaceLoaded]);


  // --- App Logic ---

  const currentSession = sessions.find(s => s.id === currentSessionId) || null;

  const createNewSession = () => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current
    ) {
      return;
    }

    const configToUse = currentSession ? { ...currentSession.config } : { ...DEFAULT_CONFIG };
    
    const newSession: Session = {
      id: uuidv4(),
      title: 'New Chat',
      messages: [],
      config: configToUse,
      lastModified: Date.now(),
    };
    updateSessionsState(prev => [newSession, ...prev]);
    updateCurrentSessionId(newSession.id);
  };

  const deleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current
    ) {
      return;
    }

    const deletedSession = sessionsRef.current.find(session => session.id === id);
    if (!deletedSession || !confirmChatDeletion()) return;

    invalidateSessionOperations(id);
    const operation = operationRegistryRef.current.begin({
      id: uuidv4(),
      kind: 'delete-session',
      sessionId: id
    });
    const newSessions = sessionsRef.current.filter(session => session.id !== id);
    forceImmediateSessionSaveRef.current = true;
    updateSessionsState(newSessions);
    revokeAttachmentPreviewUrls([deletedSession]);
    if (currentSessionIdRef.current === id) {
      updateCurrentSessionId(newSessions[0]?.id || null);
    }
    scheduleSave('sessions', true);

    void enqueueDestructiveOperation(async () => {
      try {
        if (
          !operationRegistryRef.current.isCurrent(operation) ||
          !workspaceCanWriteRef.current
        ) {
          return;
        }
        await flushPendingSaves(['sessions']);
      } finally {
        operationRegistryRef.current.complete(operation);
      }
    }, { blocksInteractions: false }).catch(error => {
      console.error('Failed to persist chat deletion.', error);
    });
  };

  const updateConfig = (newConfig: ChatConfig) => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current ||
      !currentSessionIdRef.current
    ) {
      return;
    }
    const targetSessionId = currentSessionIdRef.current;
    updateSessionsState(prev => prev.map(s =>
      s.id === targetSessionId ? { ...s, config: newConfig } : s
    ));
  };

  const handleCreateSystemInstruction = () => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current
    ) {
      return;
    }

    const newId = uuidv4();
    const newInstruction: SystemInstruction = {
      id: newId,
      title: 'Untitled instruction',
      content: ''
    };
    setSystemInstructions(prev => [...prev, newInstruction]);
    if (currentSessionId) {
      updateConfig({ ...currentSession!.config, systemInstructionId: newId });
    }
  };

  const handleUpdateSystemInstruction = (updated: SystemInstruction) => {
      if (
        !workspaceCanWriteRef.current ||
        workspaceMutationBlockedRef.current
      ) {
        return;
      }
      setSystemInstructions(prev => prev.map(si => si.id === updated.id ? updated : si));
  };

  const handleDeleteSystemInstruction = (id: string) => {
      if (
        !workspaceCanWriteRef.current ||
        workspaceMutationBlockedRef.current
      ) {
        return;
      }
      setSystemInstructions(prev => prev.filter(si => si.id !== id));
      if (currentSession && currentSession.config.systemInstructionId === id) {
          updateConfig({ ...currentSession.config, systemInstructionId: undefined });
      }
  };

  const createAssistantPlaceholder = (
    id: string,
    requestId: string,
    modelSnapshot: AssistantModelSnapshot,
    timestamp: number
  ): Message => ({
    id,
    requestId,
    role: 'assistant',
    content: '',
    status: 'streaming',
    timestamp,
    ...modelSnapshot
  });

  const updateAssistantMessage = (
    sessionId: string,
    assistantMessageId: string,
    updateMessage: (message: Message) => Message,
    clearPendingRequest = false
  ) => {
    if (!workspaceCanWriteRef.current) return;

    const now = Date.now();

    if (clearPendingRequest) {
      forceImmediateSessionSaveRef.current = true;
    }

    updateSessionsState(prev => prev.map(s => {
      if (s.id !== sessionId) return s;

      return {
        ...s,
        messages: s.messages.map(message => (
          message.id === assistantMessageId ? updateMessage(message) : message
        )),
        lastModified: now,
        pendingRequest: clearPendingRequest ? undefined : s.pendingRequest
      };
    }));
  };

  const markAssistantStopped = (
    sessionId: string,
    assistantMessageId: string,
    partialContent?: string,
    partialThinking?: string
  ) => {
    updateAssistantMessage(
      sessionId,
      assistantMessageId,
      message => ({
        ...message,
        content: partialContent || message.content || 'Stopped.',
        thinking: partialThinking || message.thinking,
        status: 'stopped',
        timestamp: Date.now()
      }),
      true
    );
  };

  const startAssistantResponse = async ({
    operation,
    targetSessionId,
    session,
    messagesForApi,
    requestId,
    assistantMessageId,
    modelSnapshot
  }: {
    operation: OperationRecord;
    targetSessionId: string;
    session: Session;
    messagesForApi: Message[];
    requestId: string;
    assistantMessageId: string;
    modelSnapshot: AssistantModelSnapshot;
  }) => {
    const controller = operation.controller;
    const currentSession = sessionsRef.current.find(item => item.id === targetSessionId);
    if (
      !isOperationCurrent(operation) ||
      !currentSession?.messages.some(message => message.id === assistantMessageId)
    ) {
      operationRegistryRef.current.complete(operation);
      removeProcessingSession(targetSessionId);
      return;
    }

    activeRequestsRef.current.set(targetSessionId, {
      controller,
      operationId: operation.id,
      assistantMessageId
    });
    const matchesActiveRequest = (
      request: ActiveChatRequest | undefined
    ): request is ActiveChatRequest => (
      request?.operationId === operation.id &&
      request.assistantMessageId === assistantMessageId
    );

    // Streamed deltas flush once per animation frame while visible and on a
    // short timer while hidden, where animation frames may be suspended.
    let streamedContent = '';
    let streamedThinking = '';
    let pendingDelta = '';
    let pendingThinkingDelta = '';
    let deltaFlushHandle: number | null = null;
    let deltaFlushUsesTimeout = false;
    const activeRequest = activeRequestsRef.current.get(targetSessionId);
    if (matchesActiveRequest(activeRequest)) {
      activeRequest.getPartialContent = () => streamedContent + pendingDelta;
      activeRequest.getPartialThinking = () => streamedThinking + pendingThinkingDelta;
    }

    const cancelScheduledDeltaFlush = () => {
      if (deltaFlushHandle !== null) {
        if (deltaFlushUsesTimeout) window.clearTimeout(deltaFlushHandle);
        else window.cancelAnimationFrame(deltaFlushHandle);
        deltaFlushHandle = null;
        deltaFlushUsesTimeout = false;
      }
    };

    const checkpointPendingDeltas = () => {
      cancelScheduledDeltaFlush();
      streamedContent += pendingDelta;
      streamedThinking += pendingThinkingDelta;
      pendingDelta = '';
      pendingThinkingDelta = '';
    };

    const flushPendingDeltas = () => {
      const hasContentDelta = pendingDelta.length > 0;
      const hasThinkingDelta = pendingThinkingDelta.length > 0;
      if (!hasContentDelta && !hasThinkingDelta) return;

      checkpointPendingDeltas();
      const content = streamedContent;
      const thinking = streamedThinking;

      updateAssistantMessage(
        targetSessionId,
        assistantMessageId,
        message => ({
          ...message,
          content: hasContentDelta ? content : message.content,
          thinking: hasThinkingDelta ? thinking : message.thinking,
          status: 'streaming'
        })
      );
    };

    if (matchesActiveRequest(activeRequest)) {
      activeRequest.checkpointPartialContent = () => {
        checkpointPendingDeltas();
        return streamedContent;
      };
      activeRequest.checkpointPartialThinking = () => {
        checkpointPendingDeltas();
        return streamedThinking;
      };
    }

    const scheduleDeltaFlush = () => {
      if (deltaFlushHandle !== null) return;

      const runDeltaFlush = () => {
        deltaFlushHandle = null;
        deltaFlushUsesTimeout = false;

        // Skip when the request was stopped meanwhile; the catch path
        // flushes the remainder before marking the message stopped.
        const flushRequest = activeRequestsRef.current.get(targetSessionId);
        if (
          !matchesActiveRequest(flushRequest) ||
          !isOperationCurrent(operation)
        ) {
          return;
        }

        flushPendingDeltas();
      };

      if (document.visibilityState === 'hidden') {
        deltaFlushUsesTimeout = true;
        deltaFlushHandle = window.setTimeout(runDeltaFlush, 100);
      } else {
        deltaFlushHandle = window.requestAnimationFrame(runDeltaFlush);
      }
    };

    try {
      const selectedInstruction = systemInstructionsRef.current.find(si => (
        si.id === session.config.systemInstructionId
      ));
      const systemInstructionContent = selectedInstruction ? selectedInstruction.content : undefined;

      const {
        content: responseText,
        thinking,
        refusal,
        status: responseStatus,
        incompleteReason,
        sources,
        generatedFiles,
        thinkingDuration,
        responseId,
        usage
      } = await generateResponse(
        messagesForApi,
        session.config,
        apiKey,
        systemInstructionContent,
        {
          signal: controller.signal,
          onReasoningSummaryDelta: (delta) => {
            const activeRequest = activeRequestsRef.current.get(targetSessionId);

            if (
              !matchesActiveRequest(activeRequest) ||
              !isOperationCurrent(operation)
            ) {
              return;
            }

            pendingThinkingDelta += delta;
            scheduleDeltaFlush();
          },
          onTextDelta: (delta) => {
            const activeRequest = activeRequestsRef.current.get(targetSessionId);

            if (
              !matchesActiveRequest(activeRequest) ||
              !isOperationCurrent(operation)
            ) {
              return;
            }

            pendingDelta += delta;
            scheduleDeltaFlush();
          },
          resolveAttachmentContent: async attachment => {
            const handle = dirHandleRef.current;
            if (!handle) throw new Error('Workspace storage is unavailable.');
            const content = await getAttachmentDataUrl(handle, attachment);
            if (!isOperationCurrent(operation)) throw createOperationAbortError();
            return content;
          }
        }
      );

      const completedRequest = activeRequestsRef.current.get(targetSessionId);
      if (
        !matchesActiveRequest(completedRequest) ||
        !isOperationCurrent(operation) ||
        !sessionsRef.current.some(item => item.id === targetSessionId)
      ) {
        cancelScheduledDeltaFlush();
        pendingDelta = '';
        pendingThinkingDelta = '';
        return;
      }

      // The terminal event carries the authoritative full output; drop any unflushed tail.
      cancelScheduledDeltaFlush();
      pendingDelta = '';
      pendingThinkingDelta = '';

      const newBotMessage: Message = {
        id: assistantMessageId,
        requestId,
        role: 'assistant',
        content: responseText,
        status: responseStatus,
        openaiResponseId: responseId,
        thinking,
        refusal,
        incompleteReason,
        thinkingDuration,
        usage,
        sources,
        generatedFiles,
        timestamp: Date.now(),
        ...modelSnapshot
      };

      updateAssistantMessage(
        targetSessionId,
        assistantMessageId,
        () => newBotMessage,
        true
      );
      if (generatedFiles?.length) {
        cacheGeneratedFilesInBackground(
          targetSessionId,
          assistantMessageId,
          generatedFiles,
          apiKey
        );
      }
    } catch (error) {
      const failedRequest = activeRequestsRef.current.get(targetSessionId);
      if (
        !matchesActiveRequest(failedRequest) ||
        !isOperationCurrent(operation) ||
        !sessionsRef.current.some(item => item.id === targetSessionId)
      ) {
        cancelScheduledDeltaFlush();
        pendingDelta = '';
        pendingThinkingDelta = '';
        return;
      }

      // Flush tokens received before the stop or failure so partial output survives.
      flushPendingDeltas();

      if (isAbortError(error)) {
        markAssistantStopped(targetSessionId, assistantMessageId);
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

        updateAssistantMessage(
          targetSessionId,
          assistantMessageId,
          message => ({
            ...message,
            content: message.content
              ? `${message.content}\n\nError: ${errorMessage}`
              : `Error: ${errorMessage}`,
            status: 'error',
            timestamp: Date.now(),
            ...modelSnapshot
          }),
          true
        );
      }
    } finally {
      const activeRequest = activeRequestsRef.current.get(targetSessionId);

      if (matchesActiveRequest(activeRequest)) {
        activeRequestsRef.current.delete(targetSessionId);
        removeProcessingSession(targetSessionId);
      } else if (!activeRequest) {
        removeProcessingSession(targetSessionId);
      }
      operationRegistryRef.current.complete(operation);
      if (
        !operationRegistryRef.current.getOperations()
          .some(item => item.kind === 'generated-file-cache')
      ) {
        void flushPendingSaves(['sessions'])
          .then(() => backupSchedulerRef.current?.evaluate())
          .catch(() => undefined);
      }
    }
  };

  const runChatTitleGeneration = async (
    operation: OperationRecord,
    targetSessionId: string,
    titlePrompt: string
  ): Promise<void> => {
    try {
      const newTitle = await generateChatTitle(
        titlePrompt,
        apiKey,
        { signal: operation.controller.signal }
      );
      if (!isOperationCurrent(operation)) return;

      updateSessionsState(prev => prev.map(session => (
        session.id === targetSessionId
          ? { ...session, title: newTitle }
          : session
      )));
    } catch (error) {
      if (!isAbortError(error)) {
        console.warn('Failed to apply generated chat title:', error);
      }
    } finally {
      operationRegistryRef.current.complete(operation);
    }
  };

  const handleSendMessage = async (
    targetSessionId: string,
    content: string,
    attachments: File[]
  ) => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current
    ) {
      return false;
    }

    if (processingSessionIdsRef.current.has(targetSessionId)) return false;
    const initialSession = sessionsRef.current.find(s => s.id === targetSessionId);
    if (!initialSession) return false;
    const handle = dirHandleRef.current;
    if (!handle) return false;

    const requestId = uuidv4();
    const userMessageId = uuidv4();
    const assistantMessageId = uuidv4();
    const requestTimestamp = Date.now();
    const operation = operationRegistryRef.current.begin({
      id: requestId,
      kind: 'response',
      sessionId: targetSessionId
    });
    addProcessingSession(targetSessionId);
    let didStartResponse = false;

    try {
      const processedAttachments = await storeMessageAttachments(handle, attachments);
      if (!isOperationCurrent(operation)) {
        processedAttachments.forEach(attachment => {
          if (attachment.previewUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        });
        throw createOperationAbortError();
      }
      const session = sessionsRef.current.find(s => s.id === targetSessionId);
      if (!session) throw createOperationAbortError();

      const newUserMessage: Message = {
        id: userMessageId,
        requestId,
        role: 'user',
        content,
        timestamp: requestTimestamp,
        ...(processedAttachments.length > 0
          ? { attachments: processedAttachments }
          : {})
      };
      const modelSnapshot = getAssistantModelSnapshot(session);
      const assistantPlaceholder = createAssistantPlaceholder(
        assistantMessageId,
        requestId,
        modelSnapshot,
        requestTimestamp
      );

      // 1. Optimistically update UI with user message + pending request marker
      forceImmediateSessionSaveRef.current = true;
      updateSessionsState(prev => prev.map(s => {
        if (s.id === targetSessionId) {
          return {
            ...s,
            messages: [...s.messages, newUserMessage, assistantPlaceholder],
            lastModified: requestTimestamp,
            pendingRequest: {
              id: requestId,
              userMessageId,
              assistantMessageId,
              createdAt: requestTimestamp
            },
            title: s.messages.length === 0 ? (content.slice(0, 30) + (content.length > 30 ? '...' : '')) : s.title
          };
        }
        return s;
      }));

      if (session.messages.length === 0) {
        const titlePrompt = content || (
          attachments.length > 0
            ? `File analysis of ${attachments[0].name}`
            : 'New Chat'
        );
        const titleOperation = operationRegistryRef.current.begin({
          id: uuidv4(),
          kind: 'title',
          sessionId: targetSessionId
        });
        void runChatTitleGeneration(titleOperation, targetSessionId, titlePrompt);
      }

      // 2. Perform API Call Detached from current UI State
      const messagesForApi = [...session.messages, newUserMessage];
      didStartResponse = true;
      void startAssistantResponse({
        operation,
        targetSessionId,
        session,
        messagesForApi,
        requestId,
        assistantMessageId,
        modelSnapshot
      });
      return true;

    } catch (error) {
      if (!isOperationCurrent(operation) || isAbortError(error)) {
        return false;
      }

      forceImmediateSessionSaveRef.current = true;
      const failedSession = sessionsRef.current.find(s => s.id === targetSessionId);
      if (!failedSession) return false;
      const errorMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        status: 'error',
        timestamp: Date.now(),
        ...getAssistantModelSnapshot(failedSession)
      };
      updateSessionsState(prev => prev.map(s => {
        if (s.id === targetSessionId) {
          return {
            ...s,
            messages: [...s.messages, errorMessage],
            lastModified: Date.now(),
            pendingRequest: undefined
          };
        }
        return s;
      }));
      return false;
    } finally {
      if (!didStartResponse) {
        operationRegistryRef.current.complete(operation);
        removeProcessingSession(targetSessionId);
      }
    }
  };

  const restartAssistantResponse = async (assistantMessageIndex: number) => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current ||
      !currentSessionIdRef.current
    ) {
      return;
    }

    const targetSessionId = currentSessionIdRef.current;
    if (processingSessionIdsRef.current.has(targetSessionId)) return;

    const session = sessionsRef.current.find(s => s.id === targetSessionId);
    if (!session) return;

    const assistantMessage = session.messages[assistantMessageIndex];
    const userMessage = session.messages[assistantMessageIndex - 1];

    if (
      assistantMessageIndex < 1 ||
      assistantMessageIndex !== session.messages.length - 1 ||
      assistantMessage?.role !== 'assistant' ||
      userMessage?.role !== 'user'
    ) {
      return;
    }

    const requestId = userMessage.requestId || assistantMessage.requestId || uuidv4();
    const userMessageId = userMessage.id || uuidv4();
    const newAssistantMessageId = uuidv4();
    const requestTimestamp = Date.now();
    const messagesForApi = session.messages.slice(0, assistantMessageIndex).map((message, index) => (
      index === assistantMessageIndex - 1 && !message.id
        ? { ...message, id: userMessageId }
        : message
    ));
    const modelSnapshot = getAssistantModelSnapshot(session);
    const assistantPlaceholder = createAssistantPlaceholder(
      newAssistantMessageId,
      requestId,
      modelSnapshot,
      requestTimestamp
    );
    const operation = operationRegistryRef.current.begin({
      id: uuidv4(),
      kind: 'response',
      sessionId: targetSessionId
    });

    addProcessingSession(targetSessionId);
    forceImmediateSessionSaveRef.current = true;

    updateSessionsState(prev => prev.map(s => {
      if (s.id !== targetSessionId) return s;

      return {
        ...s,
        messages: [...messagesForApi, assistantPlaceholder],
        lastModified: requestTimestamp,
        pendingRequest: {
          id: requestId,
          userMessageId,
          assistantMessageId: newAssistantMessageId,
          createdAt: requestTimestamp
        }
      };
    }));

    await startAssistantResponse({
      operation,
      targetSessionId,
      session,
      messagesForApi,
      requestId,
      assistantMessageId: newAssistantMessageId,
      modelSnapshot
    });
  };

  const handleRetryFailedMessage = async (assistantMessageId: string) => {
    const session = sessionsRef.current.find(
      s => s.id === currentSessionIdRef.current
    );
    const assistantMessageIndex = session?.messages.findIndex(message => (
      message.id === assistantMessageId
    ));

    if (assistantMessageIndex === undefined) return;
    await restartAssistantResponse(assistantMessageIndex);
  };

  const handleRemoveFailedAttachment = (
    userMessageId: string,
    attachmentIndex: number
  ) => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current ||
      !currentSessionIdRef.current
    ) {
      return;
    }

    const targetSessionId = currentSessionIdRef.current;
    const session = sessionsRef.current.find(item => item.id === targetSessionId);
    const lastMessage = session?.messages[session.messages.length - 1];
    const userMessage = session?.messages[session.messages.length - 2];
    if (
      lastMessage?.role !== 'assistant' ||
      lastMessage.status !== 'error' ||
      userMessage?.role !== 'user' ||
      userMessage.id !== userMessageId
    ) {
      return;
    }

    const removedAttachment = userMessage.attachments?.[attachmentIndex];
    forceImmediateSessionSaveRef.current = true;
    updateSessionsState(prev => prev.map(item => {
      if (item.id !== targetSessionId) return item;

      return {
        ...item,
        messages: item.messages.map(message => (
          message.id === userMessageId
            ? {
                ...message,
                attachments: message.attachments?.filter(
                  (_, index) => index !== attachmentIndex
                )
              }
            : message
        )),
        lastModified: Date.now()
      };
    }));

    if (removedAttachment?.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(removedAttachment.previewUrl);
    }
  };

  const handleReplaceFailedAttachments = async (
    userMessageId: string,
    files: File[]
  ): Promise<string | undefined> => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current ||
      !currentSessionIdRef.current
    ) {
      return 'This workspace is read-only.';
    }

    const targetSessionId = currentSessionIdRef.current;
    const session = sessionsRef.current.find(item => item.id === targetSessionId);
    const lastMessage = session?.messages[session.messages.length - 1];
    const userMessage = session?.messages[session.messages.length - 2];
    if (
      lastMessage?.role !== 'assistant' ||
      lastMessage.status !== 'error' ||
      userMessage?.role !== 'user' ||
      userMessage.id !== userMessageId
    ) {
      return 'This failed turn is no longer available to edit.';
    }

    try {
      const handle = dirHandleRef.current;
      if (!handle) throw new Error('Workspace storage is unavailable.');
      const operation = operationRegistryRef.current.begin({
        id: uuidv4(),
        kind: 'attachment-replacement',
        sessionId: targetSessionId
      });

      try {
        const replacementAttachments = await storeMessageAttachments(handle, files);
        const currentTarget = sessionsRef.current.find(item => item.id === targetSessionId);
        const currentLastMessage = currentTarget?.messages[currentTarget.messages.length - 1];
        const currentUserMessage = currentTarget?.messages[currentTarget.messages.length - 2];
        if (
          !isOperationCurrent(operation) ||
          currentLastMessage?.role !== 'assistant' ||
          currentLastMessage.status !== 'error' ||
          currentUserMessage?.role !== 'user' ||
          currentUserMessage.id !== userMessageId
        ) {
          replacementAttachments.forEach(attachment => {
            if (attachment.previewUrl?.startsWith('blob:')) {
              URL.revokeObjectURL(attachment.previewUrl);
            }
          });
          return 'This failed turn is no longer available to edit.';
        }

        forceImmediateSessionSaveRef.current = true;
        updateSessionsState(prev => prev.map(item => {
          if (item.id !== targetSessionId) return item;

          return {
            ...item,
            messages: item.messages.map(message => (
              message.id === userMessageId
                ? { ...message, attachments: replacementAttachments }
                : message
            )),
            lastModified: Date.now()
          };
        }));
        userMessage.attachments?.forEach(attachment => {
          if (attachment.previewUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        });
        return undefined;
      } finally {
        operationRegistryRef.current.complete(operation);
      }
    } catch (error) {
      return getErrorMessage(error);
    }
  };

  const handleRegenerateLatestResponse = async () => {
    const session = sessionsRef.current.find(
      s => s.id === currentSessionIdRef.current
    );
    await restartAssistantResponse((session?.messages.length ?? 0) - 1);
  };

  const handleStopGenerating = () => {
    if (!workspaceCanWriteRef.current || !currentSessionIdRef.current) return;

    const targetSessionId = currentSessionIdRef.current;
    const activeRequest = activeRequestsRef.current.get(targetSessionId);
    const partialContent = activeRequest?.checkpointPartialContent?.() ||
      activeRequest?.getPartialContent?.();
    const partialThinking = activeRequest?.checkpointPartialThinking?.() ||
      activeRequest?.getPartialThinking?.();
    const responseOperations = operationRegistryRef.current.getSessionOperations(
      targetSessionId
    ).filter(operation => operation.kind === 'response');
    if (!activeRequest && responseOperations.length === 0) return;

    operationRegistryRef.current.abortWhere(operation => (
      operation.sessionId === targetSessionId &&
      operation.kind === 'response'
    ));
    abortActiveRequest(targetSessionId);
    removeProcessingSession(targetSessionId);
    if (activeRequest) {
      markAssistantStopped(
        targetSessionId,
        activeRequest.assistantMessageId,
        partialContent,
        partialThinking
      );
    }
  };

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.onCloseRequested) return;

    const unsubscribe = electronApi.onCloseRequested(() => {
      if (closeRequestPendingRef.current) return;
      closeRequestPendingRef.current = true;
      setCloseSaveError(null);

      const activeRequests = new Map(activeRequestsRef.current);
      const now = Date.now();
      operationRegistryRef.current.invalidateWorkspace();

      activeRequests.forEach(request => {
        request.controller.abort();
      });
      activeRequestsRef.current.clear();
      processingSessionIdsRef.current.clear();
      setProcessingSessionIds(new Set());

      if (activeRequests.size > 0) {
        const stoppedSessions = sessionsRef.current.map(session => {
          const activeRequest = activeRequests.get(session.id);
          if (!activeRequest) return session;

          return {
            ...session,
            messages: session.messages.map(message => (
              message.id === activeRequest.assistantMessageId
                ? {
                    ...message,
                    content: activeRequest.checkpointPartialContent?.() ||
                      activeRequest.getPartialContent?.() ||
                      message.content ||
                      'Stopped.',
                    thinking: activeRequest.checkpointPartialThinking?.() ||
                      activeRequest.getPartialThinking?.() ||
                      message.thinking,
                    status: 'stopped' as const,
                    timestamp: now
                  }
                : message
            )),
            pendingRequest: undefined,
            lastModified: now
          };
        });

        sessionsRef.current = stoppedSessions;
        forceImmediateSessionSaveRef.current = false;
        skipNextSessionEffectSaveRef.current = true;
        updateSessionsState(stoppedSessions);
        scheduleSave('sessions', true);
      }

      void flushPendingSaves()
        .then(() => backupSchedulerRef.current?.runDueForClose())
        .then(() => electronApi.confirmClose())
        .catch(error => {
          console.error('Failed to save or back up the workspace before closing.', error);
          setCloseSaveError(getErrorMessage(error));
        });
    });

    return unsubscribe;
  }, [flushPendingSaves, scheduleSave]);

  const retryCloseAfterSaveFailure = async () => {
    const electronApi = window.electronAPI;
    if (!electronApi || !closeRequestPendingRef.current) return;

    setIsRetryingSave(true);
    try {
      await getSaveQueue().retryNow();
      await backupSchedulerRef.current?.runDueForClose();
      electronApi.confirmClose();
    } catch (error) {
      console.error('Failed to retry workspace save before closing.', error);
      setCloseSaveError(getErrorMessage(error));
    } finally {
      setIsRetryingSave(false);
    }
  };

  const cancelCloseAfterSaveFailure = () => {
    closeRequestPendingRef.current = false;
    setCloseSaveError(null);
    window.electronAPI?.cancelClose();
  };

  const quitWithoutSaving = () => {
    window.electronAPI?.confirmClose();
  };

  useEffect(() => () => {
    operationRegistryRef.current.invalidateWorkspace();
    saveQueueRef.current?.dispose();
    backupSchedulerRef.current?.dispose();
    workspaceCoordinatorRef.current?.dispose();
    unsubscribeBackendChangesRef.current?.();
    revokeAttachmentPreviewUrls(sessionsRef.current);
  }, []);

  // Data Import/Export Handlers
  const handleExportData = async () => {
    if (!dirHandle) return;
    const controller = new AbortController();
    archiveAbortRef.current?.abort();
    archiveAbortRef.current = controller;
    try {
      const showSaveFilePicker = !isMobile && !window.electronAPI
        ? (window as typeof window & {
            showSaveFilePicker?: PortableBackupSavePicker;
          }).showSaveFilePicker
        : undefined;
      const fileHandle = showSaveFilePicker
        ? await showSaveFilePicker({
            suggestedName: 'openai-studio-backup.zip',
            types: [{
              description: 'OpenAI Studio backup',
              accept: { 'application/zip': ['.zip'] }
            }]
          })
        : null;
      await flushPendingSaves();
      const snapshot = await readWorkspaceSnapshot(dirHandle);
      const archive = await createWorkspaceArchive(snapshot, {
        reason: 'manual',
        signal: controller.signal,
        onProgress: setArchiveProgress
      });
      const validated = await inspectWorkspaceArchive(archive, {
        signal: controller.signal,
        onProgress: setArchiveProgress,
        retainBlobs: false
      });
      const filename = createManagedBackupFilename(
        validated.manifest.createdAt,
        validated.manifest.backupId
      );
      const portableFile = new File([archive], filename, {
        type: 'application/zip'
      });
      const shareData = {
        title: 'OpenAI Studio workspace backup',
        files: [portableFile]
      };
      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(archive);
        await writable.close();
      } else if (isMobile) {
        setPreparedPortableBackup({
          file: portableFile,
          canShare: (
            typeof navigator.share === 'function' &&
            Boolean(navigator.canShare?.(shareData))
          )
        });
      } else {
        downloadBlobFile(filename, archive);
      }
    } catch (e) {
      if (isAbortError(e)) return;
      console.error("Export failed", e);
      alert(`Failed to export workspace data: ${getErrorMessage(e)}`);
    } finally {
      if (archiveAbortRef.current === controller) {
        archiveAbortRef.current = null;
        setArchiveProgress(null);
      }
    }
  };

  const handleSavePreparedPortableBackup = () => {
    const prepared = preparedPortableBackup;
    if (!prepared) return;
    if (prepared.canShare && typeof navigator.share === 'function') {
      void navigator.share({
        title: 'OpenAI Studio workspace backup',
        files: [prepared.file]
      }).then(() => {
        setPreparedPortableBackup(null);
      }).catch(error => {
        if (isAbortError(error)) return;
        console.warn('Native backup sharing failed; using download fallback.', error);
        downloadBlobFile(prepared.file.name, prepared.file);
        setPreparedPortableBackup(null);
      });
      return;
    }
    downloadBlobFile(prepared.file.name, prepared.file);
    setPreparedPortableBackup(null);
  };

  const handleShareConversation = () => {
    if (!currentSession || currentSession.messages.length === 0) return;

    try {
      const markdown = formatConversationMarkdown(currentSession);
      const filename = buildConversationFilename(currentSession.title);
      downloadTextFile(filename, markdown);
    } catch (e) {
      console.error("Conversation export failed", e);
      alert("Failed to export conversation.");
    }
  };

  const handleImportData = async (file: File) => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current ||
      !dirHandleRef.current
    ) {
      return;
    }

    const readOperation = operationRegistryRef.current.begin({
      id: uuidv4(),
      kind: 'import-read'
    });
    archiveAbortRef.current?.abort();
    archiveAbortRef.current = readOperation.controller;

    try {
      if (file.size > MAX_BACKUP_ARCHIVE_BYTES) {
        throw new Error('Backup file exceeds the supported size limit.');
      }
      const inspected = await inspectWorkspaceArchive(file, {
        filename: file.name,
        signal: readOperation.controller.signal,
        onProgress: setArchiveProgress,
        retainBlobs: false
      });
      if (!isOperationCurrent(readOperation, false)) {
        throw createOperationAbortError();
      }
      setPendingRestore({
        file,
        preview: inspected.preview
      });
    } catch (e) {
      if (isAbortError(e)) return;
      console.error("Import failed", e);
      alert(
        e instanceof UnsupportedLegacyBackupError
          ? e.message
          : `Failed to validate backup: ${getErrorMessage(e)}`
      );
    } finally {
      operationRegistryRef.current.complete(readOperation);
      if (archiveAbortRef.current === readOperation.controller) {
        archiveAbortRef.current = null;
        setArchiveProgress(null);
      }
    }
  };

  const confirmWorkspaceRestore = async () => {
    const pending = pendingRestore;
    if (!pending || !dirHandleRef.current) return;
    setPendingRestore(null);
    await flushPendingSaves();
    invalidateWorkspaceOperations();

    try {
      await enqueueDestructiveOperation(async () => {
        const operation = operationRegistryRef.current.begin({
          id: uuidv4(),
          kind: 'workspace-restore'
        });
        const handle = dirHandleRef.current;
        try {
          if (!handle || !workspaceCanWriteRef.current) {
            throw createOperationAbortError();
          }
          archiveAbortRef.current = operation.controller;
          await restoreWorkspaceArchive(handle, pending.file, {
            filename: pending.file.name,
            signal: operation.controller.signal,
            onProgress: setArchiveProgress
          });
          if (archiveAbortRef.current === operation.controller) {
            archiveAbortRef.current = null;
            setArchiveProgress(null);
          }
          workspaceCoordinatorRef.current?.publishUpdate(getWorkspaceRevision());
          await loadWorkspaceData(
            handle,
            'writer',
            () => isOperationCurrent(operation, false)
          );
          setUndoWorkspaceAction('restore');
        } finally {
          if (archiveAbortRef.current === operation.controller) {
            archiveAbortRef.current = null;
          }
          setArchiveProgress(null);
          operationRegistryRef.current.complete(operation);
        }
      });
    } catch (error) {
      if (!isAbortError(error)) {
        alert(`Workspace restore failed: ${getErrorMessage(error)}`);
      }
    }
  };

  const handleMergeData = async (file: File) => {
    if (
      !workspaceCanWriteRef.current ||
      workspaceMutationBlockedRef.current ||
      activeRequestsRef.current.size > 0 ||
      processingSessionIdsRef.current.size > 0 ||
      !dirHandleRef.current
    ) {
      return;
    }

    try {
      await enqueueDestructiveOperation(async () => {
        if (
          !workspaceCanWriteRef.current ||
          activeRequestsRef.current.size > 0 ||
          processingSessionIdsRef.current.size > 0
        ) {
          throw new Error('Finish active responses before merging a backup.');
        }
        await flushPendingSaves();
        invalidateWorkspaceOperations();
        const operation = operationRegistryRef.current.begin({
          id: uuidv4(),
          kind: 'workspace-merge'
        });
        const handle = dirHandleRef.current;
        try {
          if (!handle || !workspaceCanWriteRef.current) {
            throw createOperationAbortError();
          }
          archiveAbortRef.current?.abort();
          archiveAbortRef.current = operation.controller;
          const result = await mergeWorkspaceArchive(handle, file, {
            filename: file.name,
            signal: operation.controller.signal,
            onProgress: setArchiveProgress
          });
          if (archiveAbortRef.current === operation.controller) {
            archiveAbortRef.current = null;
            setArchiveProgress(null);
          }
          workspaceCoordinatorRef.current?.publishUpdate(result.revision);
          await loadWorkspaceData(
            handle,
            'writer',
            () => isOperationCurrent(operation, false)
          );
          setUndoWorkspaceAction('merge');
        } finally {
          if (archiveAbortRef.current === operation.controller) {
            archiveAbortRef.current = null;
          }
          setArchiveProgress(null);
          operationRegistryRef.current.complete(operation);
        }
      });
      await backupSchedulerRef.current?.evaluate();
    } catch (error) {
      if (!isAbortError(error)) {
        alert(`Workspace merge failed: ${getErrorMessage(error)}`);
      }
    }
  };

  const handleUndoWorkspaceMutation = async () => {
    const handle = dirHandleRef.current;
    if (!handle || !workspaceCanWriteRef.current) return;
    const action = undoWorkspaceAction;
    await flushPendingSaves();
    invalidateWorkspaceOperations();
    try {
      await enqueueDestructiveOperation(async () => {
        await undoLastWorkspaceMutation(handle);
        workspaceCoordinatorRef.current?.publishUpdate(getWorkspaceRevision());
        await loadWorkspaceData(handle, 'writer');
      });
      setUndoWorkspaceAction(null);
      await backupSchedulerRef.current?.evaluate();
    } catch (error) {
      alert(`Undo ${action || 'workspace change'} failed: ${getErrorMessage(error)}`);
    }
  };

  const handleChooseBackupFolder = async () => {
    try {
      const destination = await chooseBackupDestination();
      if (!destination) return;
      await backupSchedulerRef.current?.setDestination(destination);
      setBackupActionError(null);
    } catch (error) {
      setBackupActionError(getErrorMessage(error));
    }
  };

  const handleReconnectBackupFolder = async () => {
    try {
      const destination = await loadBackupDestination();
      if (!destination || !(await reconnectBackupDestination(destination))) {
        throw new Error('Backup folder permission was not granted.');
      }
      await backupSchedulerRef.current?.setDestination(destination);
      setBackupActionError(null);
      await backupSchedulerRef.current?.evaluate();
    } catch (error) {
      setBackupActionError(getErrorMessage(error));
    }
  };

  const handleToggleAutomaticBackups = async (enabled: boolean) => {
    try {
      if (enabled && backupState.destinationStatus === 'unavailable') {
        const destination = await chooseBackupDestination();
        if (!destination) return;
        await backupSchedulerRef.current?.setDestination(destination);
      }
      await backupSchedulerRef.current?.setEnabled(enabled);
      setBackupActionError(null);
    } catch (error) {
      setBackupActionError(getErrorMessage(error));
    }
  };

  const handleBackUpNow = async () => {
    try {
      await flushPendingSaves();
      await backupSchedulerRef.current?.backUpNow();
      setBackupActionError(null);
    } catch (error) {
      setBackupActionError(getErrorMessage(error));
    }
  };

  const handleManagedBackupRestore = async (filename: string) => {
    try {
      const archive = await backupSchedulerRef.current?.readBackup(filename);
      if (!archive) throw new Error('The selected backup is unavailable.');
      await handleImportData(new File([archive], filename, {
        type: 'application/zip'
      }));
    } catch (error) {
      setBackupActionError(getErrorMessage(error));
    }
  };

  const handleManagedBackupExport = async (filename: string) => {
    try {
      const archive = await backupSchedulerRef.current?.readBackup(filename);
      if (!archive) throw new Error('The selected backup is unavailable.');
      downloadBlobFile(filename, archive);
    } catch (error) {
      setBackupActionError(getErrorMessage(error));
    }
  };

  const handleManagedBackupDelete = async (filename: string) => {
    if (!window.confirm(`Delete managed backup "${filename}"?`)) return;
    try {
      await backupSchedulerRef.current?.deleteBackup(filename);
    } catch (error) {
      setBackupActionError(getErrorMessage(error));
    }
  };

  // Determine if the CURRENT session is loading
  const isCurrentSessionProcessing = currentSessionId ? processingSessionIds.has(currentSessionId) : false;
  const isWorkspaceInteractionReadOnly = isWorkspaceReadOnly || isWorkspaceMutating;

  if (isInitializing) {
    return (
      <div className={`flex h-screen w-full items-center justify-center transition-colors duration-200 ${isDarkMode ? 'dark bg-[#0d1117]' : 'bg-white'}`}>
         <div className="flex flex-col items-center gap-4">
             <Loader2 size={40} className="animate-spin text-blue-600 dark:text-blue-500" />
             <div className="text-sm text-gray-500 dark:text-gray-400 font-medium">Loading Workspace...</div>
         </div>
      </div>
    );
  }

  if (workspaceLoadError) {
    return (
      <div className={isDarkMode ? 'dark' : ''}>
        <div className="flex flex-col h-screen w-full bg-white dark:bg-[#0d1117] text-gray-900 dark:text-gray-200 font-sans overflow-hidden transition-colors duration-200">
          {!isMobile && window.electronAPI && <TitleBar isDarkMode={isDarkMode} />}
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="w-full max-w-lg rounded-lg border border-red-200 bg-red-50 p-6 shadow-sm dark:border-red-900/60 dark:bg-red-950/20">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" size={24} />
                <div className="min-w-0">
                  <h1 className="text-base font-semibold text-red-900 dark:text-red-100">Workspace storage could not be loaded</h1>
                  <p className="mt-2 text-sm leading-6 text-red-800 dark:text-red-200">
                    OpenAI Studio did not write an empty workspace. Resolve the storage issue below, then retry.
                  </p>
                  <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-white/70 p-3 text-xs text-red-950 dark:bg-black/20 dark:text-red-100">
                    {workspaceLoadError}
                  </pre>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="mt-4 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
                  >
                    Retry
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={isDarkMode ? 'dark' : ''}>
      <div className="flex flex-col h-screen w-full bg-white dark:bg-[#0d1117] text-gray-900 dark:text-gray-200 font-sans overflow-hidden transition-colors duration-200">
        {/* Custom Title Bar - Electron desktop only */}
        {!isMobile && window.electronAPI && <TitleBar isDarkMode={isDarkMode} />}

        {isWorkspaceReadOnly && (
          <div
            role="status"
            className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            This workspace is open for editing in another tab. This tab is read-only and follows saved changes automatically.
          </div>
        )}

        {isWorkspaceMutating && (
          <div
            role="status"
            className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-center text-xs font-medium text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200"
          >
            Updating workspace… editing and new requests are temporarily paused.
          </div>
        )}

        {saveFailure && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
          >
            <span className="inline-flex items-center gap-2">
              <AlertTriangle size={15} className="shrink-0" />
              <span>
                Workspace changes are not saved: {saveFailure.error.message}
                {saveFailure.nextRetryDelayMs === null
                  ? ' Automatic retries are paused.'
                  : ` Retrying in ${Math.ceil(saveFailure.nextRetryDelayMs / 1000)}s.`}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void retryPendingSaves()}
              disabled={isRetryingSave || isWorkspaceInteractionReadOnly}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1.5 font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={13} className={isRetryingSave ? 'animate-spin' : ''} />
              {isRetryingSave ? 'Retrying…' : 'Retry now'}
            </button>
          </div>
        )}

        {/* Mobile Header */}
        {isMobile && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[#0d1117] safe-area-top">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 -ml-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label="Open menu"
            >
              <Menu size={24} />
            </button>
            <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate max-w-[200px]">
              OpenAI Studio
            </h1>
            <button
              onClick={() => setIsConfigOpen(true)}
              className="p-2 -mr-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label="Open settings"
              disabled={!currentSession}
            >
              <Settings size={24} className={!currentSession ? 'opacity-40' : ''} />
            </button>
          </div>
        )}

        {/* Main App Content */}
        <div className="flex flex-1 min-h-0 min-w-0 w-full overflow-hidden">
          {/* Sidebar - Desktop: always visible, Mobile: slide-out drawer */}
          {!isMobile ? (
            <Sidebar
              sessions={sessions}
              currentSessionId={currentSessionId}
              onSelectSession={updateCurrentSessionId}
              onNewSession={createNewSession}
              onDeleteSession={deleteSession}
              isDarkMode={isDarkMode}
              toggleTheme={() => {
                if (
                  workspaceCanWriteRef.current &&
                  !workspaceMutationBlockedRef.current
                ) {
                  setIsDarkMode(!isDarkMode);
                }
              }}
              apiKey={apiKey}
              onApiKeyChange={key => {
                if (
                  workspaceCanWriteRef.current &&
                  !workspaceMutationBlockedRef.current
                ) {
                  setApiKey(key);
                }
              }}
              onExportData={handleExportData}
              onImportData={handleImportData}
              onMergeData={handleMergeData}
              mergeDisabled={
                isWorkspaceInteractionReadOnly ||
                processingSessionIds.size > 0
              }
              backupState={backupState}
              backupActionError={backupActionError}
              onToggleAutomaticBackups={handleToggleAutomaticBackups}
              onChooseBackupFolder={handleChooseBackupFolder}
              onReconnectBackupFolder={handleReconnectBackupFolder}
              onBackUpNow={handleBackUpNow}
              onRestoreManagedBackup={handleManagedBackupRestore}
              onExportManagedBackup={handleManagedBackupExport}
              onDeleteManagedBackup={handleManagedBackupDelete}
              undoWorkspaceAction={undoWorkspaceAction}
              onUndoWorkspaceMutation={handleUndoWorkspaceMutation}
              processingSessionIds={processingSessionIds}
              readOnly={isWorkspaceInteractionReadOnly}
            />
          ) : (
            <>
              {/* Mobile Sidebar Overlay */}
              {isSidebarOpen && (
                <div
                  className="fixed inset-0 bg-black/50 z-40 animate-in fade-in duration-200"
                  onClick={() => setIsSidebarOpen(false)}
                />
              )}
              {/* Mobile Sidebar Drawer */}
              <div
                className={`fixed inset-y-0 left-0 z-50 w-80 max-w-[85vw] transform transition-transform duration-300 ease-out ${
                  isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
                }`}
              >
                <div className="h-full flex flex-col bg-gray-50 dark:bg-[#0d1117] safe-area-left">
                  <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
                    <span className="font-semibold text-gray-800 dark:text-gray-200">Chats</span>
                    <button
                      onClick={() => setIsSidebarOpen(false)}
                      className="p-2 -mr-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <X size={20} />
                    </button>
                  </div>
                  <Sidebar
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    onSelectSession={handleSelectSession}
                    onNewSession={() => { createNewSession(); setIsSidebarOpen(false); }}
                    onDeleteSession={deleteSession}
                    isDarkMode={isDarkMode}
                    toggleTheme={() => {
                      if (
                        workspaceCanWriteRef.current &&
                        !workspaceMutationBlockedRef.current
                      ) {
                        setIsDarkMode(!isDarkMode);
                      }
                    }}
                    apiKey={apiKey}
                    onApiKeyChange={key => {
                      if (
                        workspaceCanWriteRef.current &&
                        !workspaceMutationBlockedRef.current
                      ) {
                        setApiKey(key);
                      }
                    }}
                    onExportData={handleExportData}
                    onImportData={handleImportData}
                    onMergeData={handleMergeData}
                    mergeDisabled={
                      isWorkspaceInteractionReadOnly ||
                      processingSessionIds.size > 0
                    }
                    backupState={backupState}
                    backupActionError={backupActionError}
                    onToggleAutomaticBackups={handleToggleAutomaticBackups}
                    onChooseBackupFolder={handleChooseBackupFolder}
                    onReconnectBackupFolder={handleReconnectBackupFolder}
                    onBackUpNow={handleBackUpNow}
                    onRestoreManagedBackup={handleManagedBackupRestore}
                    onExportManagedBackup={handleManagedBackupExport}
                    onDeleteManagedBackup={handleManagedBackupDelete}
                    undoWorkspaceAction={undoWorkspaceAction}
                    onUndoWorkspaceMutation={handleUndoWorkspaceMutation}
                    processingSessionIds={processingSessionIds}
                    isMobile={true}
                    readOnly={isWorkspaceInteractionReadOnly}
                  />
                </div>
              </div>
            </>
          )}

          <main className="flex-1 flex min-w-0 w-full overflow-hidden">
            <ChatArea
              key={draftWorkspaceEpoch}
              session={currentSession}
              availableSessionIds={sessions.map(session => session.id)}
              onSendMessage={handleSendMessage}
              onStopGenerating={handleStopGenerating}
              onRetryFailedMessage={handleRetryFailedMessage}
              onRemoveFailedAttachment={handleRemoveFailedAttachment}
              onReplaceFailedAttachments={handleReplaceFailedAttachments}
              onRegenerateResponse={handleRegenerateLatestResponse}
              onShareConversation={handleShareConversation}
              onDownloadGeneratedFile={cacheGeneratedFile}
              apiKey={apiKey}
              isLoading={isCurrentSessionProcessing}
              isMobile={isMobile}
              readOnly={isWorkspaceInteractionReadOnly}
            />

            {/* ConfigPanel - Desktop: always visible when session selected, Mobile: modal */}
            {!isMobile && currentSession && (
              <ConfigPanel
                config={currentSession.config}
                onChange={updateConfig}
                systemInstructions={systemInstructions}
                onCreateSystemInstruction={handleCreateSystemInstruction}
                onUpdateSystemInstruction={handleUpdateSystemInstruction}
                onDeleteSystemInstruction={handleDeleteSystemInstruction}
                readOnly={isWorkspaceInteractionReadOnly}
              />
            )}
          </main>
        </div>

        {/* Mobile Config Modal */}
        {isMobile && isConfigOpen && currentSession && (
          <>
            <div
              className="fixed inset-0 bg-black/50 z-40 animate-in fade-in duration-200"
              onClick={() => setIsConfigOpen(false)}
            />
            <div className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] bg-gray-50 dark:bg-[#0d1117] rounded-t-2xl animate-in slide-in-from-bottom duration-300 safe-area-bottom overflow-hidden flex flex-col">
              <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
                <span className="font-semibold text-gray-800 dark:text-gray-200">Configuration</span>
                <button
                  onClick={() => setIsConfigOpen(false)}
                  className="p-2 -mr-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <ConfigPanel
                  config={currentSession.config}
                  onChange={updateConfig}
                  systemInstructions={systemInstructions}
                  onCreateSystemInstruction={handleCreateSystemInstruction}
                  onUpdateSystemInstruction={handleUpdateSystemInstruction}
                  onDeleteSystemInstruction={handleDeleteSystemInstruction}
                  isMobile={true}
                  readOnly={isWorkspaceInteractionReadOnly}
                />
              </div>
            </div>
          </>
        )}

        {archiveProgress && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-4">
            <div
              role="status"
              className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-[#161b22]"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Loader2 size={16} className="animate-spin text-blue-500" />
                {archiveProgress.phase === 'preparing'
                  ? 'Preparing portable backup…'
                  : 'Validating backup integrity…'}
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className="h-full rounded-full bg-blue-600 transition-[width]"
                  style={{
                    width: `${Math.min(
                      100,
                      archiveProgress.totalBytes > 0
                        ? archiveProgress.completedBytes /
                          archiveProgress.totalBytes * 100
                        : archiveProgress.completedEntries /
                          Math.max(1, archiveProgress.totalEntries) * 100
                    )}%`
                  }}
                />
              </div>
              <div className="mt-2 text-xs text-gray-500">
                {archiveProgress.completedEntries} of {archiveProgress.totalEntries} entries
              </div>
              <button
                type="button"
                onClick={() => archiveAbortRef.current?.abort()}
                className="mt-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {pendingRestore && (
          <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60 px-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="restore-preview-title"
              className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-gray-700 dark:bg-[#161b22]"
            >
              <h2 id="restore-preview-title" className="text-base font-semibold">
                Restore verified backup?
              </h2>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                The archive passed ZIP, size, schema, reference, and SHA-256 validation. A verified recovery point will be created before the workspace changes.
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-gray-50 p-3 text-xs dark:bg-[#0d1117]">
                <dt className="text-gray-500">Created</dt>
                <dd>{new Date(pendingRestore.preview.createdAt).toLocaleString()}</dd>
                <dt className="text-gray-500">App version</dt>
                <dd>v{pendingRestore.preview.appVersion}</dd>
                <dt className="text-gray-500">Workspace revision</dt>
                <dd>{pendingRestore.preview.workspaceRevision}</dd>
                <dt className="text-gray-500">Sessions / messages</dt>
                <dd>{pendingRestore.preview.counts.sessions} / {pendingRestore.preview.counts.messages}</dd>
                <dt className="text-gray-500">Attachments / files</dt>
                <dd>{pendingRestore.preview.counts.attachments} / {pendingRestore.preview.counts.generatedFiles}</dd>
                <dt className="text-gray-500">Archive size</dt>
                <dd>{(pendingRestore.preview.archiveBytes / (1024 * 1024)).toFixed(1)} MB</dd>
              </dl>
              {pendingRestore.preview.uncachedGeneratedFileCount > 0 && (
                <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  {pendingRestore.preview.uncachedGeneratedFileCount} generated-file reference(s) were not cached when this backup was created.
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingRestore(null)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void confirmWorkspaceRestore()}
                  className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Create recovery point and restore
                </button>
              </div>
            </div>
          </div>
        )}

        {preparedPortableBackup && (
          <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60 px-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="portable-backup-ready-title"
              className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-[#161b22]"
            >
              <h2
                id="portable-backup-ready-title"
                className="text-base font-semibold text-gray-900 dark:text-gray-100"
              >
                Portable backup ready
              </h2>
              <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
                The verified ZIP is ready. Use the button below to
                {preparedPortableBackup.canShare ? ' share or save it' : ' save it'}.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPreparedPortableBackup(null)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSavePreparedPortableBackup}
                  className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  {preparedPortableBackup.canShare ? 'Share or save' : 'Save backup'}
                </button>
              </div>
            </div>
          </div>
        )}

        {closeSaveError && window.electronAPI && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="close-save-error-title"
              className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-2xl dark:border-red-900/60 dark:bg-[#161b22]"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle
                  size={24}
                  className="mt-0.5 shrink-0 text-red-600 dark:text-red-400"
                />
                <div className="min-w-0">
                  <h2
                    id="close-save-error-title"
                    className="text-base font-semibold text-gray-900 dark:text-gray-100"
                  >
                    Couldn’t finish close-time protection
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
                    A workspace save or due backup failed. Retry, keep the app open, or explicitly close without the backup. If saving also failed, in-memory changes will be lost.
                  </p>
                  <pre className="mt-3 max-h-28 overflow-auto rounded-md bg-red-50 p-3 text-xs text-red-900 dark:bg-red-950/30 dark:text-red-100">
                    {closeSaveError}
                  </pre>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelCloseAfterSaveFailure}
                  disabled={isRetryingSave}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  Keep working
                </button>
                <button
                  type="button"
                  onClick={quitWithoutSaving}
                  disabled={isRetryingSave}
                  className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"
                >
                  Close without backup
                </button>
                <button
                  type="button"
                  onClick={() => void retryCloseAfterSaveFailure()}
                  disabled={isRetryingSave}
                  className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCw size={15} className={isRetryingSave ? 'animate-spin' : ''} />
                  {isRetryingSave ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
