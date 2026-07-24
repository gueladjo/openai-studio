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
}

interface CapturedSidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (event: React.MouseEvent, sessionId: string) => void;
}

interface GenerateOptions {
  signal?: AbortSignal;
  onResponseCreated?: (responseId: string) => void;
  onTextDelta?: (delta: string) => void;
  onReasoningSummaryDelta?: (delta: string) => void;
}

interface GenerateResult {
  content: string;
  thinking: string;
  status: 'complete' | 'incomplete';
  sources: [];
  thinkingDuration: number;
  responseId: string;
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
  cancelResponse: vi.fn(),
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
  createCoordinator: vi.fn(),
  currentRevision: 0,
  generateChatTitle: vi.fn(),
  generateResponse: vi.fn(),
  getActiveStorageBackend: vi.fn(),
  getAttachmentDataUrl: vi.fn(),
  getStorageHandle: vi.fn(),
  getWorkspaceBackup: vi.fn(),
  loadedInstructions: [] as SystemInstruction[],
  loadedSessions: [] as Session[],
  parseWorkspaceBackup: vi.fn(),
  readJsonFile: vi.fn(),
  readSessions: vi.fn(),
  restoreWorkspaceBackup: vi.fn(),
  sidebarProps: null as CapturedSidebarProps | null,
  storeAttachment: vi.fn(),
  subscribeToStorageBackendChanges: vi.fn(),
  synchronizeWorkspaceRevision: vi.fn(),
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
  cancelResponse: mocks.cancelResponse,
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
  parseWorkspaceBackup: mocks.parseWorkspaceBackup,
  readJsonFile: mocks.readJsonFile,
  readSessions: mocks.readSessions,
  restoreWorkspaceBackup: mocks.restoreWorkspaceBackup,
  storeAttachment: mocks.storeAttachment,
  subscribeToStorageBackendChanges: mocks.subscribeToStorageBackendChanges,
  synchronizeWorkspaceRevision: mocks.synchronizeWorkspaceRevision,
  validateWorkspaceReferences: mocks.validateWorkspaceReferences,
  writeJsonFile: mocks.writeJsonFile,
  writeSessions: mocks.writeSessions
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

    mocks.cancelResponse.mockReset().mockResolvedValue(undefined);
    mocks.confirmChatDeletion.mockReset().mockReturnValue(true);
    mocks.coordinator.canWrite = true;
    mocks.coordinator.currentRole = 'writer';
    Object.values(mocks.coordinator).forEach(value => {
      if (typeof value === 'function' && 'mockClear' in value) {
        value.mockReset();
      }
    });
    mocks.createCoordinator.mockReset().mockResolvedValue(mocks.coordinator);
    mocks.generateChatTitle.mockReset().mockResolvedValue('Generated title');
    mocks.generateResponse.mockReset();
    mocks.getActiveStorageBackend.mockReset().mockReturnValue('opfs');
    mocks.getAttachmentDataUrl.mockReset();
    mocks.getStorageHandle.mockReset().mockResolvedValue({});
    mocks.getWorkspaceBackup.mockReset();
    mocks.parseWorkspaceBackup.mockReset().mockImplementation(value => value);
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
    mocks.restoreWorkspaceBackup.mockReset().mockResolvedValue(undefined);
    mocks.storeAttachment.mockReset();
    mocks.subscribeToStorageBackendChanges.mockReset().mockReturnValue(vi.fn());
    mocks.synchronizeWorkspaceRevision.mockReset().mockImplementation(
      async () => mocks.currentRevision
    );
    mocks.validateWorkspaceReferences.mockReset();
    mocks.writeJsonFile.mockReset().mockImplementation(async () => (
      ++mocks.currentRevision
    ));
    mocks.writeSessions.mockReset().mockImplementation(async () => (
      ++mocks.currentRevision
    ));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
        timestamp: 1
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
      status: 'error'
    });
    expect(mocks.writeSessions).toHaveBeenCalled();
    const persistedSessions = mocks.writeSessions.mock.calls.at(-1)?.[1] as Session[];
    expect(persistedSessions[0].pendingRequest).toBeUndefined();
    expect(persistedSessions[0].messages[1].status).toBe('error');
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
        timestamp: 1
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
      getSidebarProps().onSelectSession('session-b');
    });
    await act(async () => {
      response.resolve(completedResult('Answer for A.'));
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
        content: 'Answer for A.',
        status: 'complete',
        openaiResponseId: 'resp-complete'
      })
    ]);
    expect(sessionB?.messages).toEqual([]);
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
      options.onResponseCreated?.('resp-streaming');
      options.onTextDelta?.('Unflushed partial output.');
      getChatAreaProps().onStopGenerating();
    });

    const stoppedSession = getSidebarProps().sessions.find(
      session => session.id === 'session-a'
    );
    expect(options.signal?.aborted).toBe(true);
    expect(mocks.cancelResponse).toHaveBeenCalledWith(
      'resp-streaming',
      'workspace-key'
    );
    expect(stoppedSession?.pendingRequest).toBeUndefined();
    expect(stoppedSession?.messages.at(-1)).toMatchObject({
      content: 'Unflushed partial output.',
      status: 'stopped'
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
      options.onResponseCreated?.('resp-before-close');
      options.onTextDelta?.('Saved before close.');
    });
    mocks.writeSessions.mockImplementationOnce(() => save.promise);

    await act(async () => {
      requestClose?.();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(confirmClose).not.toHaveBeenCalled();
    expect(mocks.cancelResponse).toHaveBeenCalledWith(
      'resp-before-close',
      'workspace-key'
    );
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
