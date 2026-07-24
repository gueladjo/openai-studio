
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Sidebar } from './components/Sidebar';
import { ConfigPanel } from './components/ConfigPanel';
import { ChatArea } from './components/ChatArea';
import { TitleBar } from './components/TitleBar';
import { Session, ChatConfig, Message, DEFAULT_CONFIG, SystemInstruction } from './types';
import { cancelResponse, generateResponse, generateChatTitle } from './services/openaiService';
import {
  getStorageHandle,
  readJsonFile,
  writeJsonFile,
  readSessions,
  writeSessions,
  storeAttachment,
  getAttachmentDataUrl,
  getWorkspaceBackup,
  restoreWorkspaceBackup,
  synchronizeWorkspaceRevision,
  getWorkspaceRevision,
  WorkspaceRevisionConflictError,
  STORAGE_FILES,
  AppSettings,
  WorkspaceBackup
} from './services/storage';
import { WorkspaceCoordinator, WorkspaceRole } from './services/workspaceSync';
import {
  buildConversationFilename,
  downloadTextFile,
  formatConversationMarkdown
} from './utils/conversationExport';
import { confirmChatDeletion } from './utils/chatDeletion';
import { normalizeChatConfig } from './constants';
import { AlertTriangle, Loader2, Menu, Settings, X } from 'lucide-react';

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

