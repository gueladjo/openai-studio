import { sha256Blob } from './contentAddressing';

export const MANAGED_BACKUP_PREFIX = 'openai-studio-backup-';
export const MANAGED_BACKUP_PATTERN =
  /^openai-studio-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9_-]{8,128}\.zip$/;
const PARTIAL_PREFIX = '.openai-studio-backup-partial-';
const PREFERENCES_DB = 'openai-studio-local-preferences';
const PREFERENCES_STORE = 'preferences';
const DESTINATION_HANDLE_KEY = 'backup-directory-handle';

export type BackupDestinationStatus =
  | 'connected'
  | 'permission-required'
  | 'unavailable';

export interface ManagedBackupFile {
  filename: string;
  size: number;
  lastModified: number;
}

export interface BackupDestination {
  readonly kind: 'electron' | 'file-system-access';
  getStatus(): Promise<BackupDestinationStatus>;
  writeAtomic(
    filename: string,
    archive: Blob,
    expectedSha256: string
  ): Promise<void>;
  list(): Promise<ManagedBackupFile[]>;
  read(filename: string): Promise<Blob>;
  delete(filename: string): Promise<void>;
}

export const createManagedBackupFilename = (
  createdAt: number,
  backupId: string
): string => (
  `${MANAGED_BACKUP_PREFIX}${new Date(createdAt).toISOString()
    .replace(/[:.]/g, '-')}-${backupId}.zip`
);

const assertManagedFilename = (filename: string): void => {
  if (!MANAGED_BACKUP_PATTERN.test(filename)) {
    throw new Error('The managed backup filename is invalid.');
  }
};

const openPreferencesDatabase = (): Promise<IDBDatabase> => (
  new Promise((resolve, reject) => {
    const request = indexedDB.open(PREFERENCES_DB, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PREFERENCES_STORE)) {
        database.createObjectStore(PREFERENCES_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  })
);

const getStoredDirectoryHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openPreferencesDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(PREFERENCES_STORE, 'readonly');
      const request = transaction.objectStore(PREFERENCES_STORE).get(
        DESTINATION_HANDLE_KEY
      );
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(
        request.result instanceof Object
          ? request.result as FileSystemDirectoryHandle
          : null
      );
    });
  } finally {
    database.close();
  }
};

const storeDirectoryHandle = async (
  handle: FileSystemDirectoryHandle
): Promise<void> => {
  const database = await openPreferencesDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PREFERENCES_STORE, 'readwrite');
      transaction.objectStore(PREFERENCES_STORE).put(
        handle,
        DESTINATION_HANDLE_KEY
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
};

type PermissionCapableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

class FileSystemAccessBackupDestination implements BackupDestination {
  readonly kind = 'file-system-access' as const;

  constructor(private readonly directory: FileSystemDirectoryHandle) {}

  async getStatus(): Promise<BackupDestinationStatus> {
    const permission = await (
      this.directory as PermissionCapableDirectoryHandle
    ).queryPermission({ mode: 'readwrite' });
    return permission === 'granted' ? 'connected' : 'permission-required';
  }

  async reconnect(): Promise<boolean> {
    const permission = await (
      this.directory as PermissionCapableDirectoryHandle
    ).requestPermission({ mode: 'readwrite' });
    return permission === 'granted';
  }

  async cleanupStalePartials(): Promise<void> {
    if (await this.getStatus() !== 'connected') return;
    for await (const [name, entry] of (this.directory as any).entries()) {
      if (entry.kind !== 'file' || !name.startsWith(PARTIAL_PREFIX)) continue;
      try {
        await this.directory.removeEntry(name);
      } catch (error) {
        console.warn(`Failed to remove stale backup partial ${name}.`, error);
      }
    }
  }

  async writeAtomic(
    filename: string,
    archive: Blob,
    expectedSha256: string
  ): Promise<void> {
    assertManagedFilename(filename);
    if (await this.getStatus() !== 'connected') {
      throw new Error('Backup folder permission must be reconnected.');
    }
    const partialName = `${PARTIAL_PREFIX}${crypto.randomUUID?.() || Date.now()}`;
    const partialHandle = await this.directory.getFileHandle(partialName, {
      create: true
    });
    try {
      const writable = await partialHandle.createWritable();
      await writable.write(archive);
      await writable.close();
      const staged = await partialHandle.getFile();
      if (
        staged.size !== archive.size ||
        await sha256Blob(staged) !== expectedSha256
      ) {
        throw new Error('The staged backup failed read-back verification.');
      }

      if (typeof (partialHandle as any).move === 'function') {
        await (partialHandle as any).move(filename);
      } else {
        const finalHandle = await this.directory.getFileHandle(filename, {
          create: true
        });
        const finalWritable = await finalHandle.createWritable();
        await finalWritable.write(staged);
        await finalWritable.close();
        const finalFile = await finalHandle.getFile();
        if (
          finalFile.size !== archive.size ||
          await sha256Blob(finalFile) !== expectedSha256
        ) {
          throw new Error('The final backup failed read-back verification.');
        }
        await this.directory.removeEntry(partialName);
      }
    } catch (error) {
      try {
        await this.directory.removeEntry(partialName);
      } catch {
        // The stale partial is safely ignored and cleaned on a later reconnect.
      }
      throw error;
    }
  }

