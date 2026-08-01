// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import {
  DEFAULT_CONFIG,
  type AssistantOutputMessage,
  type AssistantPhase,
  type GeneratedFile,
  type Message,
  type Session,
  type SystemInstruction
} from './types';

interface CapturedChatAreaProps {
  session: Session | null;
  onSendMessage: (
    sessionId: string,
    content: string,
    attachments: File[]
  ) => Promise<boolean>;
  onStopGenerating: () => void;
  onDownloadGeneratedFile: (file: GeneratedFile) => Promise<Blob>;
}

interface CapturedSidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (event: React.MouseEvent, sessionId: string) => void;
  onExportData: () => Promise<void>;
  onImportData: (file: File) => Promise<void>;
  onMergeData: (file: File) => Promise<void>;
  mergeDisabled: boolean;
  undoWorkspaceAction: 'merge' | 'restore' | null;
  onUndoWorkspaceMutation: () => Promise<void>;
}

interface GenerateOptions {
  signal?: AbortSignal;
  onTextDelta?: (
    delta: string,
    outputIndex?: number,
    phase?: AssistantPhase
  ) => void;
  onReasoningSummaryDelta?: (delta: string) => void;
}

interface GenerateResult {
  content: string;
  outputMessages?: AssistantOutputMessage[];
  thinking: string;
  status: 'complete' | 'incomplete';
  sources: [];
  thinkingDuration: number;
  responseId: string;
  generatedFiles?: GeneratedFile[];
}

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const mocks = vi.hoisted(() => ({
  apiKey: 'workspace-key',
  chatAreaProps: null as CapturedChatAreaProps | null,
  confirmChatDeletion: vi.fn(),
  coordinator: {
    canWrite: true,
    currentRole: 'writer' as 'writer' | 'reader',
    dispose: vi.fn(),
    publishUpdate: vi.fn(),
    relinquishWriter: vi.fn(),
    subscribeToRole: vi.fn(),
    subscribeToUpdates: vi.fn()
  },
  createWorkspaceArchive: vi.fn(),
  createCoordinator: vi.fn(),
  currentRevision: 0,
  generateChatTitle: vi.fn(),
  generateResponse: vi.fn(),
  fetchGeneratedFileContent: vi.fn(),
  getActiveStorageBackend: vi.fn(),
  getAttachmentDataUrl: vi.fn(),
  getStorageHandle: vi.fn(),
  getWorkspaceBackup: vi.fn(),
  inspectWorkspaceArchive: vi.fn(),
  loadedInstructions: [] as SystemInstruction[],
  loadedSessions: [] as Session[],
  mergeWorkspaceArchive: vi.fn(),
  parseWorkspaceBackup: vi.fn(),
  readJsonFile: vi.fn(),
  readLocalBlob: vi.fn(),
  readSessions: vi.fn(),
  readWorkspaceSnapshot: vi.fn(),
  restoreWorkspaceBackup: vi.fn(),
  restoreWorkspaceArchive: vi.fn(),
  sidebarProps: null as CapturedSidebarProps | null,
  storeAttachment: vi.fn(),
  storeLocalBlob: vi.fn(),
  subscribeToStorageBackendChanges: vi.fn(),
  synchronizeWorkspaceRevision: vi.fn(),
  undoLastWorkspaceMutation: vi.fn(),
  uuidCounter: 0,
  validateWorkspaceReferences: vi.fn(),
  writeJsonFile: vi.fn(),
  writeSessions: vi.fn()
}));

vi.mock('uuid', () => ({
  v4: () => `uuid-${++mocks.uuidCounter}`
}));

vi.mock('./components/ChatArea', () => ({
  ChatArea: (props: CapturedChatAreaProps) => {
    mocks.chatAreaProps = props;
    return null;
  }
}));

vi.mock('./components/Sidebar', () => ({
  Sidebar: (props: CapturedSidebarProps) => {
    mocks.sidebarProps = props;
    return null;
  }
}));

vi.mock('./components/ConfigPanel', () => ({
  ConfigPanel: () => null
}));

vi.mock('./components/TitleBar', () => ({
  TitleBar: () => null
}));

