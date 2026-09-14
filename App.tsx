
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { Sidebar } from './components/Sidebar';
import { ConfigPanel } from './components/ConfigPanel';
import { ChatArea } from './components/ChatArea';
import { ProjectHome } from './components/ProjectHome';
import { TitleBar } from './components/TitleBar';
import {
  Session,
  ChatConfig,
  FileAttachment,
  GeneratedFile,
  Message,
  DEFAULT_CONFIG,
  SystemInstruction,
  Project,
  ProjectRemoteState,
  ProjectSource,
  RemoteCleanupTombstone,
  ResolvedProjectContext
} from './types';
import {
  fetchGeneratedFileContent,
  generateResponse,
  generateChatTitle,
  resolveOpenAIApiKey
} from './services/openaiService';
import {
  getStorageHandle,
  readWorkspaceState,
  writeWorkspaceState,
  storeAttachmentBlob,
  readLocalBlob,
  storeLocalBlob,
  getAttachmentDataUrl,
  readWorkspaceSnapshot,
  synchronizeWorkspaceRevision,
  getWorkspaceRevision,
  clearInternalRecoveryArchive,
  WorkspaceRevisionConflictError,
  WorkspaceState,
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
import { serializeCanonicalJson } from './services/contentAddressing';
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
  downloadBlobFile,
  formatConversationMarkdown
} from './utils/conversationExport';
import { confirmChatDeletion } from './utils/chatDeletion';
import { getModelConfig, normalizeChatConfig } from './constants';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Callout, Dialog, Spinner, cx } from './components/ui';
import { validateAttachments } from './utils/attachmentValidation';
import {
  ProjectSourceService,
  ProjectSourceServiceError,
  createEmptyProjectRemoteState,
  createProjectCleanupTombstone,
  createSourceCleanupTombstone,
  fingerprintApiKey,
  getProjectSourceAvailability,
  resolveProjectContext
} from './services/projectSourceService';
import { validateProjectSourceFiles } from './utils/projectSources';
import {
  applyResponseStreamSnapshot,
  hasResponseStreamOutput,
  ResponseStreamSnapshot,
  ResponseStreamState,
  responseStreamSnapshotMatchesMessage
} from './services/responseStreamState';
import {
  ProjectOperation,
  ProjectOperationOwner,
  ProjectOperationStatus
} from './services/projectOperationOwner';

const MOBILE_BREAKPOINT_PX = 768;
const THEME_COLORS = {
  dark: '#1a1a19',
  light: '#ffffff'
} as const;
const isMobileViewport = (): boolean => window.innerWidth < MOBILE_BREAKPOINT_PX;

type SaveKey =
  | 'sessions'
  | 'instructions'
  | 'settings'
  | 'projects'
  | 'projectRemoteState';

