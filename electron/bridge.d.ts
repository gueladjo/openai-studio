import type { BackupDestinationStatus, ManagedBackupFile } from '../services/backupDestination';

export interface ElectronAPI {
  minimize(): void;
  maximize(): void;
  close(): void;
  restoreFocusAfterDialog(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(callback: (isMaximized: boolean) => void): void;
  writeClipboardText(text: string): Promise<void>;
  onCloseRequested(callback: () => void): () => void;
  confirmClose(): void;
  cancelClose(): void;
  chooseBackupDirectory(): Promise<boolean>;
  getBackupDestinationStatus(): Promise<BackupDestinationStatus>;
  writeBackupArchive(
    filename: string,
    readChunk: () => Promise<Uint8Array | null>,
    expectedSize: number,
    expectedSha256: string
  ): Promise<void>;
  listBackupArchives(): Promise<ManagedBackupFile[]>;
  readBackupArchive(filename: string): Promise<ArrayBuffer>;
  deleteBackupArchive(filename: string): Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