vi.mock('./services/openaiService', () => ({
  fetchGeneratedFileContent: mocks.fetchGeneratedFileContent,
  generateChatTitle: mocks.generateChatTitle,
  generateResponse: mocks.generateResponse
}));

vi.mock('./services/workspaceSync', () => ({
  WorkspaceCoordinator: {
    create: mocks.createCoordinator
  }
}));

vi.mock('./services/storage', () => ({
  MAX_WORKSPACE_BACKUP_BYTES: 512 * 1024 * 1024,
  STORAGE_FILES: {
    SESSIONS: 'sessions.json',
    SETTINGS: 'settings.json',
    INSTRUCTIONS: 'system_instructions.json'
  },
  WorkspaceRevisionConflictError: class WorkspaceRevisionConflictError extends Error {},
  getActiveStorageBackend: mocks.getActiveStorageBackend,
  getAttachmentDataUrl: mocks.getAttachmentDataUrl,
  getStorageHandle: mocks.getStorageHandle,
  getWorkspaceBackup: mocks.getWorkspaceBackup,
  getWorkspaceRevision: () => mocks.currentRevision,
  readWorkspaceSnapshot: mocks.readWorkspaceSnapshot,
  readLocalBlob: mocks.readLocalBlob,
  parseWorkspaceBackup: mocks.parseWorkspaceBackup,
  readJsonFile: mocks.readJsonFile,
  readSessions: mocks.readSessions,
  restoreWorkspaceBackup: mocks.restoreWorkspaceBackup,
  storeAttachmentBlob: mocks.storeAttachment,
  storeLocalBlob: mocks.storeLocalBlob,
  subscribeToStorageBackendChanges: mocks.subscribeToStorageBackendChanges,
  synchronizeWorkspaceRevision: mocks.synchronizeWorkspaceRevision,
  validateWorkspaceReferences: mocks.validateWorkspaceReferences,
  writeJsonFile: mocks.writeJsonFile,
  writeSessions: mocks.writeSessions
}));

vi.mock('./services/workspaceArchive', () => ({
  MAX_BACKUP_ARCHIVE_BYTES: 2 * 1024 * 1024 * 1024,
  UnsupportedLegacyBackupError: class UnsupportedLegacyBackupError extends Error {},
  createWorkspaceArchive: mocks.createWorkspaceArchive,
  inspectWorkspaceArchive: mocks.inspectWorkspaceArchive
}));

vi.mock('./services/workspaceRestore', () => ({
  restoreWorkspaceArchive: mocks.restoreWorkspaceArchive,
  undoLastWorkspaceMutation: mocks.undoLastWorkspaceMutation
}));

vi.mock('./services/workspaceMerge', () => ({
  mergeWorkspaceArchive: mocks.mergeWorkspaceArchive
}));

vi.mock('./utils/chatDeletion', () => ({
  confirmChatDeletion: mocks.confirmChatDeletion
}));

import App from './App';

const createSession = (
  id: string,
  title: string,
  messages: Message[] = []
): Session => ({
  id,
  title,
  messages,
  config: {
    ...DEFAULT_CONFIG,
    tools: { ...DEFAULT_CONFIG.tools }
  },
  lastModified: 1
});

const completedResult = (
  content = 'Completed response.'
): GenerateResult => ({
  content,
  thinking: 'Summary of reasoning.',
  status: 'complete',
  sources: [],
  thinkingDuration: 25,
  responseId: 'resp-complete'
});

