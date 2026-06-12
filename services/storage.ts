import { Session, SystemInstruction } from '../types';

export interface AppSettings {
  theme: 'dark' | 'light';
  apiKey: string;
  lastActiveSessionId?: string;
}

export const STORAGE_FILES = {
  SESSIONS: 'sessions.json',
  SETTINGS: 'settings.json',
  INSTRUCTIONS: 'system_instructions.json'
};

// Storage abstraction that uses OPFS when available, IndexedDB as fallback (for iOS Safari)
type StorageBackend = 'opfs' | 'indexeddb';
let storageBackend: StorageBackend | null = null;
let idbDatabase: IDBDatabase | null = null;

const IDB_NAME = 'openai-studio-storage';
const IDB_STORE = 'files';
const IDB_VERSION = 1;
const BACKUP_SUFFIX = '.bak';

const getBackupFilename = (filename: string): string => `${filename}${BACKUP_SUFFIX}`;

const isElectronDesktop = (): boolean => (
  typeof window !== 'undefined' && Boolean((window as any).electronAPI)
);

const isNotFoundError = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotFoundError'
);

const parseStoredJson = <T>(filename: string, text: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Stored file ${filename} is not valid JSON.`);
  }
};

const parseStoredJsonWithBackup = async <T>(
  filename: string,
  text: string,
  readBackupText: () => Promise<string | null>
): Promise<T> => {
  try {
    return parseStoredJson<T>(filename, text);
  } catch (primaryError) {
    const backupFilename = getBackupFilename(filename);

    try {
      const backupText = await readBackupText();
      if (backupText !== null) {
        console.warn(`Failed to parse ${filename}; loaded ${backupFilename} instead.`);
        return parseStoredJson<T>(backupFilename, backupText);
      }
    } catch (backupError) {
      console.warn(`Failed to load backup ${backupFilename}`, backupError);
    }

    throw primaryError;
  }
};

// Check if OPFS is supported
const checkOPFSSupport = async (): Promise<boolean> => {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      return false;
    }
    const root = await navigator.storage.getDirectory();
    // Try to create a test directory to verify full OPFS support
    await root.getDirectoryHandle('__opfs_test__', { create: true });
    await root.removeEntry('__opfs_test__');
    return true;
  } catch {
    return false;
  }
};

// Initialize IndexedDB
const initIndexedDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'filename' });
      }
    };
  });
};

// Get storage backend - initializes on first call
const getStorageBackend = async (): Promise<StorageBackend> => {
  if (storageBackend !== null) {
    return storageBackend;
  }

  const hasOPFS = await checkOPFSSupport();
  if (hasOPFS) {
    storageBackend = 'opfs';
    console.log('Using OPFS storage backend');
  } else {
    if (isElectronDesktop()) {
      throw new Error('OPFS storage is unavailable in Electron. Workspace loading was stopped to avoid switching to an empty fallback store.');
    }

    storageBackend = 'indexeddb';
    idbDatabase = await initIndexedDB();
    console.log('Using IndexedDB storage backend (OPFS not available)');
  }

  return storageBackend;
};

// IndexedDB file operations
const idbReadRawFile = async (filename: string): Promise<string | null> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readonly');
    const store = transaction.objectStore(IDB_STORE);
    const request = store.get(filename);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const data = request.result?.data;
      resolve(typeof data === 'string' ? data : null);
    };
  });
};

const idbWriteRawFile = async (filename: string, text: string): Promise<void> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readwrite');
    const store = transaction.objectStore(IDB_STORE);
    const request = store.put({ filename, data: text });

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
};

const idbWriteFile = async (filename: string, data: any): Promise<void> => {
  const nextText = JSON.stringify(data, null, 2);
  const previousText = await idbReadRawFile(filename);

  if (previousText && previousText !== nextText) {
    await idbWriteRawFile(getBackupFilename(filename), previousText);
  }

  await idbWriteRawFile(filename, nextText);
};

const idbReadFile = async <T>(filename: string): Promise<T | null> => {
  const text = await idbReadRawFile(filename);
  if (text === null) return null;

  return parseStoredJsonWithBackup<T>(
    filename,
    text,
    () => idbReadRawFile(getBackupFilename(filename))
  );
};

// OPFS directory handle cache
let opfsDataDir: FileSystemDirectoryHandle | null = null;

// Access the Origin Private File System (OPFS)
// This creates a sandboxed 'data' folder automatically without user prompts.
export const getStorageHandle = async (): Promise<FileSystemDirectoryHandle> => {
  const backend = await getStorageBackend();

  if (backend === 'indexeddb') {
    // Return a dummy handle for IndexedDB - actual operations use idb functions
    return {} as FileSystemDirectoryHandle;
  }

  if (opfsDataDir) {
    return opfsDataDir;
  }

  try {
    // Get the root of the OPFS
    const root = await navigator.storage.getDirectory();
    // Create or retrieve the 'data' directory
    opfsDataDir = await root.getDirectoryHandle('data', { create: true });
    return opfsDataDir;
  } catch (e) {
    console.error("Failed to access OPFS", e);
    throw e;
  }
};

const readOpfsTextFile = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: string
): Promise<string | null> => {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return file.text();
  } catch (e) {
    if (isNotFoundError(e)) {
      return null;
    }
    throw e;
  }
};

const writeOpfsTextFile = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
  text: string
): Promise<void> => {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await (fileHandle as any).createWritable();
  await writable.write(text);
  await writable.close();
};

// File Operations - automatically uses correct backend
export const writeJsonFile = async (dirHandle: FileSystemDirectoryHandle, filename: string, data: any) => {
  const backend = await getStorageBackend();

  if (backend === 'indexeddb') {
    try {
      await idbWriteFile(filename, data);
    } catch (e) {
      console.error(`Failed to write ${filename} to IndexedDB`, e);
      throw e;
    }
    return;
  }

  // OPFS path
  try {
    const nextText = JSON.stringify(data, null, 2);
    const previousText = await readOpfsTextFile(dirHandle, filename);

    if (previousText && previousText !== nextText) {
      await writeOpfsTextFile(dirHandle, getBackupFilename(filename), previousText);
    }

    await writeOpfsTextFile(dirHandle, filename, nextText);
  } catch (e) {
    console.error(`Failed to write ${filename}`, e);
    throw e;
  }
};

export const readJsonFile = async <T>(dirHandle: FileSystemDirectoryHandle, filename: string): Promise<T | null> => {
  const backend = await getStorageBackend();

  if (backend === 'indexeddb') {
    return idbReadFile<T>(filename);
  }

  // OPFS path
  const text = await readOpfsTextFile(dirHandle, filename);
  if (text === null) return null;

  return parseStoredJsonWithBackup<T>(
    filename,
    text,
    () => readOpfsTextFile(dirHandle, getBackupFilename(filename))
  );
};

// Data Management
export interface WorkspaceBackup {
  sessions: Session[];
  settings: AppSettings | null;
  instructions: SystemInstruction[];
  timestamp: number;
}

export const getWorkspaceBackup = async (dirHandle: FileSystemDirectoryHandle): Promise<WorkspaceBackup> => {
  const sessions = await readJsonFile<Session[]>(dirHandle, STORAGE_FILES.SESSIONS) || [];
  const settings = await readJsonFile<AppSettings>(dirHandle, STORAGE_FILES.SETTINGS);
  const instructions = await readJsonFile<SystemInstruction[]>(dirHandle, STORAGE_FILES.INSTRUCTIONS) || [];
  
  return {
    sessions,
    settings,
    instructions,
    timestamp: Date.now()
  };
};

export const restoreWorkspaceBackup = async (dirHandle: FileSystemDirectoryHandle, backup: WorkspaceBackup): Promise<void> => {
  if (backup.sessions) await writeJsonFile(dirHandle, STORAGE_FILES.SESSIONS, backup.sessions);
  if (backup.settings) await writeJsonFile(dirHandle, STORAGE_FILES.SETTINGS, backup.settings);
  if (backup.instructions) await writeJsonFile(dirHandle, STORAGE_FILES.INSTRUCTIONS, backup.instructions);
};