  async list(): Promise<ManagedBackupFile[]> {
    const files: ManagedBackupFile[] = [];
    for await (const [name, entry] of (this.directory as any).entries()) {
      if (entry.kind !== 'file' || !MANAGED_BACKUP_PATTERN.test(name)) continue;
      const file = await entry.getFile();
      files.push({
        filename: name,
        size: file.size,
        lastModified: file.lastModified
      });
    }
    return files.sort((left, right) => right.lastModified - left.lastModified);
  }

  async read(filename: string): Promise<Blob> {
    assertManagedFilename(filename);
    const handle = await this.directory.getFileHandle(filename);
    return handle.getFile();
  }

  async delete(filename: string): Promise<void> {
    assertManagedFilename(filename);
    await this.directory.removeEntry(filename);
  }
}

interface ElectronBackupBridge {
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

class ElectronBackupDestination implements BackupDestination {
  readonly kind = 'electron' as const;

  constructor(private readonly bridge: ElectronBackupBridge) {}

  getStatus(): Promise<BackupDestinationStatus> {
    return this.bridge.getBackupDestinationStatus();
  }

  writeAtomic(
    filename: string,
    archive: Blob,
    expectedSha256: string
  ): Promise<void> {
    assertManagedFilename(filename);
    const reader = archive.stream().getReader();
    return this.bridge.writeBackupArchive(
      filename,
      async () => {
        const { done, value } = await reader.read();
        return done ? null : value;
      },
      archive.size,
      expectedSha256
    ).finally(() => {
      reader.releaseLock();
    });
  }

  list(): Promise<ManagedBackupFile[]> {
    return this.bridge.listBackupArchives();
  }

  async read(filename: string): Promise<Blob> {
    assertManagedFilename(filename);
    return new Blob([await this.bridge.readBackupArchive(filename)], {
      type: 'application/zip'
    });
  }

  delete(filename: string): Promise<void> {
    assertManagedFilename(filename);
    return this.bridge.deleteBackupArchive(filename);
  }
}

const getElectronBridge = (): ElectronBackupBridge | null => {
  const bridge = typeof window !== 'undefined'
    ? (window as any).electronAPI
    : null;
  return bridge?.getBackupDestinationStatus ? bridge as ElectronBackupBridge : null;
};

export const loadBackupDestination = async (): Promise<BackupDestination | null> => {
  const electron = getElectronBridge();
  if (electron) return new ElectronBackupDestination(electron);
  const handle = await getStoredDirectoryHandle();
  if (!handle) return null;
  const destination = new FileSystemAccessBackupDestination(handle);
  await destination.cleanupStalePartials();
  return destination;
};

export const chooseBackupDestination = async (): Promise<BackupDestination | null> => {
  const electron = getElectronBridge();
  if (electron) {
    return await electron.chooseBackupDirectory()
      ? new ElectronBackupDestination(electron)
      : null;
  }
  const picker = (window as any).showDirectoryPicker as (
    options: { mode: 'readwrite' }
  ) => Promise<FileSystemDirectoryHandle>;
  if (!picker) return null;
  const handle = await picker({ mode: 'readwrite' });
  await storeDirectoryHandle(handle);
  const destination = new FileSystemAccessBackupDestination(handle);
  await destination.cleanupStalePartials();
  return destination;
};

export const reconnectBackupDestination = async (
  destination: BackupDestination
): Promise<boolean> => {
  if (destination.kind === 'electron') {
    return (await destination.getStatus()) === 'connected';
  }
  return (destination as FileSystemAccessBackupDestination).reconnect();
};

export const supportsAutomaticBackupDestination = (): boolean => (
  Boolean(getElectronBridge()) ||
  (
    typeof window !== 'undefined' &&
    typeof (window as any).showDirectoryPicker === 'function'
  )
);