describe('App workspace and request lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024
    });
    delete window.electronAPI;
    delete (window as typeof window & {
      showSaveFilePicker?: unknown;
    }).showSaveFilePicker;
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;

    mocks.apiKey = 'workspace-key';
    mocks.chatAreaProps = null;
    mocks.sidebarProps = null;
    mocks.uuidCounter = 0;
    mocks.currentRevision = 0;
    mocks.loadedSessions = [
      createSession('session-a', 'Session A'),
      createSession('session-b', 'Session B')
    ];
    mocks.loadedInstructions = [];

    mocks.confirmChatDeletion.mockReset().mockReturnValue(true);
    mocks.coordinator.canWrite = true;
    mocks.coordinator.currentRole = 'writer';
    Object.values(mocks.coordinator).forEach(value => {
      if (typeof value === 'function' && 'mockClear' in value) {
        value.mockReset();
      }
    });
    mocks.createCoordinator.mockReset().mockResolvedValue(mocks.coordinator);
    mocks.createWorkspaceArchive.mockReset().mockResolvedValue(
      new Blob(['backup bytes'], { type: 'application/zip' })
    );
    mocks.generateChatTitle.mockReset().mockResolvedValue('Generated title');
    mocks.generateResponse.mockReset();
    mocks.fetchGeneratedFileContent.mockReset().mockResolvedValue(
      new Blob(['generated bytes'], { type: 'text/plain' })
    );
    mocks.getActiveStorageBackend.mockReset().mockReturnValue('opfs');
    mocks.getAttachmentDataUrl.mockReset();
    mocks.getStorageHandle.mockReset().mockResolvedValue({});
    mocks.getWorkspaceBackup.mockReset();
    mocks.inspectWorkspaceArchive.mockReset().mockResolvedValue({
      preview: {
        backupId: 'backup-test',
        reason: 'manual',
        appVersion: '0.5.0',
        createdAt: 1,
        workspaceRevision: 1,
        counts: {
          sessions: 1,
          messages: 0,
          attachments: 0,
          generatedFiles: 0,
          cachedGeneratedFiles: 0
        },
        uncachedGeneratedFileCount: 0,
        archiveBytes: 10,
        uncompressedBytes: 10,
        sha256: '0'.repeat(64)
      }
    });
    mocks.parseWorkspaceBackup.mockReset().mockImplementation(value => value);
    mocks.mergeWorkspaceArchive.mockReset().mockResolvedValue({
      revision: 1,
      recovery: {},
      counts: {
        imported: 1,
        skipped: 0,
        divergent: 0
      }
    });
    mocks.readJsonFile.mockReset().mockImplementation(
      async (_handle, filename: string) => {
        if (filename === 'settings.json') {
          return {
            theme: 'dark',
            apiKey: mocks.apiKey,
            lastActiveSessionId: mocks.loadedSessions[0]?.id
          };
        }
        return structuredClone(mocks.loadedInstructions);
      }
    );
    mocks.readSessions.mockReset().mockImplementation(
      async () => structuredClone(mocks.loadedSessions)
    );
    mocks.readWorkspaceSnapshot.mockReset().mockResolvedValue({});
    mocks.readLocalBlob.mockReset().mockResolvedValue(null);
    mocks.restoreWorkspaceBackup.mockReset().mockResolvedValue(undefined);
    mocks.restoreWorkspaceArchive.mockReset().mockResolvedValue(undefined);
    mocks.storeAttachment.mockReset();
    mocks.storeLocalBlob.mockReset().mockResolvedValue({
      sha256: 'a'.repeat(64),
      byteSize: 15,
      mimeType: 'text/plain'
    });
    mocks.subscribeToStorageBackendChanges.mockReset().mockReturnValue(vi.fn());
    mocks.synchronizeWorkspaceRevision.mockReset().mockImplementation(
      async () => mocks.currentRevision
    );
    mocks.undoLastWorkspaceMutation.mockReset().mockResolvedValue({});
    mocks.validateWorkspaceReferences.mockReset();
    mocks.writeJsonFile.mockReset().mockImplementation(async () => (
      ++mocks.currentRevision
    ));
    mocks.writeSessions.mockReset().mockImplementation(async () => (
      ++mocks.currentRevision
    ));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  const flushMicrotasks = async (turns = 12): Promise<void> => {
    for (let turn = 0; turn < turns; turn += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const renderApp = async (): Promise<void> => {
    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
    });
  };

  const finishInitialization = async (): Promise<void> => {
    await flushMicrotasks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flushMicrotasks();
  };

  const drainInitialSaves = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    await flushMicrotasks();
    mocks.writeJsonFile.mockClear();
    mocks.writeSessions.mockClear();
    mocks.coordinator.publishUpdate.mockClear();
  };

  const getChatAreaProps = (): CapturedChatAreaProps => {
    if (!mocks.chatAreaProps) throw new Error('ChatArea props were not captured.');
    return mocks.chatAreaProps;
  };

  const getSidebarProps = (): CapturedSidebarProps => {
    if (!mocks.sidebarProps) throw new Error('Sidebar props were not captured.');
    return mocks.sidebarProps;
  };

  const getGenerateOptions = (): GenerateOptions => {
    const call = mocks.generateResponse.mock.calls.at(-1);
    if (!call) throw new Error('generateResponse was not called.');
    return call[4] as GenerateOptions;
  };

  it('does not write defaults when workspace loading fails', async () => {
    mocks.readSessions.mockRejectedValueOnce(
      new Error('Stored sessions could not be validated.')
    );

    await renderApp();
    await finishInitialization();

    expect(container.textContent).toContain(
      'Workspace storage could not be loaded'
    );
    expect(container.textContent).toContain(
      'Stored sessions could not be validated.'
    );
    expect(mocks.writeSessions).not.toHaveBeenCalled();
    expect(mocks.writeJsonFile).not.toHaveBeenCalled();
  });

  it('does not carry the latest undo control across application restarts', async () => {
    await renderApp();
    await finishInitialization();

    await act(async () => {
      await getSidebarProps().onImportData(new File(
        ['verified archive'],
        'backup.zip',
        { type: 'application/zip' }
      ));
    });
    const restoreButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Create recovery point'));
    await act(async () => {
      restoreButton?.click();
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(getSidebarProps().undoWorkspaceAction).toBe('restore');

    await act(async () => {
      root?.unmount();
    });
    root = null;
    mocks.sidebarProps = null;

    await renderApp();
    await finishInitialization();

    expect(getSidebarProps().undoWorkspaceAction).toBeNull();
  });

  it('asks for a web backup file location before preparing the archive', async () => {
    const archive = new Blob(['portable backup'], {
      type: 'application/zip'
    });
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close })
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: showSaveFilePicker
    });
    mocks.createWorkspaceArchive.mockResolvedValueOnce(archive);
    mocks.inspectWorkspaceArchive.mockResolvedValueOnce({
      manifest: {
        backupId: 'backup-test',
        createdAt: 1
      },
      preview: {}
    });

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    await act(async () => {
      await getSidebarProps().onExportData();
    });

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'openai-studio-backup.zip',
      types: [{
        description: 'OpenAI Studio backup',
        accept: { 'application/zip': ['.zip'] }
      }]
    });
    expect(showSaveFilePicker.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createWorkspaceArchive.mock.invocationCallOrder[0]
    );
    expect(write).toHaveBeenCalledWith(archive);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('recovers a writer pending request into a persisted retryable failure', async () => {
    const interruptedSession = createSession('session-a', 'Interrupted', [
      {
        id: 'user-pending',
        requestId: 'request-pending',
        role: 'user',
        content: 'Continue this.',
        timestamp: 1
      },
      {
        id: 'assistant-pending',
        requestId: 'request-pending',
        role: 'assistant',
        content: 'Partial output.',
        status: 'streaming',
        timestamp: 1,
        modelName: 'GPT-5.6 Sol'
      }
    ]);
    interruptedSession.pendingRequest = {
      id: 'request-pending',
      userMessageId: 'user-pending',
      assistantMessageId: 'assistant-pending',
      createdAt: 1
    };
    mocks.loadedSessions = [interruptedSession];

    await renderApp();
    await finishInitialization();

    const recovered = getSidebarProps().sessions[0];
    expect(recovered.pendingRequest).toBeUndefined();
    expect(recovered.messages[1]).toMatchObject({
      id: 'assistant-pending',
      content: 'Partial output.',
      status: 'error',
      modelName: 'GPT-5.6 Sol'
    });
    expect(mocks.writeSessions).toHaveBeenCalled();
    const persistedSessions = mocks.writeSessions.mock.calls.at(-1)?.[1] as Session[];
    expect(persistedSessions[0].pendingRequest).toBeUndefined();
    expect(persistedSessions[0].messages[1].status).toBe('error');
  });

  it('snapshots the configured model name on an interrupted request without a placeholder', async () => {
    const interruptedSession = createSession('session-a', 'Interrupted', [{
      id: 'user-pending',
      requestId: 'request-pending',
      role: 'user',
      content: 'Continue this.',
      timestamp: 1
    }]);
    interruptedSession.pendingRequest = {
      id: 'request-pending',
      userMessageId: 'user-pending',
      createdAt: 1
    };
    mocks.loadedSessions = [interruptedSession];

    await renderApp();
    await finishInitialization();

    expect(getSidebarProps().sessions[0].messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'error',
      model: DEFAULT_CONFIG.model,
      modelName: 'GPT-5.6 Sol',
      reasoningEffort: DEFAULT_CONFIG.reasoningEffort
    });
  });

  it('leaves pending requests untouched in a read-only reader tab', async () => {
    const interruptedSession = createSession('session-a', 'Interrupted', [
      {
        id: 'user-pending',
        requestId: 'request-pending',
        role: 'user',
        content: 'Continue this.',
        timestamp: 1
      },
      {
        id: 'assistant-pending',
        requestId: 'request-pending',
        role: 'assistant',
        content: 'Partial output.',
        status: 'streaming',
        timestamp: 1,
        modelName: 'GPT-5.6 Sol'
      }
    ]);
    interruptedSession.pendingRequest = {
      id: 'request-pending',
      userMessageId: 'user-pending',
      assistantMessageId: 'assistant-pending',
      createdAt: 1
    };
    mocks.loadedSessions = [interruptedSession];
    mocks.coordinator.canWrite = false;
    mocks.coordinator.currentRole = 'reader';

    await renderApp();
    await finishInitialization();

    expect(getSidebarProps().sessions[0]).toMatchObject({
      pendingRequest: interruptedSession.pendingRequest,
      messages: [
        expect.anything(),
        expect.objectContaining({ status: 'streaming' })
      ]
    });
    expect(mocks.getStorageHandle).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true })
    );
    expect(mocks.writeSessions).not.toHaveBeenCalled();
    expect(mocks.writeJsonFile).not.toHaveBeenCalled();
  });

  it('routes a completion to its originating session after selection changes', async () => {
    const response = createDeferred<GenerateResult>();
    mocks.generateResponse.mockReturnValue(response.promise);

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    await act(async () => {
      await getChatAreaProps().onSendMessage(
        'session-a',
        'Question for A.',
        []
      );
    });
    await act(async () => {
      getGenerateOptions().onTextDelta?.('Non-authoritative streamed text.');
    });
    await act(async () => {
      getSidebarProps().onSelectSession('session-b');
    });
    await act(async () => {
      response.resolve({
        ...completedResult('Progress update.\n\nAnswer for A.'),
        outputMessages: [{
          content: 'Progress update.',
          phase: 'commentary'
        }, {
          content: 'Answer for A.',
          phase: 'final_answer'
        }]
      });
      await response.promise;
    });
    await flushMicrotasks();

    const sidebar = getSidebarProps();
    const sessionA = sidebar.sessions.find(session => session.id === 'session-a');
    const sessionB = sidebar.sessions.find(session => session.id === 'session-b');
    expect(sidebar.currentSessionId).toBe('session-b');
    expect(getChatAreaProps().session?.id).toBe('session-b');
    expect(sessionA?.pendingRequest).toBeUndefined();
    expect(sessionA?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Question for A.'
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Progress update.\n\nAnswer for A.',
        outputMessages: [{
          content: 'Progress update.',
          phase: 'commentary'
        }, {
          content: 'Answer for A.',
          phase: 'final_answer'
        }],
        status: 'complete',
        openaiResponseId: 'resp-complete',
        modelName: 'GPT-5.6 Sol'
      })
    ]);
    expect(sessionA?.messages.at(-1)?.content).not.toContain(
      'Non-authoritative streamed text.'
    );
    expect(sessionB?.messages).toEqual([]);
  });

  it('retains partial output and clears the pending marker after a stream failure', async () => {
    const response = createDeferred<GenerateResult>();
    mocks.generateResponse.mockReturnValue(response.promise);

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    await act(async () => {
      await getChatAreaProps().onSendMessage(
        'session-a',
        'Fail after a partial response.',
        []
      );
    });
    await act(async () => {
      getGenerateOptions().onTextDelta?.('Useful partial output.');
      response.reject(new Error('Connection lost.'));
      await response.promise.catch(() => undefined);
    });
    await flushMicrotasks();

    const failedSession = getSidebarProps().sessions.find(
      session => session.id === 'session-a'
    );
    expect(failedSession?.pendingRequest).toBeUndefined();
    expect(failedSession?.messages.at(-1)).toMatchObject({
      content: 'Useful partial output.\n\nError: Connection lost.',
      status: 'error',
      modelName: 'GPT-5.6 Sol'
    });
  });

  it('stops a response with its unflushed partial output and ignores late completion', async () => {
    const response = createDeferred<GenerateResult>();
    mocks.generateResponse.mockReturnValue(response.promise);

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    await act(async () => {
      await getChatAreaProps().onSendMessage(
        'session-a',
        'Stream this.',
        []
      );
    });
    const options = getGenerateOptions();
    await act(async () => {
      options.onTextDelta?.('Unflushed partial output.');
      getChatAreaProps().onStopGenerating();
    });

    const stoppedSession = getSidebarProps().sessions.find(
      session => session.id === 'session-a'
    );
    expect(options.signal?.aborted).toBe(true);
    expect(stoppedSession?.pendingRequest).toBeUndefined();
    expect(stoppedSession?.messages.at(-1)).toMatchObject({
      content: 'Unflushed partial output.',
      status: 'stopped',
      modelName: 'GPT-5.6 Sol'
    });

    await act(async () => {
      response.resolve(completedResult('Late completion.'));
      await response.promise;
    });
    await flushMicrotasks();
    expect(
      getSidebarProps().sessions.find(session => session.id === 'session-a')
        ?.messages.at(-1)
    ).toMatchObject({
      content: 'Unflushed partial output.',
      status: 'stopped'
    });
  });

  it('prevents a late response from recreating a deleted session', async () => {
    const response = createDeferred<GenerateResult>();
    mocks.generateResponse.mockReturnValue(response.promise);

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    await act(async () => {
      await getChatAreaProps().onSendMessage(
        'session-a',
        'Delete before completion.',
        []
      );
    });
    await act(async () => {
      getSidebarProps().onDeleteSession(
        { stopPropagation: vi.fn() } as unknown as React.MouseEvent,
        'session-a'
      );
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(
      getSidebarProps().sessions.some(session => session.id === 'session-a')
    ).toBe(false);
    await act(async () => {
      response.resolve(completedResult('Must stay deleted.'));
      await response.promise;
    });
    await flushMicrotasks();
    expect(
      getSidebarProps().sessions.some(session => session.id === 'session-a')
    ).toBe(false);
  });

  it('keeps other chats interactive while a deletion is still being persisted', async () => {
    const deletionSave = createDeferred<number>();
    mocks.generateResponse.mockResolvedValueOnce(
      completedResult('Started while deletion was saving.')
    );

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();
    mocks.writeSessions.mockReturnValueOnce(deletionSave.promise);

    await act(async () => {
      getSidebarProps().onDeleteSession(
        { stopPropagation: vi.fn() } as unknown as React.MouseEvent,
        'session-a'
      );
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(
      getSidebarProps().sessions.some(session => session.id === 'session-a')
    ).toBe(false);
    expect(mocks.writeSessions).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Updating workspace');

    let requestStarted = false;
    await act(async () => {
      requestStarted = await getChatAreaProps().onSendMessage(
        'session-b',
        'Continue working.',
        []
      );
    });
    expect(requestStarted).toBe(true);
    expect(mocks.generateResponse).toHaveBeenCalledTimes(1);

    await act(async () => {
      deletionSave.resolve(1);
      await deletionSave.promise;
    });
    await flushMicrotasks();
  });

  it('caches generated files locally and then downloads without another API call', async () => {
    const generatedFile: GeneratedFile = {
      filename: 'result.txt',
      fileId: 'file-result',
      containerId: 'container-1',
      mimeType: 'text/plain'
    };
    mocks.generateResponse.mockResolvedValue({
      ...completedResult(),
      generatedFiles: [generatedFile]
    });

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();
    await act(async () => {
      await getChatAreaProps().onSendMessage('session-a', 'Create a file.', []);
    });
    await flushMicrotasks();

    expect(mocks.fetchGeneratedFileContent).toHaveBeenCalledWith(
      generatedFile,
      'workspace-key',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const cachedFile = getSidebarProps().sessions
      .find(session => session.id === 'session-a')
      ?.messages.at(-1)?.generatedFiles?.[0];
    expect(cachedFile?.localBlob).toMatchObject({
      sha256: 'a'.repeat(64),
      byteSize: 15
    });

    mocks.fetchGeneratedFileContent.mockClear();
    mocks.readLocalBlob.mockResolvedValueOnce(
      new Blob(['generated bytes'], { type: 'text/plain' })
    );
    await getChatAreaProps().onDownloadGeneratedFile(cachedFile!);
    expect(mocks.fetchGeneratedFileContent).not.toHaveBeenCalled();
  });

  it('invalidates an in-flight response before replacing the workspace', async () => {
    const response = createDeferred<GenerateResult>();
    const replacement = createSession(
      'session-restored',
      'Restored workspace'
    );
    mocks.generateResponse.mockReturnValue(response.promise);
    mocks.restoreWorkspaceArchive.mockImplementationOnce(async () => {
      mocks.loadedSessions = [replacement];
    });

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    await act(async () => {
      await getChatAreaProps().onSendMessage(
        'session-a',
        'Do not leak into the restored workspace.',
        []
      );
    });
    const options = getGenerateOptions();
    await act(async () => {
      await getSidebarProps().onImportData(new File(
        ['verified archive'],
        'backup.zip',
        { type: 'application/zip' }
      ));
    });
    const restoreButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Create recovery point'));
    expect(restoreButton).toBeDefined();
    await act(async () => {
      restoreButton?.click();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(options.signal?.aborted).toBe(true);
    expect(getSidebarProps().sessions).toEqual([replacement]);
    expect(getSidebarProps().undoWorkspaceAction).toBe('restore');

    await act(async () => {
      response.resolve(completedResult('Late completion.'));
      await response.promise;
    });
    await flushMicrotasks();
    expect(getSidebarProps().sessions).toEqual([replacement]);
  });

  it('merges a selected archive immediately, reloads its revision, and exposes action-aware undo', async () => {
    const originalSessions = structuredClone(mocks.loadedSessions);
    const imported = createSession('session-imported', 'Imported workspace');
    mocks.mergeWorkspaceArchive.mockImplementationOnce(async () => {
      mocks.loadedSessions = [imported, ...originalSessions];
      return {
        revision: 42,
        recovery: {},
        counts: {
          imported: 1,
          skipped: 0,
          divergent: 0
        }
      };
    });
    mocks.undoLastWorkspaceMutation.mockImplementationOnce(async () => {
      mocks.loadedSessions = originalSessions;
    });

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    const archive = new File(['verified archive'], 'merge.zip', {
      type: 'application/zip'
    });
    await act(async () => {
      await getSidebarProps().onMergeData(archive);
    });
    await flushMicrotasks();

    expect(mocks.mergeWorkspaceArchive).toHaveBeenCalledWith(
      expect.anything(),
      archive,
      expect.objectContaining({
        filename: 'merge.zip',
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function)
      })
    );
    expect(mocks.restoreWorkspaceArchive).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Restore verified backup?');
    expect(getSidebarProps().sessions).toEqual([imported, ...originalSessions]);
    expect(getSidebarProps().undoWorkspaceAction).toBe('merge');
    expect(mocks.coordinator.publishUpdate).toHaveBeenCalledWith(42);

    await act(async () => {
      await getSidebarProps().onUndoWorkspaceMutation();
    });
    await flushMicrotasks();

    expect(mocks.undoLastWorkspaceMutation).toHaveBeenCalled();
    expect(getSidebarProps().sessions).toEqual(originalSessions);
    expect(getSidebarProps().undoWorkspaceAction).toBeNull();
  });

  it('cancels merge validation from the shared archive progress overlay', async () => {
    const merge = createDeferred<never>();
    let signal: AbortSignal | undefined;
    mocks.mergeWorkspaceArchive.mockImplementationOnce(
      async (_handle, _archive, options) => {
        signal = options.signal;
        options.onProgress({
          phase: 'validating',
          completedEntries: 1,
          totalEntries: 2,
          completedBytes: 5,
          totalBytes: 10
        });
        return merge.promise;
      }
    );

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    let mergeRequest!: Promise<void>;
    await act(async () => {
      mergeRequest = getSidebarProps().onMergeData(new File(
        ['verified archive'],
        'merge.zip',
        { type: 'application/zip' }
      ));
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(getSidebarProps().mergeDisabled).toBe(true);
    const cancel = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Cancel');
    expect(cancel).toBeDefined();

    await act(async () => {
      cancel?.click();
      merge.reject(new DOMException('Cancelled', 'AbortError'));
      await mergeRequest;
    });
    expect(signal?.aborted).toBe(true);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('reports merge failures without reloading the workspace', async () => {
    mocks.mergeWorkspaceArchive.mockRejectedValueOnce(
      new Error('Archive digest mismatch.')
    );

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();
    const sessionsBefore = structuredClone(getSidebarProps().sessions);

    await act(async () => {
      await getSidebarProps().onMergeData(new File(
        ['corrupt archive'],
        'merge.zip',
        { type: 'application/zip' }
      ));
    });

    expect(window.alert).toHaveBeenCalledWith(
      'Workspace merge failed: Archive digest mismatch.'
    );
    expect(getSidebarProps().sessions).toEqual(sessionsBefore);
    expect(getSidebarProps().undoWorkspaceAction).toBeNull();
  });

  it('disables merge while a response is active', async () => {
    const response = createDeferred<GenerateResult>();
    mocks.generateResponse.mockReturnValue(response.promise);

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    await act(async () => {
      await getChatAreaProps().onSendMessage('session-a', 'Keep working.', []);
    });
    expect(getSidebarProps().mergeDisabled).toBe(true);
    await act(async () => {
      await getSidebarProps().onMergeData(new File(
        ['verified archive'],
        'merge.zip',
        { type: 'application/zip' }
      ));
    });
    expect(mocks.mergeWorkspaceArchive).not.toHaveBeenCalled();

    await act(async () => {
      response.resolve(completedResult());
      await response.promise;
    });
    await flushMicrotasks();
    expect(getSidebarProps().mergeDisabled).toBe(false);
  });

  it('disables merge in a reader tab', async () => {
    mocks.coordinator.canWrite = false;
    mocks.coordinator.currentRole = 'reader';

    await renderApp();
    await finishInitialization();

    expect(getSidebarProps().mergeDisabled).toBe(true);
    await act(async () => {
      await getSidebarProps().onMergeData(new File(
        ['verified archive'],
        'merge.zip',
        { type: 'application/zip' }
      ));
    });
    expect(mocks.mergeWorkspaceArchive).not.toHaveBeenCalled();
  });

  it('checkpoints partial output and saves it before confirming Electron close', async () => {
    const response = createDeferred<GenerateResult>();
    const save = createDeferred<number>();
    let requestClose: (() => void) | undefined;
    const confirmClose = vi.fn();
    window.electronAPI = {
      minimize: vi.fn(),
      maximize: vi.fn(),
      close: vi.fn(),
      isMaximized: vi.fn().mockResolvedValue(false),
      onMaximizedChange: vi.fn(),
      writeClipboardText: vi.fn().mockResolvedValue(undefined),
      onCloseRequested: callback => {
        requestClose = callback;
        return vi.fn();
      },
      confirmClose,
      cancelClose: vi.fn()
    };
    mocks.generateResponse.mockReturnValue(response.promise);

    await renderApp();
    await finishInitialization();
    await drainInitialSaves();

    await act(async () => {
      await getChatAreaProps().onSendMessage(
        'session-a',
        'Close while streaming.',
        []
      );
    });
    const options = getGenerateOptions();
    await act(async () => {
      options.onTextDelta?.('Saved before close.');
    });
    mocks.writeSessions.mockImplementationOnce(() => save.promise);

    await act(async () => {
      requestClose?.();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(confirmClose).not.toHaveBeenCalled();
    expect(options.signal?.aborted).toBe(true);
    expect(mocks.writeSessions).toHaveBeenCalledTimes(1);
    const closingSessions = mocks.writeSessions.mock.calls[0][1] as Session[];
    expect(
      closingSessions.find(session => session.id === 'session-a')
        ?.messages.at(-1)
    ).toMatchObject({
      content: 'Saved before close.',
      status: 'stopped'
    });

    await act(async () => {
      save.resolve(10);
      await save.promise;
    });
    await flushMicrotasks();
    expect(confirmClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      response.resolve(completedResult('Late completion.'));
      await response.promise;
    });
  });
});
