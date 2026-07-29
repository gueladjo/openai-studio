import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const appHandlers = new Map();
  const ipcHandleHandlers = new Map();
  const ipcOnHandlers = new Map();
  const windows = [];

  const createWindow = () => {
    const windowHandlers = new Map();
    const webContentsHandlers = new Map();
    const webContents = {
      isDestroyed: vi.fn(() => false),
      on: vi.fn((event, handler) => {
        webContentsHandlers.set(event, handler);
      }),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(handler => {
        webContents.openHandler = handler;
      }),
      openHandler: undefined
    };

    return {
      close: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      loadURL: vi.fn(),
      maximize: vi.fn(),
      minimize: vi.fn(),
      on: vi.fn((event, handler) => {
        windowHandlers.set(event, handler);
      }),
      restore: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      show: vi.fn(),
      unmaximize: vi.fn(),
      webContents,
      webContentsHandlers,
      windowHandlers
    };
  };

  const BrowserWindow = vi.fn(function BrowserWindow(options) {
    const window = createWindow();
    window.options = options;
    windows.push(window);
    return window;
  });
  BrowserWindow.fromWebContents = vi.fn(sender => (
    windows.find(window => window.webContents === sender) || null
  ));
  BrowserWindow.getAllWindows = vi.fn(() => windows);

  const app = {
    exit: vi.fn(),
    getPath: vi.fn(() => '/tmp/openai-studio-electron-test'),
    isPackaged: true,
    on: vi.fn((event, handler) => {
      appHandlers.set(event, handler);
    }),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve())
  };
  const clipboard = {
    writeText: vi.fn()
  };
  const dialog = {
    showOpenDialog: vi.fn()
  };
  const ipcMain = {
    handle: vi.fn((channel, handler) => {
      ipcHandleHandlers.set(channel, handler);
    }),
    on: vi.fn((channel, handler) => {
      ipcOnHandlers.set(channel, handler);
    })
  };
  const Menu = {
    buildFromTemplate: vi.fn(() => ({
      popup: vi.fn()
    }))
  };
  const shell = {
    openExternal: vi.fn().mockResolvedValue(undefined)
  };

  return {
    app,
    appHandlers,
    BrowserWindow,
    clipboard,
    dialog,
    ipcHandleHandlers,
    ipcMain,
    ipcOnHandlers,
    Menu,
    shell,
    windows
  };
});

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.BrowserWindow,
  clipboard: harness.clipboard,
  dialog: harness.dialog,
  ipcMain: harness.ipcMain,
  Menu: harness.Menu,
  shell: harness.shell
}));

describe('Electron main-process policy', () => {
  beforeEach(() => {
    vi.resetModules();
    harness.appHandlers.clear();
    harness.ipcHandleHandlers.clear();
    harness.ipcOnHandlers.clear();
    harness.windows.length = 0;
    vi.clearAllMocks();
    harness.app.isPackaged = true;
    harness.app.requestSingleInstanceLock.mockReturnValue(true);
    harness.app.whenReady.mockReturnValue(Promise.resolve());
    harness.BrowserWindow.getAllWindows.mockImplementation(
      () => harness.windows
    );
    harness.BrowserWindow.fromWebContents.mockImplementation(sender => (
      harness.windows.find(window => window.webContents === sender) || null
    ));
  });

  const loadMain = async () => {
    await import('./main.js');
    await vi.waitFor(() => {
      expect(harness.windows.length).toBe(1);
    });

    const window = harness.windows[0];
    if (!window) throw new Error('Electron main window was not created.');
    return window;
  };

  it('creates an isolated renderer and keeps all navigation under policy', async () => {
    const window = await loadMain();
    const options = harness.BrowserWindow.mock.calls[0][0];

    expect(options).toMatchObject({
      frame: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    expect(options.webPreferences.preload).toMatch(/electron[/\\]preload\.cjs$/);

    const openHandler = window.webContents.openHandler;
    expect(openHandler({ url: 'https://example.com/docs' })).toEqual({
      action: 'deny'
    });
    expect(harness.shell.openExternal).toHaveBeenCalledWith(
      'https://example.com/docs'
    );
    harness.shell.openExternal.mockClear();
    expect(openHandler({ url: 'file:///tmp/untrusted.html' })).toEqual({
      action: 'deny'
    });
    expect(harness.shell.openExternal).not.toHaveBeenCalled();

    const navigate = window.webContentsHandlers.get('will-navigate');
    const appUrl = window.loadURL.mock.calls[0][0];
    const sameDocumentEvent = { preventDefault: vi.fn() };
    navigate(sameDocumentEvent, `${appUrl}#response`);
    expect(sameDocumentEvent.preventDefault).not.toHaveBeenCalled();

    const externalEvent = { preventDefault: vi.fn() };
    navigate(externalEvent, 'https://example.com/elsewhere');
    expect(externalEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.shell.openExternal).toHaveBeenCalledWith(
      'https://example.com/elsewhere'
    );

    harness.shell.openExternal.mockClear();
    const localFileEvent = { preventDefault: vi.fn() };
    navigate(localFileEvent, 'file:///tmp/another.html');
    expect(localFileEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.shell.openExternal).not.toHaveBeenCalled();
  });

  it('deduplicates close requests and allows the renderer to cancel or confirm', async () => {
    const window = await loadMain();
    const close = window.windowHandlers.get('close');
    const firstCloseEvent = { preventDefault: vi.fn() };

    close(firstCloseEvent);
    close({ preventDefault: vi.fn() });
    expect(firstCloseEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'window-close-requested'
    );

    const cancel = harness.ipcOnHandlers.get('window-close-cancelled');
    cancel({ sender: window.webContents });
    close({ preventDefault: vi.fn() });
    expect(window.webContents.send).toHaveBeenCalledTimes(2);

    const confirm = harness.ipcOnHandlers.get('window-close-confirmed');
    confirm({ sender: window.webContents });
    expect(window.close).toHaveBeenCalledTimes(1);

    const confirmedCloseEvent = { preventDefault: vi.fn() };
    close(confirmedCloseEvent);
    expect(confirmedCloseEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('waits for renderer confirmation before completing an application quit', async () => {
    const window = await loadMain();
    const beforeQuit = harness.appHandlers.get('before-quit');
    const event = { preventDefault: vi.fn() };

    beforeQuit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'window-close-requested'
    );
    expect(harness.app.quit).not.toHaveBeenCalled();

    const confirm = harness.ipcOnHandlers.get('window-close-confirmed');
    confirm({ sender: window.webContents });
    expect(harness.app.quit).toHaveBeenCalledTimes(1);
    expect(window.close).not.toHaveBeenCalled();
  });

  it('keeps backup IPC scoped to the main renderer and managed filenames', async () => {
    const window = await loadMain();
    const status = harness.ipcHandleHandlers.get('backup-destination-status');
    const startWrite = harness.ipcHandleHandlers.get('backup-write-start');

    expect(() => status({ sender: {} })).toThrow('untrusted renderer');
    await expect(startWrite(
      { sender: window.webContents },
      '../outside.zip'
    )).rejects.toThrow('filename is invalid');
  });
});
