const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  confirmClose: () => ipcRenderer.send('window-close-confirmed'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  onMaximizedChange: (callback) => {
    ipcRenderer.on('window-maximized-change', (_event, isMaximized) => callback(isMaximized));
  },
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window-close-requested', listener);
    return () => ipcRenderer.removeListener('window-close-requested', listener);
  }
});
