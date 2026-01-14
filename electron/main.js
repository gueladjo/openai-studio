import { app, BrowserWindow, ipcMain } from 'electron';
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

  // Load the app
  // In development, we load from the Vite dev server
  // In production, we load the index.html file
  const isDev = !app.isPackaged;

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