interface ActiveChatRequest {
  controller: AbortController;
  assistantMessageId: string;
  apiKey: string;
  responseId?: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isValidBackupSessions = (value: unknown): value is Session[] => (
  Array.isArray(value) && value.every(session => (
    isRecord(session) &&
    typeof session.id === 'string' &&
    typeof session.title === 'string' &&
    typeof session.lastModified === 'number' &&
    isRecord(session.config) &&
    Array.isArray(session.messages) &&
    session.messages.every(message => (
      isRecord(message) &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      typeof message.timestamp === 'number' &&
      (
        message.attachments === undefined ||
        (
          Array.isArray(message.attachments) &&
          message.attachments.every(attachment => (
            isRecord(attachment) &&
            typeof attachment.name === 'string' &&
            typeof attachment.type === 'string' &&
            (
              attachment.id === undefined ||
              (typeof attachment.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(attachment.id))
            ) &&
            (
              attachment.content === undefined ||
              (typeof attachment.content === 'string' && attachment.content.startsWith('data:'))
            ) &&
            (attachment.id === undefined || attachment.content !== undefined)
          ))
        )
      )
    ))
  ))
);

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
  const sessionsRef = useRef<Session[]>([]);
  const dirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const isWorkspaceLoadedRef = useRef(false);
  const workspaceCanWriteRef = useRef(false);
  const workspaceCoordinatorRef = useRef<WorkspaceCoordinator | null>(null);
  const workspaceReloadPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const initializationStartedRef = useRef(false);

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
    setCurrentSessionId(id);
    if (isMobile) setIsSidebarOpen(false);
  }, [isMobile]);

  const saveTimeoutRef = useRef<Partial<Record<SaveKey, number>>>({});
  const saveDirtySinceRef = useRef<Partial<Record<SaveKey, number>>>({});
  const saveVersionRef = useRef<Record<SaveKey, number>>({
    sessions: 0,
    instructions: 0,
    settings: 0
  });
  const savedVersionRef = useRef<Record<SaveKey, number>>({
    sessions: 0,
    instructions: 0,
    settings: 0
  });
  const immediateSaveVersionRef = useRef<Record<SaveKey, number>>({
    sessions: 0,
    instructions: 0,
    settings: 0
  });
  const queuedSaveKeysRef = useRef<Set<SaveKey>>(new Set());
  const saveDrainPromiseRef = useRef<Promise<void> | null>(null);
  const forceImmediateSessionSaveRef = useRef(false);
  const skipNextSessionEffectSaveRef = useRef(false);

  const persistSaveKey = useCallback(async (key: SaveKey): Promise<void> => {
    const handle = dirHandleRef.current;
    if (!handle || !isWorkspaceLoadedRef.current || !workspaceCanWriteRef.current) return;

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
    } catch (error) {
      if (error instanceof WorkspaceRevisionConflictError) {
        workspaceCanWriteRef.current = false;
        setIsWorkspaceReadOnly(true);
        workspaceCoordinatorRef.current?.relinquishWriter();
      }
      throw error;
    }
  }, []);

  const startSaveDrain = useCallback((): Promise<void> => {
    if (saveDrainPromiseRef.current) return saveDrainPromiseRef.current;

    const drain = (async () => {
      while (queuedSaveKeysRef.current.size > 0) {
        const keys = Array.from(queuedSaveKeysRef.current);
        queuedSaveKeysRef.current.clear();
        let firstError: unknown;

        for (const key of keys) {
          const version = saveVersionRef.current[key];

          try {
            await persistSaveKey(key);
            savedVersionRef.current[key] = Math.max(savedVersionRef.current[key], version);

            if (saveVersionRef.current[key] === version) {
              queuedSaveKeysRef.current.delete(key);
              delete saveDirtySinceRef.current[key];
              if (immediateSaveVersionRef.current[key] <= version) {
                immediateSaveVersionRef.current[key] = 0;
              }

              const timeout = saveTimeoutRef.current[key];
              if (timeout !== undefined) {
                window.clearTimeout(timeout);
                delete saveTimeoutRef.current[key];
              }
            } else {
              const timeout = saveTimeoutRef.current[key];
              if (timeout !== undefined) window.clearTimeout(timeout);

              if (immediateSaveVersionRef.current[key] > version) {
                queuedSaveKeysRef.current.add(key);
                delete saveTimeoutRef.current[key];
              } else {
                // A regular change landed while this snapshot was being written.
                // Start a fresh window instead of writing continuously.
                saveDirtySinceRef.current[key] = Date.now();
                queuedSaveKeysRef.current.delete(key);
                saveTimeoutRef.current[key] = window.setTimeout(() => {
                  delete saveTimeoutRef.current[key];
                  queuedSaveKeysRef.current.add(key);
                  void startSaveDrain().catch(error => {
                    console.error(`Failed to persist ${key}`, error);
                  });
                }, SAVE_DELAYS[key]);
              }
            }
          } catch (error) {
            if (!firstError) firstError = error;
          }
        }

        if (firstError) throw firstError;
      }
    })();

    const trackedDrain = drain.finally(() => {
      if (saveDrainPromiseRef.current === trackedDrain) {
        saveDrainPromiseRef.current = null;
      }
    });
    saveDrainPromiseRef.current = trackedDrain;
    return trackedDrain;
  }, [persistSaveKey]);

  const scheduleSave = useCallback((key: SaveKey, immediate = false): void => {
    if (
      !dirHandleRef.current ||
      !isWorkspaceLoadedRef.current ||
      !workspaceCanWriteRef.current
    ) {
      return;
    }

    saveVersionRef.current[key] += 1;
    if (immediate) {
      immediateSaveVersionRef.current[key] = saveVersionRef.current[key];
    }

    const now = Date.now();
    if (saveDirtySinceRef.current[key] === undefined) {
      saveDirtySinceRef.current[key] = now;
    }

    const existingTimeout = saveTimeoutRef.current[key];
    if (existingTimeout !== undefined) window.clearTimeout(existingTimeout);

    const delay = immediate
      ? 0
      : key === 'sessions'
        ? Math.min(
            SAVE_DELAYS[key],
            Math.max(0, SESSION_SAVE_MAX_WAIT_MS - (now - (saveDirtySinceRef.current[key] || now)))
          )
        : SAVE_DELAYS[key];

    saveTimeoutRef.current[key] = window.setTimeout(() => {
      delete saveTimeoutRef.current[key];
      queuedSaveKeysRef.current.add(key);
      void startSaveDrain().catch(error => {
        console.error(`Failed to persist ${key}`, error);
      });
    }, delay);
  }, [startSaveDrain]);

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

    const targetVersions = new Map<SaveKey, number>();

    keys.forEach(key => {
      targetVersions.set(key, saveVersionRef.current[key]);

      const timeout = saveTimeoutRef.current[key];
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
        delete saveTimeoutRef.current[key];
      }

      if (savedVersionRef.current[key] < saveVersionRef.current[key]) {
        queuedSaveKeysRef.current.add(key);
      }
    });

    while (true) {
      if (saveDrainPromiseRef.current || queuedSaveKeysRef.current.size > 0) {
        await startSaveDrain();
      }

      const outstandingKeys = keys.filter(key => (
        savedVersionRef.current[key] < (targetVersions.get(key) || 0)
      ));
      if (outstandingKeys.length === 0) return;

      outstandingKeys.forEach(key => queuedSaveKeysRef.current.add(key));
    }
  }, [startSaveDrain]);

  const addProcessingSession = (sessionId: string) => {
    processingSessionIdsRef.current.add(sessionId);
    setProcessingSessionIds(new Set(processingSessionIdsRef.current));
  };

  const removeProcessingSession = (sessionId: string) => {
    processingSessionIdsRef.current.delete(sessionId);
    setProcessingSessionIds(new Set(processingSessionIdsRef.current));
  };

  const markPendingRequestsFailed = (loadedSessions: Session[]): Session[] => {
    const now = Date.now();
    let hasChanges = false;

    const updatedSessions = loadedSessions.map(session => {
      if (!session.pendingRequest) return session;

      hasChanges = true;
      const interruptedContent = 'Error: Previous request was interrupted and has been marked as failed. Please retry if needed.';
      const failureMessage: Message = {
        id: uuidv4(),
        requestId: session.pendingRequest.id,
        role: 'assistant',
        content: interruptedContent,
        status: 'error',
        timestamp: now
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
    role: WorkspaceRole
  ) => {
    let loadedSessions: Session[] = [];
    let loadedSettings: AppSettings | null = null;
    let loadedInstructions: SystemInstruction[] | null = null;

    // A reader retries if a broadcast lands while its snapshot is being read.
    // The writer is already protected by the exclusive workspace lock.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revisionBeforeRead = await synchronizeWorkspaceRevision(handle);
      [loadedSessions, loadedSettings, loadedInstructions] = await Promise.all([
        readSessions(handle, { readOnly: role === 'reader' }),
        readJsonFile<AppSettings>(handle, STORAGE_FILES.SETTINGS),
        readJsonFile<SystemInstruction[]>(handle, STORAGE_FILES.INSTRUCTIONS)
      ]);
      const revisionAfterRead = await synchronizeWorkspaceRevision(handle);

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

    setSessions(cleanedSessions);
    setSystemInstructions(nextInstructions);
    setIsDarkMode(loadedSettings ? loadedSettings.theme === 'dark' : true);
    setApiKey(loadedSettings?.apiKey || '');
    setCurrentSessionId(nextCurrentSessionId);
  };

  // 1. Initial Mount: Automatically access storage
  useEffect(() => {
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;

    const init = async () => {
      try {
        const coordinator = await WorkspaceCoordinator.create();
        workspaceCoordinatorRef.current = coordinator;
        const handle = await getStorageHandle();
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
            activeRequestsRef.current.forEach(request => request.controller.abort());
            activeRequestsRef.current.clear();
            processingSessionIdsRef.current.clear();
            setProcessingSessionIds(new Set());
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
        setSessions(checkpointedSessions);
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


  // --- App Logic ---

  const currentSession = sessions.find(s => s.id === currentSessionId) || null;

  const createNewSession = () => {
    if (!workspaceCanWriteRef.current) return;

    const configToUse = currentSession ? { ...currentSession.config } : { ...DEFAULT_CONFIG };
    
    const newSession: Session = {
      id: uuidv4(),
      title: 'New Chat',
      messages: [],
      config: configToUse,
      lastModified: Date.now(),
    };
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
  };

  const deleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!workspaceCanWriteRef.current) return;

    const deletedSession = sessions.find(session => session.id === id);
    if (!deletedSession || !confirmChatDeletion()) return;

    const newSessions = sessions.filter(s => s.id !== id);
    forceImmediateSessionSaveRef.current = true;
    setSessions(newSessions);
    revokeAttachmentPreviewUrls([deletedSession]);
    if (currentSessionId === id) {
      setCurrentSessionId(newSessions.length > 0 ? newSessions[0].id : null);
    }
  };

  const updateConfig = (newConfig: ChatConfig) => {
    if (!workspaceCanWriteRef.current || !currentSessionId) return;
    setSessions(prev => prev.map(s => 
      s.id === currentSessionId ? { ...s, config: newConfig } : s
    ));
  };

  const handleCreateSystemInstruction = () => {
     if (!workspaceCanWriteRef.current) return;

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
      if (!workspaceCanWriteRef.current) return;
      setSystemInstructions(prev => prev.map(si => si.id === updated.id ? updated : si));
  };

  const handleDeleteSystemInstruction = (id: string) => {
      if (!workspaceCanWriteRef.current) return;
      setSystemInstructions(prev => prev.filter(si => si.id !== id));
      if (currentSession && currentSession.config.systemInstructionId === id) {
          updateConfig({ ...currentSession.config, systemInstructionId: undefined });
      }
  };

  const createAssistantPlaceholder = (
    id: string,
    requestId: string,
    session: Session,
    timestamp: number
  ): Message => ({
    id,
    requestId,
    role: 'assistant',
    content: '',
    status: 'streaming',
    timestamp,
    model: session.config.model,
    reasoningEffort: session.config.reasoningEffort
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

    setSessions(prev => prev.map(s => {
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
    targetSessionId,
    session,
    messagesForApi,
    requestId,
    assistantMessageId
  }: {
    targetSessionId: string;
    session: Session;
    messagesForApi: Message[];
    requestId: string;
    assistantMessageId: string;
  }) => {
    const controller = new AbortController();
    activeRequestsRef.current.set(targetSessionId, {
      controller,
      assistantMessageId,
      apiKey
    });

    // Streamed deltas flush once per animation frame while visible and on a
    // short timer while hidden, where animation frames may be suspended.
    let streamedContent = '';
    let streamedThinking = '';
    let pendingDelta = '';
    let pendingThinkingDelta = '';
    let deltaFlushHandle: number | null = null;
    let deltaFlushUsesTimeout = false;
    const activeRequest = activeRequestsRef.current.get(targetSessionId);
    if (activeRequest?.assistantMessageId === assistantMessageId) {
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

    if (activeRequest?.assistantMessageId === assistantMessageId) {
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
        if (flushRequest?.assistantMessageId !== assistantMessageId) return;

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
          onResponseCreated: (createdResponseId) => {
            const activeRequest = activeRequestsRef.current.get(targetSessionId);

            if (activeRequest?.assistantMessageId === assistantMessageId) {
              activeRequest.responseId = createdResponseId;
            }
          },
          onReasoningSummaryDelta: (delta) => {
            const activeRequest = activeRequestsRef.current.get(targetSessionId);

            if (activeRequest?.assistantMessageId !== assistantMessageId) return;

            pendingThinkingDelta += delta;
            scheduleDeltaFlush();
          },
          onTextDelta: (delta) => {
            const activeRequest = activeRequestsRef.current.get(targetSessionId);

            if (activeRequest?.assistantMessageId !== assistantMessageId) return;

            pendingDelta += delta;
            scheduleDeltaFlush();
          },
          resolveAttachmentContent: async attachment => {
            const handle = dirHandleRef.current;
            if (!handle) throw new Error('Workspace storage is unavailable.');
            return getAttachmentDataUrl(handle, attachment);
          }
        }
      );

      const completedRequest = activeRequestsRef.current.get(targetSessionId);
      if (completedRequest?.assistantMessageId !== assistantMessageId) {
        cancelScheduledDeltaFlush();
        pendingDelta = '';
        pendingThinkingDelta = '';
        return;
      }

      // response.completed carries the authoritative full text; drop any unflushed tail.
      cancelScheduledDeltaFlush();
      pendingDelta = '';
      pendingThinkingDelta = '';

      const newBotMessage: Message = {
        id: assistantMessageId,
        requestId,
        role: 'assistant',
        content: responseText,
        status: 'complete',
        openaiResponseId: responseId,
        thinking,
        thinkingDuration,
        usage,
        sources,
        generatedFiles,
        timestamp: Date.now(),
        model: session.config.model,
        reasoningEffort: session.config.reasoningEffort
      };

      updateAssistantMessage(
        targetSessionId,
        assistantMessageId,
        () => newBotMessage,
        true
      );
    } catch (error) {
      const failedRequest = activeRequestsRef.current.get(targetSessionId);
      if (failedRequest?.assistantMessageId !== assistantMessageId) {
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
            model: session.config.model,
            reasoningEffort: session.config.reasoningEffort
          }),
          true
        );
      }
    } finally {
      const activeRequest = activeRequestsRef.current.get(targetSessionId);

      if (activeRequest?.assistantMessageId === assistantMessageId) {
        activeRequestsRef.current.delete(targetSessionId);
        removeProcessingSession(targetSessionId);
      } else if (!activeRequest) {
        removeProcessingSession(targetSessionId);
      }
    }
  };

  const handleSendMessage = async (content: string, attachments: File[]) => {
    if (!workspaceCanWriteRef.current || !currentSessionId) return false;

    // Capture the session ID to allow context switching while processing
    const targetSessionId = currentSessionId;
    if (processingSessionIdsRef.current.has(targetSessionId)) return false;
    addProcessingSession(targetSessionId);
    let didStartResponse = false;

    try {
      const session = sessionsRef.current.find(s => s.id === targetSessionId);
      if (!session) throw new Error("Session lost");
      const handle = dirHandleRef.current;
      if (!handle) throw new Error('Workspace storage is unavailable.');

      const storedAttachments = await Promise.all(attachments.map(async file => ({
        file,
        id: await storeAttachment(handle, file)
      })));
      const processedAttachments = storedAttachments.map(({ file, id }) => {
        return {
          id,
          name: file.name,
          type: file.type,
          ...(file.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(file) } : {})
        };
      });

      const requestId = uuidv4();
      const userMessageId = uuidv4();
      const assistantMessageId = uuidv4();
      const requestTimestamp = Date.now();

      const newUserMessage: Message = {
        id: userMessageId,
        requestId,
        role: 'user',
        content,
        timestamp: requestTimestamp,
        attachments: processedAttachments
      };
      const assistantPlaceholder = createAssistantPlaceholder(
        assistantMessageId,
        requestId,
        session,
        requestTimestamp
      );

      // Trigger background title generation for new sessions
      if (session.messages.length === 0) {
        // Use the content or a placeholder if only attachments exist
        const titlePrompt = content || (attachments.length > 0 ? `File analysis of ${attachments[0].name}` : "New Chat");
        generateChatTitle(titlePrompt, apiKey).then(newTitle => {
          if (!workspaceCanWriteRef.current) return;
          setSessions(prev => prev.map(s => 
            s.id === targetSessionId ? { ...s, title: newTitle } : s
          ));
        });
      }

      // 1. Optimistically update UI with user message + pending request marker
      forceImmediateSessionSaveRef.current = true;
      setSessions(prev => prev.map(s => {
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

      // 2. Perform API Call Detached from current UI State
      const messagesForApi = [...session.messages, newUserMessage];
      didStartResponse = true;
      void startAssistantResponse({
        targetSessionId,
        session,
        messagesForApi,
        requestId,
        assistantMessageId
      });
      return true;

    } catch (error) {
      forceImmediateSessionSaveRef.current = true;
      const errorMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        status: 'error',
        timestamp: Date.now()
      };
       setSessions(prev => prev.map(s => {
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
        removeProcessingSession(targetSessionId);
      }
    }
  };

  const restartAssistantResponse = async (assistantMessageIndex: number) => {
    if (!workspaceCanWriteRef.current || !currentSessionId) return;

    const targetSessionId = currentSessionId;
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
    const assistantPlaceholder = createAssistantPlaceholder(
      newAssistantMessageId,
      requestId,
      session,
      requestTimestamp
    );

    addProcessingSession(targetSessionId);
    forceImmediateSessionSaveRef.current = true;

    setSessions(prev => prev.map(s => {
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
      targetSessionId,
      session,
      messagesForApi,
      requestId,
      assistantMessageId: newAssistantMessageId
    });
  };

  const handleRetryFailedMessage = async (assistantMessageId: string) => {
    const session = sessionsRef.current.find(s => s.id === currentSessionId);
    const assistantMessageIndex = session?.messages.findIndex(message => (
      message.id === assistantMessageId
    ));

    if (assistantMessageIndex === undefined) return;
    await restartAssistantResponse(assistantMessageIndex);
  };

  const handleRegenerateLatestResponse = async () => {
    const session = sessionsRef.current.find(s => s.id === currentSessionId);
    await restartAssistantResponse((session?.messages.length ?? 0) - 1);
  };

  const handleStopGenerating = () => {
    if (!workspaceCanWriteRef.current || !currentSessionId) return;

    const targetSessionId = currentSessionId;
    const activeRequest = activeRequestsRef.current.get(targetSessionId);
    if (!activeRequest) return;

    if (activeRequest.responseId) {
      cancelResponse(activeRequest.responseId, activeRequest.apiKey).catch(error => {
        console.warn('Failed to cancel OpenAI response:', error);
      });
    }

    activeRequest.controller.abort();
    activeRequestsRef.current.delete(targetSessionId);
    removeProcessingSession(targetSessionId);
    markAssistantStopped(
      targetSessionId,
      activeRequest.assistantMessageId,
      activeRequest.checkpointPartialContent?.() || activeRequest.getPartialContent?.(),
      activeRequest.checkpointPartialThinking?.() || activeRequest.getPartialThinking?.()
    );
  };

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.onCloseRequested) return;

    let isClosing = false;
    const unsubscribe = electronApi.onCloseRequested(() => {
      if (isClosing) return;
      isClosing = true;

      const activeRequests = new Map(activeRequestsRef.current);
      const now = Date.now();

      activeRequests.forEach(request => {
        if (request.responseId) {
          cancelResponse(request.responseId, request.apiKey).catch(error => {
            console.warn('Failed to cancel OpenAI response while closing:', error);
          });
        }
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
        setSessions(stoppedSessions);
        scheduleSave('sessions', true);
      }

      void flushPendingSaves()
        .catch(error => {
          console.error('Failed to flush workspace data before closing.', error);
        })
        .finally(() => electronApi.confirmClose());
    });

    return unsubscribe;
  }, [flushPendingSaves, scheduleSave]);

  useEffect(() => () => {
    Object.values(saveTimeoutRef.current).forEach(timeout => {
      if (timeout !== undefined) window.clearTimeout(timeout);
    });
    workspaceCoordinatorRef.current?.dispose();
    revokeAttachmentPreviewUrls(sessionsRef.current);
  }, []);

  // Data Import/Export Handlers
  const handleExportData = async () => {
    if (!dirHandle) return;
    try {
      await flushPendingSaves();
      const backup = await getWorkspaceBackup(dirHandle, {
        readOnly: !workspaceCanWriteRef.current
      });
      if (workspaceCanWriteRef.current) {
        workspaceCoordinatorRef.current?.publishUpdate(getWorkspaceRevision());
      }
      downloadTextFile(
        `openai-studio-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(backup, null, 2),
        'application/json;charset=utf-8'
      );
    } catch (e) {
      console.error("Export failed", e);
      alert("Failed to export workspace data.");
    }
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
    if (!workspaceCanWriteRef.current || !dirHandle) return;
    try {
      const text = await file.text();
      const parsedBackup = JSON.parse(text) as unknown;

      if (!isRecord(parsedBackup) || !isValidBackupSessions(parsedBackup.sessions)) {
        throw new Error("Invalid backup format");
      }
      if (
        parsedBackup.instructions !== undefined &&
        (
          !Array.isArray(parsedBackup.instructions) ||
          !parsedBackup.instructions.every(instruction => (
            isRecord(instruction) &&
            typeof instruction.id === 'string' &&
            typeof instruction.title === 'string' &&
            typeof instruction.content === 'string'
          ))
        )
      ) {
        throw new Error("Invalid backup instructions");
      }
      if (
        parsedBackup.settings !== undefined &&
        parsedBackup.settings !== null &&
        (
          !isRecord(parsedBackup.settings) ||
          (parsedBackup.settings.theme !== 'dark' && parsedBackup.settings.theme !== 'light') ||
          (
            parsedBackup.settings.lastActiveSessionId !== undefined &&
            typeof parsedBackup.settings.lastActiveSessionId !== 'string'
          ) ||
          (
            parsedBackup.settings.apiKey !== undefined &&
            typeof parsedBackup.settings.apiKey !== 'string'
          )
        )
      ) {
        throw new Error("Invalid backup settings");
      }

      const backup = parsedBackup as unknown as WorkspaceBackup;
      
      // Confirm replacement
      if (!window.confirm("This will overwrite your current workspace with the backup data. Continue?")) return;

      activeRequestsRef.current.forEach(request => {
        if (request.responseId) {
          cancelResponse(request.responseId, request.apiKey).catch(error => {
            console.warn('Failed to cancel OpenAI response before import:', error);
          });
        }
        request.controller.abort();
      });
      activeRequestsRef.current.clear();
      processingSessionIdsRef.current.clear();
      setProcessingSessionIds(new Set());

      await flushPendingSaves();
      await restoreWorkspaceBackup(dirHandle, backup);
      workspaceCoordinatorRef.current?.publishUpdate(getWorkspaceRevision());
      await loadWorkspaceData(dirHandle, 'writer');
      alert("Workspace restored successfully.");
    } catch (e) {
      console.error("Import failed", e);
      alert("Failed to import data. The file might be corrupted or invalid.");
    }
  };

  // Determine if the CURRENT session is loading
  const isCurrentSessionProcessing = currentSessionId ? processingSessionIds.has(currentSessionId) : false;

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
                    OpenAI Studio did not write an empty workspace. Close the app, back up your AppData folder, then retry.
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
              onSelectSession={setCurrentSessionId}
              onNewSession={createNewSession}
              onDeleteSession={deleteSession}
              isDarkMode={isDarkMode}
              toggleTheme={() => {
                if (workspaceCanWriteRef.current) setIsDarkMode(!isDarkMode);
              }}
              apiKey={apiKey}
              onApiKeyChange={key => {
                if (workspaceCanWriteRef.current) setApiKey(key);
              }}
              onExportData={handleExportData}
              onImportData={handleImportData}
              processingSessionIds={processingSessionIds}
              readOnly={isWorkspaceReadOnly}
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
                      if (workspaceCanWriteRef.current) setIsDarkMode(!isDarkMode);
                    }}
                    apiKey={apiKey}
                    onApiKeyChange={key => {
                      if (workspaceCanWriteRef.current) setApiKey(key);
                    }}
                    onExportData={handleExportData}
                    onImportData={handleImportData}
                    processingSessionIds={processingSessionIds}
                    isMobile={true}
                    readOnly={isWorkspaceReadOnly}
                  />
                </div>
              </div>
            </>
          )}

          <main className="flex-1 flex min-w-0 w-full overflow-hidden">
            <ChatArea
              session={currentSession}
              onSendMessage={handleSendMessage}
              onStopGenerating={handleStopGenerating}
              onRetryFailedMessage={handleRetryFailedMessage}
              onRegenerateResponse={handleRegenerateLatestResponse}
              onShareConversation={handleShareConversation}
              apiKey={apiKey}
              isLoading={isCurrentSessionProcessing}
              isMobile={isMobile}
              readOnly={isWorkspaceReadOnly}
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
                readOnly={isWorkspaceReadOnly}
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
              <div className="flex-1 overflow-y-auto">
                <ConfigPanel
                  config={currentSession.config}
                  onChange={updateConfig}
                  systemInstructions={systemInstructions}
                  onCreateSystemInstruction={handleCreateSystemInstruction}
                  onUpdateSystemInstruction={handleUpdateSystemInstruction}
                  onDeleteSystemInstruction={handleDeleteSystemInstruction}
                  isMobile={true}
                  readOnly={isWorkspaceReadOnly}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