const SAVE_KEYS: SaveKey[] = [
  'sessions',
  'instructions',
  'settings',
  'projects',
  'projectRemoteState'
];
const SAVE_DELAYS: Record<SaveKey, number> = {
  sessions: 1000,
  instructions: 500,
  settings: 500,
  projects: 500,
  projectRemoteState: 0
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

const revokePreviewUrls = (attachments: FileAttachment[] | undefined): void => {
  attachments?.forEach(attachment => {
    if (attachment.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
};

const revokeAttachmentPreviewUrls = (sessions: Session[]): void => {
  sessions.forEach(session => {
    session.messages.forEach(message => revokePreviewUrls(message.attachments));
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
  streamState: ResponseStreamState;
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
  const [isClosing, setIsClosing] = useState(false);
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
  const saveQueueRef = useRef<VersionedSaveQueue<SaveKey> | null>(null);
  const backupSchedulerRef = useRef<BackupScheduler | null>(null);
  const archiveAbortRef = useRef<AbortController | null>(null);
  const closeRequestPendingRef = useRef(false);
  const closeAttemptRef = useRef(0);
  const initializationStartedRef = useRef(false);
  const operationRegistryRef = useRef(new OperationRegistry());
  const workspaceMutationBlockedRef = useRef(false);
  const [isWorkspaceMutating, setIsWorkspaceMutating] = useState(false);
  const destructiveOperationQueueRef = useRef<SerializedOperationQueue | null>(null);
  if (!destructiveOperationQueueRef.current) {
    destructiveOperationQueueRef.current = new SerializedOperationQueue(isPending => {
      workspaceMutationBlockedRef.current = isPending || closeRequestPendingRef.current;
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
  const [projects, setProjects] = useState<Project[]>([]);
  const projectsRef = useRef<Project[]>([]);
  const [projectRemoteState, setProjectRemoteState] = useState<ProjectRemoteState>(
    createEmptyProjectRemoteState
  );
  const projectRemoteStateRef = useRef<ProjectRemoteState>(
    createEmptyProjectRemoteState()
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectOperationStatus, setProjectOperationStatus] =
    useState<ProjectOperationStatus>({
      isBusy: false,
      busySourceIds: new Set()
    });
  const projectOperationOwnerRef = useRef<ProjectOperationOwner | null>(null);
  if (!projectOperationOwnerRef.current) {
    projectOperationOwnerRef.current = new ProjectOperationOwner(
      setProjectOperationStatus
    );
  }
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const skipNextRemoteStateEffectSaveRef = useRef(false);
  const settingsRef = useRef<AppSettings>({
    theme: 'dark',
    apiKey: ''
  });

  // Mobile drawer visibility, desktop column visibility, and the chat
  // settings panel (bottom sheet below md, side panel above).
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);

  useEffect(() => {
    const closeMobileDrawerOnDesktop = () => {
      if (isMobileViewport()) return;
      setIsSidebarOpen(false);
    };
    window.addEventListener('resize', closeMobileDrawerOnDesktop);
    return () => window.removeEventListener('resize', closeMobileDrawerOnDesktop);
  }, []);

  // Theme tokens live on the document root so dialogs, native controls, and
  // scrollbars follow the selected theme everywhere. Android uses the page
  // theme-color in preference to the manifest once the app is running, so keep
  // its status bar aligned with the header surface too.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute('content', isDarkMode ? THEME_COLORS.dark : THEME_COLORS.light);
  }, [isDarkMode]);

  // Refs are written by these setters before state so effects and async
  // work read the committed value without a layout-effect mirror.
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

  const updateProjectsState = useCallback((next: Project[]): void => {
    projectsRef.current = next;
    setProjects(next);
  }, []);

  // A state that was already written to disk skips the persist effect.
  const commitProjectRemoteState = useCallback((
    next: ProjectRemoteState,
    alreadyPersisted: boolean
  ): void => {
    projectRemoteStateRef.current = next;
    if (alreadyPersisted) skipNextRemoteStateEffectSaveRef.current = true;
    setProjectRemoteState(next);
  }, []);

  const canMutateWorkspace = (): boolean => (
    workspaceCanWriteRef.current && !workspaceMutationBlockedRef.current
  );

  useLayoutEffect(() => {
    systemInstructionsRef.current = systemInstructions;
  }, [systemInstructions]);

  useLayoutEffect(() => {
    settingsRef.current = {
      theme: isDarkMode ? 'dark' : 'light',
      apiKey,
      lastActiveSessionId: currentSessionId || undefined
    };
  }, [isDarkMode, apiKey, currentSessionId]);

  const handleSelectSession = useCallback((id: string) => {
    setSelectedProjectId(null);
    updateCurrentSessionId(id);
    setIsSidebarOpen(false);
  }, [updateCurrentSessionId]);

  const handleSelectProject = useCallback((id: string) => {
    setSelectedProjectId(id);
    setIsSidebarOpen(false);
  }, []);

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

    const changes = {
      sessions: () => ({ sessions: sessionsRef.current }),
      instructions: () => ({ instructions: systemInstructionsRef.current }),
      settings: () => ({ settings: settingsRef.current }),
      projects: () => ({ projects: projectsRef.current }),
      projectRemoteState: () => ({ projectRemoteState: projectRemoteStateRef.current })
    }[key]();

    try {
      const revision = await writeWorkspaceState(handle, changes);
      workspaceCoordinatorRef.current?.publishUpdate(revision);
      void backupSchedulerRef.current?.evaluate().catch(() => undefined);
    } catch (error) {
      if (error instanceof WorkspaceRevisionConflictError && !window.electronAPI) {
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
        id: crypto.randomUUID(),
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

  // Commits every active stream's buffered output. 'streaming' skips
  // sessions whose message already matches; 'stopped' also clears the
  // pending marker so the turn is final.
  const checkpointActiveRequests = useCallback((
    requests: ReadonlyMap<string, ActiveChatRequest>,
    status: 'streaming' | 'stopped'
  ): void => {
    const now = Date.now();
    let changed = false;
    const next = sessionsRef.current.map(session => {
      const activeRequest = requests.get(session.id);
      if (!activeRequest) return session;
      const snapshot = activeRequest.streamState.checkpoint().snapshot;
      if (status === 'streaming' && !hasResponseStreamOutput(snapshot)) return session;

      let didUpdateMessage = false;
      const messages = session.messages.map(message => {
        if (
          message.id !== activeRequest.assistantMessageId ||
          (status === 'streaming' && responseStreamSnapshotMatchesMessage(message, snapshot))
        ) {
          return message;
        }
        didUpdateMessage = true;
        return applyResponseStreamSnapshot(
          message,
          snapshot,
          status,
          status === 'stopped' ? now : message.timestamp
        );
      });
      if (status === 'streaming' && !didUpdateMessage) return session;

      changed = true;
      return {
        ...session,
        messages,
        lastModified: now,
        ...(status === 'stopped' ? { pendingRequest: undefined } : {})
      };
    });
    if (!changed) return;

    forceImmediateSessionSaveRef.current = false;
    skipNextSessionEffectSaveRef.current = true;
    updateSessionsState(next);
    scheduleSave('sessions', true);
  }, [scheduleSave, updateSessionsState]);

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
    projectOperationOwnerRef.current!.invalidateWorkspace();
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
        id: crypto.randomUUID(),
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
      if (serializeCanonicalJson(config) === serializeCanonicalJson(session.config)) {
        return session;
      }
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
    let loadedWorkspace: WorkspaceState | null = null;

    // A reader retries if a broadcast lands while its snapshot is being read.
    // The writer is already protected by the exclusive workspace lock.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revisionBeforeRead = await synchronizeWorkspaceRevision(handle);
      if (!isStillCurrent()) throw createOperationAbortError();
      const loaded = await readWorkspaceState(handle);
      if (!isStillCurrent()) throw createOperationAbortError();
      validateWorkspaceReferences({
        sessions: loaded.sessions,
        settings: loaded.settings,
        instructions: loaded.instructions,
        projects: loaded.projects
      }, {
        allowDanglingSelections: true
      });
      const revisionAfterRead = await synchronizeWorkspaceRevision(handle);
      if (!isStillCurrent()) throw createOperationAbortError();

      if (role === 'writer' || revisionBeforeRead === revisionAfterRead) {
        loadedWorkspace = loaded;
        break;
      }
    }

    if (!loadedWorkspace) {
      throw new Error('Workspace kept changing while this tab was loading it.');
    }

    const {
      sessions: loadedSessions,
      settings: loadedSettings,
      instructions: loadedInstructions,
      projects: loadedProjects,
      projectRemoteState: loadedProjectRemoteState
    } = loadedWorkspace;

    const normalizedSessions = normalizeSessionConfigs(loadedSessions);
    const cleanedSessions = role === 'writer'
      ? markPendingRequestsFailed(normalizedSessions)
      : normalizedSessions;
    const nextInstructions = loadedInstructions;
    const nextCurrentSessionId = (
      loadedSettings.lastActiveSessionId &&
      cleanedSessions.some(session => session.id === loadedSettings.lastActiveSessionId)
    )
      ? loadedSettings.lastActiveSessionId
      : cleanedSessions[0]?.id || null;

    if (!isStillCurrent()) throw createOperationAbortError();
    setDraftWorkspaceEpoch(epoch => epoch + 1);
    revokeAttachmentPreviewUrls(sessionsRef.current);
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
    updateProjectsState(loadedProjects);
    commitProjectRemoteState(loadedProjectRemoteState, false);
    setSelectedProjectId(current => (
      current && loadedProjects.some(project => project.id === current)
        ? current
        : null
    ));
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
        const handle = await getStorageHandle({ readOnly: !coordinator.canWrite });
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
        void (async () => {
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
                operationRegistryRef.current.getOperations().length === 0 &&
                !projectOperationOwnerRef.current!.isBusy
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
        })();
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

  useEffect(() => {
    scheduleSave('projects');
  }, [projects, dirHandle, isWorkspaceLoaded, scheduleSave]);

  useEffect(() => {
    if (skipNextRemoteStateEffectSaveRef.current) {
      skipNextRemoteStateEffectSaveRef.current = false;
      return;
    }
    scheduleSave('projectRemoteState', true);
  }, [projectRemoteState, dirHandle, isWorkspaceLoaded, scheduleSave]);

  // Effect: Persist Settings (Theme, API Key, Active Session)
  useEffect(() => {
    scheduleSave('settings');
  }, [isDarkMode, apiKey, currentSessionId, dirHandle, isWorkspaceLoaded, scheduleSave]);

  useEffect(() => {
    if (!isWorkspaceLoaded) return;

    const flushForLifecycle = () => {
      checkpointActiveRequests(activeRequestsRef.current, 'streaming');
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
  }, [checkpointActiveRequests, flushPendingSaves, isWorkspaceLoaded]);

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
  const selectedProject = projects.find(project => project.id === selectedProjectId) || null;
  const currentSessionProject = currentSession?.projectId
    ? projects.find(project => project.id === currentSession.projectId) || null
    : null;
  const totalIndexedUsageBytes = Object.values(projectRemoteState.indexes)
    .reduce((sum, index) => sum + index.usageBytes, 0);

  const createSession = (projectId?: string) => {
    if (!canMutateWorkspace()) return;

    // New chats inherit the last used configuration regardless of project
    // membership: the current chat, else the most recently modified chat.
    const currentConfig = sessionsRef.current.find(session => (
      session.id === currentSessionIdRef.current
    ))?.config;
    const latestConfig = sessionsRef.current.reduce<Session | null>((latest, session) => (
      !latest || session.lastModified > latest.lastModified ? session : latest
    ), null)?.config;
    const sourceConfig = currentConfig || latestConfig || DEFAULT_CONFIG;
    const configToUse: ChatConfig = {
      ...sourceConfig,
      tools: {
        ...sourceConfig.tools,
        webSearchOptions: {
          ...sourceConfig.tools.webSearchOptions,
          userLocation: sourceConfig.tools.webSearchOptions.userLocation
            ? { ...sourceConfig.tools.webSearchOptions.userLocation }
            : null
        }
      }
    };
    
    const newSession: Session = {
      id: crypto.randomUUID(),
      title: 'New Chat',
      messages: [],
      config: configToUse,
      lastModified: Date.now(),
      ...(projectId ? { projectId } : {})
    };
    updateSessionsState(prev => [newSession, ...prev]);
    setSelectedProjectId(null);
    updateCurrentSessionId(newSession.id);
  };

  const createNewProject = () => {
    if (!canMutateWorkspace()) return;
    const now = Date.now();
    const project: Project = {
      id: crypto.randomUUID(),
      name: 'New Project',
      icon: 'folder',
      instructions: '',
      sources: [],
      createdAt: now,
      updatedAt: now
    };
    updateProjectsState([...projectsRef.current, project]);
    setSelectedProjectId(project.id);
    scheduleSave('projects', true);
  };

  const updateProject = (updated: Project) => {
    if (!canMutateWorkspace()) return;
    updateProjectsState(projectsRef.current.map(project => (
      project.id === updated.id ? updated : project
    )));
  };

  const reportProjectError = (error: unknown): void => {
    if (!isAbortError(error)) setProjectActionError(getErrorMessage(error));
  };

  const assertProjectOperationCurrent = (
    operation: ProjectOperation
  ): void => {
    projectOperationOwnerRef.current!.assertCurrent(operation);
    if (!workspaceCanWriteRef.current) throw createOperationAbortError();
  };

  const setRemoteStateForOperation = (
    operation: ProjectOperation,
    state: ProjectRemoteState
  ): void => {
    assertProjectOperationCurrent(operation);
    commitProjectRemoteState(state, false);
  };

  const flushSavesForOperation = async (operation: ProjectOperation): Promise<void> => {
    assertProjectOperationCurrent(operation);
    await flushPendingSaves();
    assertProjectOperationCurrent(operation);
  };

  const persistRemoteState = async (
    operation: ProjectOperation,
    state: ProjectRemoteState
  ): Promise<void> => {
    assertProjectOperationCurrent(operation);
    const handle = dirHandleRef.current;
    if (!handle) throw new Error('Workspace storage is unavailable.');
    let revision: number;
    try {
      revision = await writeWorkspaceState(handle, {
        projectRemoteState: state
      });
    } catch (error) {
      // Batch ingestion and key switching may handle this error inside their task.
      projectOperationOwnerRef.current!.reportFailure(error);
      throw error;
    }
    assertProjectOperationCurrent(operation);
    commitProjectRemoteState(state, true);
    workspaceCoordinatorRef.current?.publishUpdate(revision);
  };

  const runTombstoneCleanup = async (
    operation: ProjectOperation,
    state: ProjectRemoteState,
    tombstone: RemoteCleanupTombstone | null
  ): Promise<void> => {
    const cleanupKey = resolveOpenAIApiKey(settingsRef.current.apiKey);
    if (!tombstone || !cleanupKey) return;
    await new ProjectSourceService(cleanupKey).runCleanup(
      state,
      tombstone.id,
      next => persistRemoteState(operation, next)
    );
  };

  const readProjectSourceBlob = async (source: ProjectSource): Promise<Blob> => {
    const handle = dirHandleRef.current;
    if (!handle) throw new Error('Workspace storage is unavailable.');
    const blob = await readLocalBlob(handle, source.localBlob);
    if (!blob) throw new Error(`Local source "${source.name}" is missing.`);
    return blob;
  };

  const indexProjectSourceNow = async (
    operation: ProjectOperation,
    projectId: string,
    source: ProjectSource,
    blob: Blob
  ): Promise<void> => {
    if (source.capability === 'direct_attachment') return;
    assertProjectOperationCurrent(operation);
    const project = projectsRef.current.find(item => item.id === projectId);
    const requestApiKey = resolveOpenAIApiKey(settingsRef.current.apiKey);
    if (!project?.sources.some(item => item.id === source.id)) {
      throw createOperationAbortError();
    }
    if (!requestApiKey) {
      throw new Error('Add an API key in Settings to index project sources.');
    }
    await flushSavesForOperation(operation);
    const service = new ProjectSourceService(requestApiKey);
    const state = await service.ingestSource({
      project,
      source,
      blob,
      state: projectRemoteStateRef.current,
      apiKeyFingerprint: fingerprintApiKey(requestApiKey),
      persist: state => persistRemoteState(operation, state)
    });
    setRemoteStateForOperation(operation, state);
  };

  // Indexes each source in turn; the last failure becomes the project error
  // while an abort stops the batch.
  const indexProjectSources = async (
    operation: ProjectOperation,
    projectId: string,
    entries: Array<{ source: ProjectSource; loadBlob: () => Promise<Blob> }>
  ): Promise<void> => {
    let lastError: string | null = null;
    for (const { source, loadBlob } of entries) {
      const blob = await loadBlob();
      try {
        await indexProjectSourceNow(operation, projectId, source, blob);
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = getErrorMessage(error);
      }
    }
    setProjectActionError(lastError);
  };

  const addProjectSources = (projectId: string, files: File[]) => {
    const project = projectsRef.current.find(item => item.id === projectId);
    const handle = dirHandleRef.current;
    if (
      !project ||
      !handle ||
      !canMutateWorkspace() ||
      projectOperationOwnerRef.current!.isBusy
    ) return;

    let formats: ReturnType<typeof validateProjectSourceFiles>;
    try {
      formats = validateProjectSourceFiles(files, project.sources.length);
    } catch (error) {
      setProjectActionError(getErrorMessage(error));
      return;
    }
    const sourceIds = files.map(() => crypto.randomUUID());
    const pending = projectOperationOwnerRef.current!.enqueue(
      { kind: 'source-add', sourceIds },
      async operation => {
        try {
          const additions: Array<{ source: ProjectSource; loadBlob: () => Promise<Blob> }> = [];
          for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            const localBlob = await storeLocalBlob(handle, file, formats[index].mimeType);
            assertProjectOperationCurrent(operation);
            additions.push({
              source: {
                id: sourceIds[index],
                name: file.name,
                mimeType: formats[index].mimeType,
                byteSize: file.size,
                localBlob,
                capability: formats[index].capability,
                addedAt: Date.now()
              },
              loadBlob: async () => file
            });
          }
          const currentProject = projectsRef.current.find(item => item.id === projectId);
          if (!currentProject) throw createOperationAbortError();
          const updatedProject = {
            ...currentProject,
            sources: [...currentProject.sources, ...additions.map(item => item.source)],
            updatedAt: Date.now()
          };
          const nextProjects = projectsRef.current.map(item => (
            item.id === projectId ? updatedProject : item
          ));
          updateProjectsState(nextProjects);
          scheduleSave('projects', true);
          await flushPendingSaves(['projects']);
          assertProjectOperationCurrent(operation);
          await indexProjectSources(operation, projectId, additions);
        } catch (error) {
          reportProjectError(error);
          throw error;
        }
      }
    );
    void pending.catch(() => undefined);
  };

  const retryProjectSource = (projectId: string, source: ProjectSource) => {
    if (
      !dirHandleRef.current ||
      !canMutateWorkspace() ||
      projectOperationOwnerRef.current!.isBusy
    ) return;
    const pending = projectOperationOwnerRef.current!.enqueue(
      { kind: 'source-index', sourceIds: [source.id] },
      async operation => {
        const blob = await readProjectSourceBlob(source);
        assertProjectOperationCurrent(operation);
        await indexProjectSourceNow(operation, projectId, source, blob);
        setProjectActionError(null);
      }
    );
    void pending.catch(reportProjectError);
  };

  const downloadProjectSource = (source: ProjectSource) => {
    void readProjectSourceBlob(source)
      .then(blob => downloadBlobFile(source.name, blob))
      .catch(error => setProjectActionError(getErrorMessage(error)));
  };

  const loadProjectSourceFile = async (source: ProjectSource): Promise<File> => {
    const blob = await readProjectSourceBlob(source);
    return new File([blob], source.name, { type: source.mimeType || blob.type });
  };

  const deleteProjectSource = (projectId: string, source: ProjectSource) => {
    if (projectOperationOwnerRef.current!.isBusy) {
      setProjectActionError('Wait for project source uploads to finish before deleting a source.');
      return;
    }
    if (
      !window.confirm(`Delete "${source.name}" from this project? This also deletes its OpenAI File.`)
    ) return;
    const handle = dirHandleRef.current;
    if (!handle || !canMutateWorkspace()) return;
    const pending = projectOperationOwnerRef.current!.enqueue(
      { kind: 'source-delete', sourceIds: [source.id] },
      operation => enqueueDestructiveOperation(async () => {
        await flushSavesForOperation(operation);
        const project = projectsRef.current.find(item => item.id === projectId);
        if (!project) throw createOperationAbortError();
        const index = projectRemoteStateRef.current.indexes[projectId];
        const tombstone = createSourceCleanupTombstone(projectId, source.id, index);
        const nextProjects = projectsRef.current.map(item => (
          item.id === projectId
            ? {
                ...item,
                sources: item.sources.filter(value => value.id !== source.id),
                updatedAt: Date.now()
              }
            : item
        ));
        const nextRemoteState = createEmptyProjectRemoteState();
        nextRemoteState.indexes = { ...projectRemoteStateRef.current.indexes };
        nextRemoteState.cleanupTombstones = [
          ...projectRemoteStateRef.current.cleanupTombstones,
          ...(tombstone ? [tombstone] : [])
        ];
        if (index) {
          nextRemoteState.indexes[projectId] = {
            ...index,
            files: Object.fromEntries(
              Object.entries(index.files).filter(([sourceId]) => sourceId !== source.id)
            )
          };
        }
        const revision = await writeWorkspaceState(handle, {
          projects: nextProjects,
          projectRemoteState: nextRemoteState
        });
        assertProjectOperationCurrent(operation);
        updateProjectsState(nextProjects);
        commitProjectRemoteState(nextRemoteState, true);
        workspaceCoordinatorRef.current?.publishUpdate(revision);
        await runTombstoneCleanup(operation, nextRemoteState, tombstone);
      }, { blocksInteractions: false })
    );
    void pending.catch(reportProjectError);
  };

  const deleteProject = (projectId: string) => {
    const project = projectsRef.current.find(item => item.id === projectId);
    const handle = dirHandleRef.current;
    if (!project || !handle || !canMutateWorkspace()) return;
    if (projectOperationOwnerRef.current!.isBusy) {
      window.alert('Wait for project source uploads to finish before deleting a project.');
      return;
    }
    const memberSessions = sessionsRef.current.filter(session => session.projectId === projectId);
    if (memberSessions.some(session => processingSessionIdsRef.current.has(session.id))) {
      window.alert('Stop active responses in this project before deleting it.');
      return;
    }
    if (!window.confirm([
      `Permanently delete "${project.name}"?`,
      '',
      `${memberSessions.length} chat(s) and ${project.sources.length} source(s) will be removed with no in-app undo.`,
      'External ZIP backups are not erased automatically.'
    ].join('\n'))) return;

    const pending = projectOperationOwnerRef.current!.enqueue(
      {
        kind: 'project-delete',
        sourceIds: project.sources.map(source => source.id)
      },
      operation => enqueueDestructiveOperation(async () => {
        await flushSavesForOperation(operation);
        const index = projectRemoteStateRef.current.indexes[projectId];
        const tombstone = createProjectCleanupTombstone(projectId, index);
        const nextSessions = sessionsRef.current.filter(
          session => session.projectId !== projectId
        );
        const nextProjects = projectsRef.current.filter(item => item.id !== projectId);
        const nextRemoteState: ProjectRemoteState = {
          indexes: Object.fromEntries(
            Object.entries(projectRemoteStateRef.current.indexes)
              .filter(([id]) => id !== projectId)
          ),
          cleanupTombstones: [
            ...projectRemoteStateRef.current.cleanupTombstones,
            ...(tombstone ? [tombstone] : [])
          ]
        };
        memberSessions.forEach(session => invalidateSessionOperations(session.id));
        await clearInternalRecoveryArchive(handle);
        assertProjectOperationCurrent(operation);
        const revision = await writeWorkspaceState(handle, {
          sessions: nextSessions,
          projects: nextProjects,
          projectRemoteState: nextRemoteState
        }, { publishTwice: true });
        assertProjectOperationCurrent(operation);
        updateSessionsState(nextSessions);
        updateProjectsState(nextProjects);
        commitProjectRemoteState(nextRemoteState, true);
        setSelectedProjectId(null);
        setUndoWorkspaceAction(null);
        if (currentSessionIdRef.current && memberSessions.some(
          session => session.id === currentSessionIdRef.current
        )) {
          updateCurrentSessionId(nextSessions[0]?.id || null);
        }
        workspaceCoordinatorRef.current?.publishUpdate(revision);
        try {
          await runTombstoneCleanup(operation, nextRemoteState, tombstone);
        } catch (error) {
          if (isAbortError(error)) throw error;
          setProjectActionError(`Project deletion pending: ${getErrorMessage(error)}`);
        }
      })
    );
    void pending.catch(reportProjectError);
  };

  const retryRemoteCleanup = async (): Promise<void> => {
    if (!canMutateWorkspace()) return;
    if (projectOperationOwnerRef.current!.isBusy) {
      setProjectActionError('Wait for project source work to finish before retrying cleanup.');
      return;
    }
    const cleanupKey = resolveOpenAIApiKey(settingsRef.current.apiKey);
    if (!cleanupKey) {
      setProjectActionError('The API key used to create these resources is required for cleanup.');
      return;
    }
    const fingerprint = fingerprintApiKey(cleanupKey);
    const pending = projectRemoteStateRef.current.cleanupTombstones.filter(
      tombstone => tombstone.apiKeyFingerprint === fingerprint
    );
    if (pending.length === 0) {
      setProjectActionError('No pending cleanup matches the current API key.');
      return;
    }
    const service = new ProjectSourceService(cleanupKey);
    const operation = projectOperationOwnerRef.current!.enqueue(
      { kind: 'remote-cleanup' },
      async projectOperation => {
        for (const tombstone of pending) {
          await service.runCleanup(
            projectRemoteStateRef.current,
            tombstone.id,
            state => persistRemoteState(projectOperation, state)
          );
        }
      }
    );
    try {
      await operation;
      setProjectActionError(null);
    } catch (error) {
      if (isAbortError(error)) return;
      setProjectActionError(`Remote cleanup is still pending: ${getErrorMessage(error)}`);
    }
  };

  const saveApiKey = async (nextApiKey: string): Promise<void> => {
    if (!canMutateWorkspace()) return;
    if (projectOperationOwnerRef.current!.isBusy) {
      setProjectActionError('Wait for project source uploads to finish before changing API keys.');
      return;
    }
    const storedApiKey = settingsRef.current.apiKey;
    if (nextApiKey === storedApiKey) return;
    const oldApiKey = resolveOpenAIApiKey(storedApiKey);
    const nextEffectiveApiKey = resolveOpenAIApiKey(nextApiKey);
    if (nextEffectiveApiKey === oldApiKey) {
      setApiKey(nextApiKey);
      setProjectActionError(null);
      return;
    }
    const oldFingerprint = oldApiKey ? fingerprintApiKey(oldApiKey) : '';
    const ownedIndexes = Object.values(projectRemoteStateRef.current.indexes)
      .filter(index => index.apiKeyFingerprint === oldFingerprint);
    const existingCleanup = projectRemoteStateRef.current.cleanupTombstones
      .filter(tombstone => tombstone.apiKeyFingerprint === oldFingerprint);
    if (ownedIndexes.length > 0 || existingCleanup.length > 0) {
      const operation = projectOperationOwnerRef.current!.enqueue(
        { kind: 'api-key-switch' },
        async projectOperation => {
          if (!oldApiKey) {
            setProjectActionError(
              'The old API key is required to delete existing remote project resources before switching keys.'
            );
            return false;
          }
          if (!window.confirm(
            'Switching API keys must first delete this app’s Files and vector stores under the old key. Continue?'
          )) return false;
          try {
            await flushSavesForOperation(projectOperation);
            const generatedTombstones = ownedIndexes.flatMap(index => {
              const tombstone = createProjectCleanupTombstone(index.projectId, index);
              return tombstone ? [tombstone] : [];
            });
            const state: ProjectRemoteState = {
              indexes: Object.fromEntries(
                Object.entries(projectRemoteStateRef.current.indexes)
                  .filter(([, index]) => index.apiKeyFingerprint !== oldFingerprint)
              ),
              cleanupTombstones: [
                ...projectRemoteStateRef.current.cleanupTombstones,
                ...generatedTombstones
              ]
            };
            await persistRemoteState(projectOperation, state);
            const service = new ProjectSourceService(oldApiKey);
            for (const tombstone of state.cleanupTombstones.filter(
              item => item.apiKeyFingerprint === oldFingerprint
            )) {
              await service.runCleanup(
                projectRemoteStateRef.current,
                tombstone.id,
                nextState => persistRemoteState(projectOperation, nextState)
              );
            }
          } catch (error) {
            if (isAbortError(error)) throw error;
            const resourceIds = projectRemoteStateRef.current.cleanupTombstones
              .filter(item => item.apiKeyFingerprint === oldFingerprint)
              .flatMap(item => [
                ...item.openaiFileIds,
                ...(item.vectorStoreId ? [item.vectorStoreId] : [])
              ]);
            if (
              error instanceof ProjectSourceServiceError &&
              error.kind === 'authentication' &&
              window.confirm([
                'The old API key could not authenticate cleanup.',
                'Delete every listed resource in the OpenAI dashboard first.',
                resourceIds.length > 0 ? `Resources: ${resourceIds.join(', ')}` : '',
                '',
                'Select OK only after confirming those resources are deleted. This will clear the local cleanup records and continue the key switch.'
              ].filter(Boolean).join('\n'))
            ) {
              try {
                await persistRemoteState(projectOperation, {
                  indexes: projectRemoteStateRef.current.indexes,
                  cleanupTombstones: projectRemoteStateRef.current.cleanupTombstones.filter(
                    item => item.apiKeyFingerprint !== oldFingerprint
                  )
                });
              } catch (persistError) {
                if (isAbortError(persistError)) throw persistError;
                setProjectActionError(
                  `Manual cleanup confirmation could not be saved: ${getErrorMessage(persistError)}`
                );
                return false;
              }
            } else {
              setProjectActionError(
                [
                  `API key switch blocked until old remote resources are removed: ${getErrorMessage(error)}`,
                  'Retry cleanup with the old key, or delete these resources in the OpenAI dashboard, save the new key again, and explicitly confirm the manual cleanup.',
                  ...(resourceIds.length > 0 ? [`Resources: ${resourceIds.join(', ')}`] : [])
                ].join(' ')
              );
              return false;
            }
          }
          return true;
        }
      );
      try {
        if (!(await operation)) return;
      } catch (error) {
        reportProjectError(error);
        return;
      }
    }
    setApiKey(nextApiKey);
    setProjectActionError(null);
  };

  const effectiveApiKey = resolveOpenAIApiKey(apiKey);

  useEffect(() => {
    const project = projectsRef.current.find(item => item.id === selectedProjectId);
    if (
      !project ||
      !dirHandleRef.current ||
      !effectiveApiKey ||
      !isWorkspaceLoaded ||
      !workspaceCanWriteRef.current ||
      isWorkspaceMutating ||
      isClosing
    ) return;
    const fingerprint = fingerprintApiKey(effectiveApiKey);
    const reconciliationKey = `${project.id}:${fingerprint}`;
    const pending = projectOperationOwnerRef.current!.enqueue(
      {
        kind: 'reconcile',
        sourceIds: project.sources
          .filter(source => source.capability !== 'direct_attachment')
          .map(source => source.id),
        dedupeKey: reconciliationKey
      },
      async operation => {
        const service = new ProjectSourceService(effectiveApiKey);
        const reconciled = await service.reconcile(
          [project],
          projectRemoteStateRef.current,
          fingerprint,
          state => persistRemoteState(operation, state)
        );
        setRemoteStateForOperation(operation, reconciled);
        const unindexedSources = project.sources.filter(source => (
          source.capability !== 'direct_attachment' &&
          !projectRemoteStateRef.current.indexes[project.id]?.files[source.id]
        ));
        await indexProjectSources(operation, project.id, unindexedSources.map(source => ({
          source,
          loadBlob: async () => {
            const blob = await readProjectSourceBlob(source);
            assertProjectOperationCurrent(operation);
            return blob;
          }
        })));
      }
    );
    void pending?.catch(reportProjectError);
  }, [
    effectiveApiKey,
    draftWorkspaceEpoch,
    isWorkspaceLoaded,
    isWorkspaceMutating,
    isClosing,
    selectedProjectId
  ]);

  const deleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!canMutateWorkspace()) return;

    const deletedSession = sessionsRef.current.find(session => session.id === id);
    if (!deletedSession || !confirmChatDeletion()) return;

    invalidateSessionOperations(id);
    const operation = operationRegistryRef.current.begin({
      id: crypto.randomUUID(),
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
    if (!canMutateWorkspace() || !currentSessionIdRef.current) return;
    const targetSessionId = currentSessionIdRef.current;
    updateSessionsState(prev => prev.map(s =>
      s.id === targetSessionId ? { ...s, config: newConfig } : s
    ));
  };

  const handleCreateSystemInstruction = () => {
    if (!canMutateWorkspace()) return;

    const newId = crypto.randomUUID();
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
      if (!canMutateWorkspace()) return;
      setSystemInstructions(prev => prev.map(si => si.id === updated.id ? updated : si));
  };

  const handleDeleteSystemInstruction = (id: string) => {
      if (!canMutateWorkspace()) return;
      setSystemInstructions(prev => prev.filter(si => si.id !== id));
      if (currentSession && currentSession.config.systemInstructionId === id) {
          updateConfig({ ...currentSession.config, systemInstructionId: undefined });
      }
  };

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
    snapshot: ResponseStreamSnapshot
  ) => {
    updateAssistantMessage(
      sessionId,
      assistantMessageId,
      message => applyResponseStreamSnapshot(
        message,
        snapshot,
        'stopped',
        Date.now()
      ),
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
    modelSnapshot,
    projectContext
  }: {
    operation: OperationRecord;
    targetSessionId: string;
    session: Session;
    messagesForApi: Message[];
    requestId: string;
    assistantMessageId: string;
    modelSnapshot: AssistantModelSnapshot;
    projectContext?: ResolvedProjectContext;
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

    const streamState = new ResponseStreamState();
    const activeRequest: ActiveChatRequest = {
      controller,
      operationId: operation.id,
      assistantMessageId,
      streamState
    };
    activeRequestsRef.current.set(targetSessionId, activeRequest);
    const matchesActiveRequest = (
      request: ActiveChatRequest | undefined
    ): request is ActiveChatRequest => (
      request?.operationId === operation.id &&
      request.assistantMessageId === assistantMessageId
    );

    // Streamed deltas flush once per animation frame while visible and on a
    // short timer while hidden, where animation frames may be suspended.
    let deltaFlushHandle: number | null = null;
    let deltaFlushUsesTimeout = false;

    const cancelScheduledDeltaFlush = () => {
      if (deltaFlushHandle !== null) {
        if (deltaFlushUsesTimeout) window.clearTimeout(deltaFlushHandle);
        else window.cancelAnimationFrame(deltaFlushHandle);
        deltaFlushHandle = null;
        deltaFlushUsesTimeout = false;
      }
    };

    const flushPendingDeltas = () => {
      const { snapshot, textChanged, thinkingChanged } = streamState.checkpoint();
      if (!textChanged && !thinkingChanged) return;

      updateAssistantMessage(
        targetSessionId,
        assistantMessageId,
        message => applyResponseStreamSnapshot(message, snapshot, 'streaming')
      );
    };

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
        outputMessages,
        thinking,
        status: responseStatus,
        incompleteReason,
        sources,
        generatedFiles,
        thinkingDuration,
        responseId,
        usage,
        fileSearchCallCount
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

            streamState.appendThinking(delta);
            scheduleDeltaFlush();
          },
          onTextDelta: (delta, outputIndex, phase) => {
            const activeRequest = activeRequestsRef.current.get(targetSessionId);

            if (
              !matchesActiveRequest(activeRequest) ||
              !isOperationCurrent(operation)
            ) {
              return;
            }

            streamState.appendText(delta, outputIndex, phase);
            scheduleDeltaFlush();
          },
          resolveAttachmentContent: async attachment => {
            const handle = dirHandleRef.current;
            if (!handle) throw new Error('Workspace storage is unavailable.');
            const content = await getAttachmentDataUrl(handle, attachment);
            if (!isOperationCurrent(operation)) throw createOperationAbortError();
            return content;
          },
          projectContext
        }
      );

      const completedRequest = activeRequestsRef.current.get(targetSessionId);
      if (
        !matchesActiveRequest(completedRequest) ||
        !isOperationCurrent(operation) ||
        !sessionsRef.current.some(item => item.id === targetSessionId)
      ) {
        cancelScheduledDeltaFlush();
        streamState.discardPending();
        return;
      }

      // The terminal event carries the authoritative full output; drop any unflushed tail.
      cancelScheduledDeltaFlush();
      streamState.discardPending();

      const newBotMessage: Message = {
        id: assistantMessageId,
        requestId,
        role: 'assistant',
        content: responseText,
        outputMessages,
        status: responseStatus,
        openaiResponseId: responseId,
        thinking,
        incompleteReason,
        thinkingDuration,
        usage,
        fileSearchCallCount,
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
        streamState.discardPending();
        return;
      }

      // Flush tokens received before the stop or failure so partial output survives.
      flushPendingDeltas();

      if (isAbortError(error)) {
        markAssistantStopped(
          targetSessionId,
          assistantMessageId,
          streamState.checkpoint().snapshot
        );
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

  const getProjectContextForRequest = (
    session: Session
  ): ResolvedProjectContext | undefined | null => {
    if (!session.projectId) return undefined;
    const project = projectsRef.current.find(item => item.id === session.projectId);
    if (!project) {
      setProjectActionError('This chat references a project that is no longer available.');
      return null;
    }
    const requestApiKey = resolveOpenAIApiKey(settingsRef.current.apiKey);
    const availability = getProjectSourceAvailability(
      project,
      projectRemoteStateRef.current,
      requestApiKey
    );
    const context = resolveProjectContext(
      project,
      projectRemoteStateRef.current,
      requestApiKey
    );
    if (!availability.ready) {
      const sendWithoutSources = window.confirm([
        'Project sources are unavailable.',
        availability.reason || 'Sources have not finished indexing.',
        '',
        'Select OK to send this one request without project sources. Project instructions still apply.'
      ].join('\n'));
      if (!sendWithoutSources) return null;
      return {
        projectId: context.projectId,
        instructions: context.instructions,
        analysisFileIds: [],
        searchSourceIds: []
      };
    }
    return context;
  };

  // Appends the assistant placeholder with its pending-request marker, then
  // starts the response; the caller owns the operation and processing flag.
  const launchAssistantTurn = ({
    operation,
    session,
    messagesForApi,
    requestId,
    userMessageId,
    assistantMessageId,
    requestTimestamp,
    projectContext,
    draftTitle
  }: {
    operation: OperationRecord;
    session: Session;
    messagesForApi: Message[];
    requestId: string;
    userMessageId: string;
    assistantMessageId: string;
    requestTimestamp: number;
    projectContext?: ResolvedProjectContext;
    draftTitle?: string;
  }): Promise<void> => {
    const modelSnapshot = getAssistantModelSnapshot(session);
    const assistantPlaceholder: Message = {
      id: assistantMessageId,
      requestId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: requestTimestamp,
      ...modelSnapshot
    };
    forceImmediateSessionSaveRef.current = true;
    updateSessionsState(prev => prev.map(s => (
      s.id !== session.id ? s : {
        ...s,
        messages: [...messagesForApi, assistantPlaceholder],
        lastModified: requestTimestamp,
        pendingRequest: {
          id: requestId,
          userMessageId,
          assistantMessageId,
          createdAt: requestTimestamp
        },
        ...(draftTitle !== undefined && s.messages.length === 0 ? { title: draftTitle } : {})
      }
    )));
    return startAssistantResponse({
      operation,
      targetSessionId: session.id,
      session,
      messagesForApi,
      requestId,
      assistantMessageId,
      modelSnapshot,
      projectContext
    });
  };

  const handleSendMessage = async (
    targetSessionId: string,
    content: string,
    attachments: File[]
  ) => {
    if (!canMutateWorkspace()) return false;

    if (processingSessionIdsRef.current.has(targetSessionId)) return false;
    const initialSession = sessionsRef.current.find(s => s.id === targetSessionId);
    if (!initialSession) return false;
    const projectContext = getProjectContextForRequest(initialSession);
    if (projectContext === null) return false;
    const handle = dirHandleRef.current;
    if (!handle) return false;

    const requestId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
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
        revokePreviewUrls(processedAttachments);
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

      if (session.messages.length === 0) {
        const titlePrompt = content || (
          attachments.length > 0
            ? `File analysis of ${attachments[0].name}`
            : 'New Chat'
        );
        const titleOperation = operationRegistryRef.current.begin({
          id: crypto.randomUUID(),
          kind: 'title',
          sessionId: targetSessionId
        });
        void runChatTitleGeneration(titleOperation, targetSessionId, titlePrompt);
      }

      didStartResponse = true;
      void launchAssistantTurn({
        operation,
        session,
        messagesForApi: [...session.messages, newUserMessage],
        requestId,
        userMessageId,
        assistantMessageId,
        requestTimestamp,
        projectContext,
        draftTitle: content.slice(0, 30) + (content.length > 30 ? '...' : '')
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
        id: crypto.randomUUID(),
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
    if (!canMutateWorkspace() || !currentSessionIdRef.current) return;

    const targetSessionId = currentSessionIdRef.current;
    if (processingSessionIdsRef.current.has(targetSessionId)) return;

    const session = sessionsRef.current.find(s => s.id === targetSessionId);
    if (!session) return;
    const projectContext = getProjectContextForRequest(session);
    if (projectContext === null) return;

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

    const requestId = userMessage.requestId || assistantMessage.requestId || crypto.randomUUID();
    const userMessageId = userMessage.id || crypto.randomUUID();
    const newAssistantMessageId = crypto.randomUUID();
    const requestTimestamp = Date.now();
    const messagesForApi = session.messages.slice(0, assistantMessageIndex).map((message, index) => (
      index === assistantMessageIndex - 1 && !message.id
        ? { ...message, id: userMessageId }
        : message
    ));
    const operation = operationRegistryRef.current.begin({
      id: crypto.randomUUID(),
      kind: 'response',
      sessionId: targetSessionId
    });

    addProcessingSession(targetSessionId);
    await launchAssistantTurn({
      operation,
      session,
      messagesForApi,
      requestId,
      userMessageId,
      assistantMessageId: newAssistantMessageId,
      requestTimestamp,
      projectContext
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

  // The only editable turn is the final failed assistant reply and the user
  // message right before it.
  const findEditableFailedTurn = (
    sessionId: string,
    userMessageId: string
  ): Message | null => {
    const session = sessionsRef.current.find(item => item.id === sessionId);
    const lastMessage = session?.messages[session.messages.length - 1];
    const userMessage = session?.messages[session.messages.length - 2];
    return (
      lastMessage?.role === 'assistant' &&
      lastMessage.status === 'error' &&
      userMessage?.role === 'user' &&
      userMessage.id === userMessageId
    ) ? userMessage : null;
  };

  const updateFailedTurnAttachments = (
    sessionId: string,
    userMessageId: string,
    attachments: (current: FileAttachment[] | undefined) => FileAttachment[] | undefined
  ): void => {
    forceImmediateSessionSaveRef.current = true;
    updateSessionsState(prev => prev.map(item => (
      item.id !== sessionId ? item : {
        ...item,
        messages: item.messages.map(message => (
          message.id === userMessageId
            ? { ...message, attachments: attachments(message.attachments) }
            : message
        )),
        lastModified: Date.now()
      }
    )));
  };

  const handleRemoveFailedAttachment = (
    userMessageId: string,
    attachmentIndex: number
  ) => {
    if (!canMutateWorkspace() || !currentSessionIdRef.current) return;

    const targetSessionId = currentSessionIdRef.current;
    const userMessage = findEditableFailedTurn(targetSessionId, userMessageId);
    if (!userMessage) return;

    updateFailedTurnAttachments(targetSessionId, userMessageId, current => (
      current?.filter((_, index) => index !== attachmentIndex)
    ));
    revokePreviewUrls(userMessage.attachments?.slice(attachmentIndex, attachmentIndex + 1));
  };

  const handleReplaceFailedAttachments = async (
    userMessageId: string,
    files: File[]
  ): Promise<string | undefined> => {
    if (!canMutateWorkspace() || !currentSessionIdRef.current) {
      return 'This workspace is read-only.';
    }

    const targetSessionId = currentSessionIdRef.current;
    const userMessage = findEditableFailedTurn(targetSessionId, userMessageId);
    if (!userMessage) return 'This failed turn is no longer available to edit.';

    try {
      const handle = dirHandleRef.current;
      if (!handle) throw new Error('Workspace storage is unavailable.');
      const operation = operationRegistryRef.current.begin({
        id: crypto.randomUUID(),
        kind: 'attachment-replacement',
        sessionId: targetSessionId
      });

      try {
        const replacementAttachments = await storeMessageAttachments(handle, files);
        if (
          !isOperationCurrent(operation) ||
          !findEditableFailedTurn(targetSessionId, userMessageId)
        ) {
          revokePreviewUrls(replacementAttachments);
          return 'This failed turn is no longer available to edit.';
        }

        updateFailedTurnAttachments(targetSessionId, userMessageId, () => replacementAttachments);
        revokePreviewUrls(userMessage.attachments);
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
        activeRequest.streamState.checkpoint().snapshot
      );
    }
  };

  const finishPendingClose = useCallback(async () => {
    const attempt = ++closeAttemptRef.current;
    const isCurrent = () => (
      closeRequestPendingRef.current && closeAttemptRef.current === attempt
    );
    try {
      await projectOperationOwnerRef.current!.pauseAndDrain();
      if (!isCurrent()) return;
      // Project tasks may themselves enter this queue, so drain them first.
      await enqueueDestructiveOperation(async () => {
        if (!isCurrent()) return;
        // Commit pending React updates and their save effects before flushing.
        flushSync(() => setIsClosing(true));
        await flushPendingSaves();
        if (!isCurrent()) return;
        await backupSchedulerRef.current?.runDueForClose();
        if (isCurrent()) window.electronAPI?.confirmClose();
      });
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Failed to finish workspace protection before closing.', error);
      setCloseSaveError(getErrorMessage(error));
    }
  }, [enqueueDestructiveOperation, flushPendingSaves]);

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi) return;

    const unsubscribe = electronApi.onCloseRequested(() => {
      if (closeRequestPendingRef.current) return;
      closeRequestPendingRef.current = true;
      workspaceMutationBlockedRef.current = true;
      setIsClosing(true);
      setCloseSaveError(null);

      const activeRequests = new Map(activeRequestsRef.current);
      operationRegistryRef.current.invalidateWorkspace();
      activeRequests.forEach(request => request.controller.abort());
      activeRequestsRef.current.clear();
      processingSessionIdsRef.current.clear();
      setProcessingSessionIds(new Set());
      checkpointActiveRequests(activeRequests, 'stopped');

      void finishPendingClose();
    });

    return unsubscribe;
  }, [checkpointActiveRequests, finishPendingClose]);

  const retryCloseAfterSaveFailure = async () => {
    const electronApi = window.electronAPI;
    if (!electronApi || !closeRequestPendingRef.current) return;

    setIsRetryingSave(true);
    try {
      await finishPendingClose();
    } finally {
      setIsRetryingSave(false);
    }
  };

  const cancelCloseAfterSaveFailure = () => {
    closeRequestPendingRef.current = false;
    closeAttemptRef.current += 1;
    projectOperationOwnerRef.current!.resume();
    workspaceMutationBlockedRef.current = destructiveOperationQueueRef.current!.isBlocking;
    setIsClosing(false);
    setCloseSaveError(null);
    window.electronAPI?.cancelClose();
  };

  useEffect(() => () => {
    operationRegistryRef.current.invalidateWorkspace();
    saveQueueRef.current?.dispose();
    backupSchedulerRef.current?.dispose();
    workspaceCoordinatorRef.current?.dispose();
    revokeAttachmentPreviewUrls(sessionsRef.current);
  }, []);

  // Data Import/Export Handlers
  const handleExportData = async () => {
    if (!dirHandle) return;
    const mobileViewport = isMobileViewport();
    const controller = new AbortController();
    archiveAbortRef.current?.abort();
    archiveAbortRef.current = controller;
    try {
      const showSaveFilePicker = !mobileViewport && !window.electronAPI
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
      } else if (mobileViewport) {
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
      downloadBlobFile(filename, new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    } catch (e) {
      console.error("Conversation export failed", e);
      alert("Failed to export conversation.");
    }
  };

  const handleImportData = async (file: File) => {
    if (
      !canMutateWorkspace() ||
      !dirHandleRef.current
    ) {
      return;
    }

    const readOperation = operationRegistryRef.current.begin({
      id: crypto.randomUUID(),
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

  const runWorkspaceArchiveMutation = (
    action: WorkspaceRecoveryAction,
    file: File
  ): Promise<void> => enqueueDestructiveOperation(async () => {
    if (action === 'merge') {
      if (
        !workspaceCanWriteRef.current ||
        activeRequestsRef.current.size > 0 ||
        processingSessionIdsRef.current.size > 0 ||
        projectOperationOwnerRef.current!.isBusy
      ) {
        throw new Error('Finish active responses before merging a backup.');
      }
    } else if (projectOperationOwnerRef.current!.isBusy) {
      throw new Error('Wait for project source work to finish before restoring a workspace.');
    }
    await flushPendingSaves();
    invalidateWorkspaceOperations();
    const operation = operationRegistryRef.current.begin({
      id: crypto.randomUUID(),
      kind: `workspace-${action}`
    });
    const handle = dirHandleRef.current;
    try {
      if (!handle || !workspaceCanWriteRef.current) {
        throw createOperationAbortError();
      }
      if (action === 'merge') archiveAbortRef.current?.abort();
      archiveAbortRef.current = operation.controller;
      const mutate = action === 'restore' ? restoreWorkspaceArchive : mergeWorkspaceArchive;
      const result = await mutate(handle, file, {
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
      setUndoWorkspaceAction(action);
    } finally {
      if (archiveAbortRef.current === operation.controller) {
        archiveAbortRef.current = null;
      }
      setArchiveProgress(null);
      operationRegistryRef.current.complete(operation);
    }
  });

  const reportRecoveryFailure = (label: string, error: unknown): void => {
    if (!isAbortError(error)) alert(`${label} failed: ${getErrorMessage(error)}`);
  };

  const confirmWorkspaceRestore = async () => {
    const pending = pendingRestore;
    if (!pending || !dirHandleRef.current) return;
    if (projectOperationOwnerRef.current!.isBusy) {
      alert('Wait for project source uploads to finish before restoring a workspace.');
      return;
    }
    setPendingRestore(null);

    try {
      await runWorkspaceArchiveMutation('restore', pending.file);
    } catch (error) {
      reportRecoveryFailure('Workspace restore', error);
    }
  };

  const handleMergeData = async (file: File) => {
    if (
      !canMutateWorkspace() ||
      activeRequestsRef.current.size > 0 ||
      processingSessionIdsRef.current.size > 0 ||
      projectOperationOwnerRef.current!.isBusy ||
      !dirHandleRef.current
    ) {
      return;
    }

    try {
      await runWorkspaceArchiveMutation('merge', file);
      await backupSchedulerRef.current?.evaluate();
    } catch (error) {
      reportRecoveryFailure('Workspace merge', error);
    }
  };

  const handleUndoWorkspaceMutation = async () => {
    const handle = dirHandleRef.current;
    if (
      !handle ||
      !workspaceCanWriteRef.current ||
      projectOperationOwnerRef.current!.isBusy
    ) return;
    const action = undoWorkspaceAction;
    try {
      await enqueueDestructiveOperation(async () => {
        if (projectOperationOwnerRef.current!.isBusy) {
          throw new Error('Wait for project source work to finish before undoing a workspace change.');
        }
        await flushPendingSaves();
        invalidateWorkspaceOperations();
        await undoLastWorkspaceMutation(handle);
        workspaceCoordinatorRef.current?.publishUpdate(getWorkspaceRevision());
        await loadWorkspaceData(handle, 'writer');
      });
      setUndoWorkspaceAction(null);
      await backupSchedulerRef.current?.evaluate();
    } catch (error) {
      reportRecoveryFailure(`Undo ${action || 'workspace change'}`, error);
    }
  };

  const runBackupAction = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      setBackupActionError(null);
    } catch (error) {
      setBackupActionError(getErrorMessage(error));
    }
  };

  const handleChooseBackupFolder = () => runBackupAction(async () => {
    const destination = await chooseBackupDestination();
    if (destination) await backupSchedulerRef.current?.setDestination(destination);
  });

  const handleReconnectBackupFolder = () => runBackupAction(async () => {
    const destination = await loadBackupDestination();
    if (!destination || !(await reconnectBackupDestination(destination))) {
      throw new Error('Backup folder permission was not granted.');
    }
    await backupSchedulerRef.current?.setDestination(destination);
    await backupSchedulerRef.current?.evaluate();
  });

  const handleToggleAutomaticBackups = (enabled: boolean) => runBackupAction(async () => {
    if (enabled && backupState.destinationStatus === 'unavailable') {
      const destination = await chooseBackupDestination();
      if (!destination) return;
      await backupSchedulerRef.current?.setDestination(destination);
    }
    await backupSchedulerRef.current?.setEnabled(enabled);
  });

  const handleRefreshManagedBackups = () => runBackupAction(async () => {
    await backupSchedulerRef.current?.refresh();
  });

  const handleBackUpNow = () => runBackupAction(async () => {
    await flushPendingSaves();
    await backupSchedulerRef.current?.backUpNow();
  });

  const readManagedBackup = async (filename: string): Promise<Blob> => {
    const archive = await backupSchedulerRef.current?.readBackup(filename);
    if (!archive) throw new Error('The selected backup is unavailable.');
    return archive;
  };

  const handleManagedBackupRestore = (filename: string) => runBackupAction(async () => {
    const archive = await readManagedBackup(filename);
    await handleImportData(new File([archive], filename, { type: 'application/zip' }));
  });

  const handleManagedBackupExport = (filename: string) => runBackupAction(async () => {
    downloadBlobFile(filename, await readManagedBackup(filename));
  });

  const handleManagedBackupDelete = async (filename: string) => {
    if (!window.confirm(`Delete managed backup "${filename}"?`)) return;
    await runBackupAction(async () => {
      await backupSchedulerRef.current?.deleteBackup(filename);
    });
  };

  // Determine if the CURRENT session is loading
  const isCurrentSessionProcessing = currentSessionId ? processingSessionIds.has(currentSessionId) : false;
  const isWorkspaceInteractionReadOnly = isWorkspaceReadOnly || isWorkspaceMutating || isClosing;

  if (isInitializing) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-surface text-ink">
        <div className="flex flex-col items-center gap-4">
          <Spinner size={32} />
          <div className="text-sm font-medium text-ink-2">Loading Workspace...</div>
        </div>
      </div>
    );
  }

  if (workspaceLoadError) {
    return (
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-surface font-sans text-ink">
        {window.electronAPI && (
          <div className="hidden md:block">
            <TitleBar />
          </div>
        )}
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="w-full max-w-lg rounded-2xl border border-danger/30 bg-surface p-6 shadow-card">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger">
                <AlertTriangle size={20} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h1 className="text-base font-semibold text-ink">Workspace storage could not be loaded</h1>
                <p className="mt-2 text-sm leading-6 text-ink-2">
                  OpenAI Studio did not write an empty workspace. Resolve the storage issue below, then retry.
                </p>
                <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-danger-soft p-3 font-mono text-xs text-danger">
                  {workspaceLoadError}
                </pre>
                <Button variant="primary" className="mt-4" onClick={() => window.location.reload()}>
                  Retry
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const openSidebar = () => setIsSidebarOpen(true);
  const toggleSidebarCollapsed = () => setIsSidebarCollapsed(collapsed => !collapsed);
  const toggleConfig = () => setIsConfigOpen(open => !open);
  const statusStripClass =
    'flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b px-4 py-1.5 text-xs font-medium';

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-surface font-sans text-ink">
      {/* Custom Title Bar - Electron desktop only */}
      {window.electronAPI && (
        <div className="hidden md:block">
          <TitleBar />
        </div>
      )}

      {isWorkspaceReadOnly && (
        <div role="status" className={cx(statusStripClass, 'border-warn/30 bg-warn-soft text-warn')}>
          This workspace is open for editing in another tab. This tab is read-only and follows saved changes automatically.
        </div>
      )}

      {isClosing && !closeSaveError && (
        <div role="status" className={cx(statusStripClass, 'border-accent/30 bg-accent-soft text-ink')}>
          <span>Finishing project work and saving before closing…</span>
          <Button size="sm" onClick={cancelCloseAfterSaveFailure}>
            Keep working
          </Button>
        </div>
      )}

      {isWorkspaceMutating && !isClosing && (
        <div role="status" className={cx(statusStripClass, 'border-accent/30 bg-accent-soft text-ink')}>
          Updating workspace… editing and new requests are temporarily paused.
        </div>
      )}

      {saveFailure && (
        <div role="alert" className={cx(statusStripClass, 'border-danger/30 bg-danger-soft text-danger')}>
          <span className="inline-flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
            <span>
              Workspace changes are not saved: {saveFailure.error.message}
              {saveFailure.nextRetryDelayMs === null
                ? ' Automatic retries are paused.'
                : ` Retrying in ${Math.ceil(saveFailure.nextRetryDelayMs / 1000)}s.`}
            </span>
          </span>
          <Button
            size="sm"
            variant="danger"
            icon={RefreshCw}
            iconSize={13}
            onClick={() => void retryPendingSaves()}
            disabled={isRetryingSave || isWorkspaceInteractionReadOnly}
            className={isRetryingSave ? '[&_svg]:animate-spin' : undefined}
          >
            {isRetryingSave ? 'Retrying…' : 'Retry now'}
          </Button>
        </div>
      )}

      {/* Main App Content */}
      <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        {/* Sidebar - desktop: collapsible column, mobile: drawer. Kept free of
            transforms so the fixed settings dialog inside it stays viewport-bound. */}
        {isSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-overlay animate-fade-in md:hidden"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}
        <aside
          className={cx(
            'fixed inset-y-0 left-0 z-50 w-[19rem] max-w-[85vw] overflow-hidden shadow-pop md:static md:z-auto md:max-w-none md:shadow-none md:transition-[width] md:duration-200 md:ease-out',
            isSidebarOpen ? 'block animate-drawer-in' : 'hidden md:block',
            isSidebarCollapsed ? 'md:w-0' : 'md:w-[17rem] md:border-r md:border-line'
          )}
        >
          <div className="h-full w-[19rem] max-w-[85vw] md:w-[17rem] md:max-w-none">
            <Sidebar
              sessions={sessions}
              projects={projects}
              currentSessionId={currentSessionId}
              selectedProjectId={selectedProjectId}
              onSelectSession={handleSelectSession}
              onSelectProject={handleSelectProject}
              onNewProject={createNewProject}
              onNewSession={projectId => {
                createSession(projectId);
                setIsSidebarOpen(false);
              }}
              onDeleteSession={deleteSession}
              onClose={() => setIsSidebarOpen(false)}
              onCollapse={() => setIsSidebarCollapsed(true)}
              isDarkMode={isDarkMode}
              toggleTheme={() => {
                if (canMutateWorkspace()) setIsDarkMode(!isDarkMode);
              }}
              apiKey={apiKey}
              onApiKeySave={saveApiKey}
              pendingRemoteCleanupCount={projectRemoteState.cleanupTombstones.length}
              remoteCleanupError={projectActionError}
              onRetryRemoteCleanup={() => { void retryRemoteCleanup(); }}
              onApiKeyChange={key => {
                if (canMutateWorkspace()) setApiKey(key);
              }}
              onExportData={handleExportData}
              onImportData={handleImportData}
              onMergeData={handleMergeData}
              mergeDisabled={
                isWorkspaceInteractionReadOnly ||
                processingSessionIds.size > 0 ||
                projectOperationStatus.isBusy
              }
              backupState={backupState}
              backupActionError={backupActionError}
              onToggleAutomaticBackups={handleToggleAutomaticBackups}
              onChooseBackupFolder={handleChooseBackupFolder}
              onReconnectBackupFolder={handleReconnectBackupFolder}
              onRefreshManagedBackups={handleRefreshManagedBackups}
              onBackUpNow={handleBackUpNow}
              onRestoreManagedBackup={handleManagedBackupRestore}
              onExportManagedBackup={handleManagedBackupExport}
              onDeleteManagedBackup={handleManagedBackupDelete}
              undoWorkspaceAction={undoWorkspaceAction}
              onUndoWorkspaceMutation={handleUndoWorkspaceMutation}
              processingSessionIds={processingSessionIds}
              readOnly={isWorkspaceInteractionReadOnly}
            />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 overflow-hidden">
          {selectedProject && (
            <ProjectHome
              project={selectedProject}
              sessions={sessions.filter(session => session.projectId === selectedProject.id)}
              remoteIndex={projectRemoteState.indexes[selectedProject.id]}
              totalIndexedUsageBytes={totalIndexedUsageBytes}
              busySourceIds={projectOperationStatus.busySourceIds}
              sourceWorkBusy={projectOperationStatus.isBusy}
              error={projectActionError}
              readOnly={isWorkspaceInteractionReadOnly}
              onUpdate={updateProject}
              onNewChat={() => createSession(selectedProject.id)}
              onAddSources={files => addProjectSources(selectedProject.id, files)}
              onDeleteSource={source => deleteProjectSource(selectedProject.id, source)}
              onRetrySource={source => retryProjectSource(selectedProject.id, source)}
              onDownloadSource={downloadProjectSource}
              onDeleteProject={() => deleteProject(selectedProject.id)}
              onOpenSidebar={openSidebar}
              onToggleSidebar={toggleSidebarCollapsed}
              isSidebarCollapsed={isSidebarCollapsed}
            />
          )}
          <div className={selectedProject ? 'hidden' : 'contents'}>
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
              readOnly={isWorkspaceInteractionReadOnly}
              projectSources={currentSessionProject?.sources.filter(
                source => source.capability === 'direct_attachment'
              ) || []}
              onLoadProjectSource={loadProjectSourceFile}
              project={currentSessionProject || undefined}
              onOpenSidebar={openSidebar}
              onToggleSidebar={toggleSidebarCollapsed}
              isSidebarCollapsed={isSidebarCollapsed}
              onToggleConfig={toggleConfig}
              isConfigOpen={isConfigOpen}
              onNewSession={() => createSession()}
              onNewProject={createNewProject}
            />

            {currentSession && (
              <>
                {isConfigOpen && (
                  <div
                    className="fixed inset-0 z-40 bg-overlay animate-fade-in md:hidden"
                    onClick={() => setIsConfigOpen(false)}
                  />
                )}
                {/* Chat settings: bottom sheet below md, side panel above. */}
                <div
                  className={cx(
                    'fixed inset-x-0 bottom-0 z-50 h-[85dvh] flex-col overflow-hidden rounded-t-2xl border-t border-line bg-canvas shadow-pop md:static md:z-auto md:h-full md:w-[21rem] md:shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none',
                    isConfigOpen ? 'flex animate-sheet-in md:animate-none' : 'hidden'
                  )}
                >
                  <ConfigPanel
                    onClose={() => setIsConfigOpen(false)}
                    config={currentSession.config}
                    onChange={updateConfig}
                    systemInstructions={systemInstructions}
                    onCreateSystemInstruction={handleCreateSystemInstruction}
                    onUpdateSystemInstruction={handleUpdateSystemInstruction}
                    onDeleteSystemInstruction={handleDeleteSystemInstruction}
                    hideSystemInstructions={Boolean(currentSession.projectId)}
                    readOnly={isWorkspaceInteractionReadOnly}
                  />
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      {archiveProgress && (
        <Dialog
          open
          title={archiveProgress.phase === 'preparing'
            ? 'Preparing portable backup…'
            : 'Validating backup integrity…'}
          titleId="archive-progress-title"
          size="sm"
          hideClose
          footer={(
            <Button onClick={() => archiveAbortRef.current?.abort()}>
              Cancel
            </Button>
          )}
        >
          <div role="status" className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-ink-2">
              <Spinner size={14} />
              {archiveProgress.completedEntries} of {archiveProgress.totalEntries} entries
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
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
          </div>
        </Dialog>
      )}

      {pendingRestore && (
        <Dialog
          open
          onClose={() => setPendingRestore(null)}
          title="Restore verified backup?"
          titleId="restore-preview-title"
          description="The archive passed ZIP, size, schema, reference, and SHA-256 validation. A verified recovery point will be created before the workspace changes."
          footer={(
            <>
              <Button onClick={() => setPendingRestore(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void confirmWorkspaceRestore()}>
                Create recovery point and restore
              </Button>
            </>
          )}
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-surface-2 p-3 text-xs">
            <dt className="text-ink-3">Created</dt>
            <dd className="text-ink">{new Date(pendingRestore.preview.createdAt).toLocaleString()}</dd>
            <dt className="text-ink-3">App version</dt>
            <dd className="text-ink">v{pendingRestore.preview.appVersion}</dd>
            <dt className="text-ink-3">Workspace revision</dt>
            <dd className="text-ink">{pendingRestore.preview.workspaceRevision}</dd>
            <dt className="text-ink-3">Sessions / messages</dt>
            <dd className="text-ink">{pendingRestore.preview.counts.sessions} / {pendingRestore.preview.counts.messages}</dd>
            <dt className="text-ink-3">Attachments / files</dt>
            <dd className="text-ink">{pendingRestore.preview.counts.attachments} / {pendingRestore.preview.counts.generatedFiles}</dd>
            <dt className="text-ink-3">Archive size</dt>
            <dd className="text-ink">{(pendingRestore.preview.archiveBytes / (1024 * 1024)).toFixed(1)} MB</dd>
          </dl>
          {pendingRestore.preview.uncachedGeneratedFileCount > 0 && (
            <Callout tone="warn" className="mt-3">
              {pendingRestore.preview.uncachedGeneratedFileCount} generated-file reference(s) were not cached when this backup was created.
            </Callout>
          )}
        </Dialog>
      )}

      {preparedPortableBackup && (
        <Dialog
          open
          onClose={() => setPreparedPortableBackup(null)}
          title="Portable backup ready"
          titleId="portable-backup-ready-title"
          size="sm"
          description={`The verified ZIP is ready. Use the button below to ${preparedPortableBackup.canShare ? 'share or save it' : 'save it'}.`}
          footer={(
            <>
              <Button onClick={() => setPreparedPortableBackup(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleSavePreparedPortableBackup}>
                {preparedPortableBackup.canShare ? 'Share or save' : 'Save backup'}
              </Button>
            </>
          )}
        />
      )}

      {closeSaveError && window.electronAPI && (
        <Dialog
          open
          role="alertdialog"
          tone="danger"
          icon={AlertTriangle}
          hideClose
          title="Couldn’t finish close-time protection"
          titleId="close-save-error-title"
          description="Project work, a workspace save, or a due backup failed. Retry saving, or choose Keep working to resolve failed project work. Closing without the backup can lose unsaved changes and remote cleanup records."
          footer={(
            <>
              <Button onClick={cancelCloseAfterSaveFailure} disabled={isRetryingSave}>
                Keep working
              </Button>
              <Button
                variant="danger"
                onClick={() => window.electronAPI?.confirmClose()}
                disabled={isRetryingSave}
              >
                Close without backup
              </Button>
              <Button
                variant="primary"
                icon={RefreshCw}
                onClick={() => void retryCloseAfterSaveFailure()}
                disabled={isRetryingSave}
                className={isRetryingSave ? '[&_svg]:animate-spin' : undefined}
              >
                {isRetryingSave ? 'Retrying…' : 'Retry'}
              </Button>
            </>
          )}
        >
          <pre className="max-h-28 overflow-auto rounded-lg bg-danger-soft p-3 font-mono text-xs text-danger">
            {closeSaveError}
          </pre>
        </Dialog>
      )}
    </div>
  );
}

export default App;
