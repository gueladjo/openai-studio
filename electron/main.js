import { app, BrowserWindow, ipcMain, shell, Menu, clipboard } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

// Define __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

ipcMain.handle('window-is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.isMaximized() : false;
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

  // Open external links in default browser instead of in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle navigation to external URLs
  win.webContents.on('will-navigate', (event, url) => {
    const appUrl = isDev ? 'http://localhost:5173' : 'file://';
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
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
      menuItems.push({
        label: 'Open in Browser',
        click: () => shell.openExternal(params.linkURL)
      });
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
    // You might need to adjust the port if Vite uses something other than 5173
    win.loadURL('http://localhost:5173');
    // Open DevTools in dev mode
    // win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});