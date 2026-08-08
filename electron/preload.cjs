const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  restoreFocusAfterDialog: () => ipcRenderer.invoke('window-restore-focus-after-dialog'),
  confirmClose: () => ipcRenderer.send('window-close-confirmed'),
  cancelClose: () => ipcRenderer.send('window-close-cancelled'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  onMaximizedChange: (callback) => {
    ipcRenderer.on('window-maximized-change', (_event, isMaximized) => callback(isMaximized));
  },
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window-close-requested', listener);
    return () => ipcRenderer.removeListener('window-close-requested', listener);
  },
  chooseBackupDirectory: () => ipcRenderer.invoke('backup-choose-directory'),
  getBackupDestinationStatus: () => ipcRenderer.invoke('backup-destination-status'),
  writeBackupArchive: async (
    filename,
    readChunk,
    expectedSize,
    expectedSha256
  ) => {
    const id = await ipcRenderer.invoke('backup-write-start', filename);
    try {
      while (true) {
        const value = await readChunk();
        if (value === null) break;
        await ipcRenderer.invoke('backup-write-chunk', id, value);
      }
      await ipcRenderer.invoke(
        'backup-write-finish',
        id,
        expectedSize,
        expectedSha256
      );
    } catch (error) {
      await ipcRenderer.invoke('backup-write-abort', id).catch(() => undefined);
      throw error;
    }
  },
  listBackupArchives: () => ipcRenderer.invoke('backup-list'),
  readBackupArchive: (filename) => ipcRenderer.invoke('backup-read', filename),
  deleteBackupArchive: (filename) => ipcRenderer.invoke('backup-delete', filename)
});
