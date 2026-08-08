import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  clipboard,
  dialog
} from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  DEV_SERVER_ORIGIN,
  waitForVerifiedDevServer
} from './devServer.js';
import { isSafeExternalUrl, isSameAppDocument } from './urlPolicy.js';
import { BackupFileManager } from './backupFiles.js';

// Define __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let closeRequestPending = false;
let closeConfirmed = false;
let appQuitPending = false;
const backupFileManager = new BackupFileManager();

const assertMainWindowSender = (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== mainWindow) {
    throw new Error('Backup operation was requested by an untrusted renderer.');
  }
  return win;
};

const finishWindowClose = (win) => {
  if (!win || win.isDestroyed()) return;

  closeConfirmed = true;
  closeRequestPending = false;

  if (appQuitPending) {
    app.quit();
  } else {
    win.close();
  }
};

const requestWindowClose = (win) => {
  if (!win || win.isDestroyed() || closeConfirmed) return;
  if (win.webContents.isDestroyed()) {
    finishWindowClose(win);
    return;
  }

  if (!closeRequestPending) {
    closeRequestPending = true;
    win.webContents.send('window-close-requested');
  }
};

const focusWindow = (win) => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!win.webContents.isDestroyed()) win.webContents.focus();
};

const focusMainWindow = () => focusWindow(mainWindow);

// Window control IPC handlers
ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

ipcMain.on('window-close-confirmed', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win === mainWindow) finishWindowClose(win);
});

ipcMain.on('window-close-cancelled', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== mainWindow || closeConfirmed) return;

  closeRequestPending = false;
  appQuitPending = false;
});

ipcMain.handle('window-is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.isMaximized() : false;
});

ipcMain.handle('window-restore-focus-after-dialog', (event) => {
  focusWindow(assertMainWindowSender(event));
});

ipcMain.handle('clipboard-write-text', (_event, text) => {
  clipboard.writeText(String(text ?? ''));
});

ipcMain.handle('backup-choose-directory', async (event) => {
  const win = assertMainWindowSender(event);
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose OpenAI Studio Backup Folder',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length !== 1) return false;
    await backupFileManager.setDestination(result.filePaths[0]);
    return true;
  } finally {
    focusWindow(win);
  }
});

ipcMain.handle('backup-destination-status', event => {
  assertMainWindowSender(event);
  return backupFileManager.getStatus();
});

ipcMain.handle('backup-write-start', async (event, filename) => {
  assertMainWindowSender(event);
  return backupFileManager.startWrite(filename);
});

ipcMain.handle('backup-write-chunk', async (event, id, chunk) => {
  assertMainWindowSender(event);
  if (!(chunk instanceof Uint8Array) && !(chunk instanceof ArrayBuffer)) {
    throw new Error('Backup chunk is invalid.');
  }
  await backupFileManager.writeChunk(id, chunk);
});

ipcMain.handle(
  'backup-write-finish',
  async (event, id, expectedSize, expectedSha256) => {
    assertMainWindowSender(event);
    await backupFileManager.finishWrite(id, expectedSize, expectedSha256);
  }
);

ipcMain.handle('backup-write-abort', async (event, id) => {
  assertMainWindowSender(event);
  await backupFileManager.abortWrite(id);
});

ipcMain.handle('backup-list', event => {
  assertMainWindowSender(event);
  return backupFileManager.list();
});

ipcMain.handle('backup-read', async (event, filename) => {
  assertMainWindowSender(event);
  const data = await backupFileManager.read(filename);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle('backup-delete', async (event, filename) => {
  assertMainWindowSender(event);
  await backupFileManager.delete(filename);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "OpenAI Studio",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs')
    },
    // Frameless window for custom title bar (Discord-style)
    frame: false,
    backgroundColor: '#0d1117'
  });
  mainWindow = win;

  win.on('close', (event) => {
    if (closeConfirmed) return;
    event.preventDefault();
    requestWindowClose(win);
  });

  win.on('closed', () => {
    closeRequestPending = false;
    closeConfirmed = false;
    appQuitPending = false;
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  // Send maximize state changes to renderer
  win.on('maximize', () => {
    win.webContents.send('window-maximized-change', true);
  });
  win.on('unmaximize', () => {
    win.webContents.send('window-maximized-change', false);
  });

  // Remove the menu bar (optional, makes it look more like a native tool)
  win.setMenuBarVisibility(false);

  // Check if we're in development mode
  const isDev = !app.isPackaged;
  const appUrl = isDev
    ? DEV_SERVER_ORIGIN
    : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;

  // Open external links in default browser instead of in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Handle navigation to external URLs
  win.webContents.on('will-navigate', (event, url) => {
    if (isSameAppDocument(url, appUrl)) return;

    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
  });

  // Context menu handling
  win.webContents.on('context-menu', (event, params) => {
    const menuItems = [];

    // If there's a link, add "Copy URL" option
    if (params.linkURL) {
      menuItems.push({
        label: 'Copy URL',
        click: () => clipboard.writeText(params.linkURL)
      });
      if (isSafeExternalUrl(params.linkURL)) {
        menuItems.push({
          label: 'Open in Browser',
          click: () => shell.openExternal(params.linkURL)
        });
      }
      menuItems.push({ type: 'separator' });
    }

    // If text is selected, add Copy option
    if (params.selectionText) {
      menuItems.push({
        label: 'Copy',
        role: 'copy',
        accelerator: 'CmdOrCtrl+C'
      });
    }

    // If it's an editable field (input, textarea, contenteditable)
    if (params.isEditable) {
      // Add Cut if there's selected text in an editable field
      if (params.selectionText) {
        menuItems.push({
          label: 'Cut',
          role: 'cut',
          accelerator: 'CmdOrCtrl+X'
        });
      }
      menuItems.push({
        label: 'Paste',
        role: 'paste',
        accelerator: 'CmdOrCtrl+V'
      });
      menuItems.push({ type: 'separator' });
      menuItems.push({
        label: 'Select All',
        role: 'selectAll',
        accelerator: 'CmdOrCtrl+A'
      });
    }

    // Only show menu if there are items
    if (menuItems.length > 0) {
      // Remove trailing separator if present
      if (menuItems[menuItems.length - 1].type === 'separator') {
        menuItems.pop();
      }
      const contextMenu = Menu.buildFromTemplate(menuItems);
      contextMenu.popup();
    }
  });

  // Load the app
  // In development, we load from the Vite dev server
  // In production, we load the index.html file
  if (isDev) {
    win.loadURL(appUrl);
    // Open DevTools in dev mode
    // win.webContents.openDevTools();
  } else {
    win.loadURL(appUrl);
  }

  return win;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('before-quit', (event) => {
    if (closeConfirmed || !mainWindow) return;

    event.preventDefault();
    appQuitPending = true;
    requestWindowClose(mainWindow);
  });

  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    if (!app.isPackaged) {
      try {
        await waitForVerifiedDevServer();
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        app.exit(1);
        return;
      }
    }

    try {
      await backupFileManager.initialize(app.getPath('userData'), {
        cleanupStalePartials: false
      });
    } catch (error) {
      console.error('Failed to initialize the backup destination.', error);
    }
    createWindow();
    void backupFileManager.cleanupStalePartials().catch(error => {
      console.error('Failed to clean stale backup partials.', error);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        focusMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
