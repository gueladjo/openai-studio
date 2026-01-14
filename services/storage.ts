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
    storageBackend = 'indexeddb';
    idbDatabase = await initIndexedDB();
    console.log('Using IndexedDB storage backend (OPFS not available)');
  }

  return storageBackend;
};

// IndexedDB file operations
const idbWriteFile = async (filename: string, data: any): Promise<void> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readwrite');
    const store = transaction.objectStore(IDB_STORE);
    const request = store.put({ filename, data: JSON.stringify(data, null, 2) });

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
};

const idbReadFile = async <T>(filename: string): Promise<T | null> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readonly');
    const store = transaction.objectStore(IDB_STORE);
    const request = store.get(filename);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (request.result && request.result.data) {
        try {
          resolve(JSON.parse(request.result.data) as T);
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };
  });
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

// File Operations - automatically uses correct backend
export const writeJsonFile = async (dirHandle: FileSystemDirectoryHandle, filename: string, data: any) => {
  const backend = await getStorageBackend();

  if (backend === 'indexeddb') {
    try {
      await idbWriteFile(filename, data);
    } catch (e) {
      console.error(`Failed to write ${filename} to IndexedDB`, e);
    }
    return;
  }

  // OPFS path
  try {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    // createWritable is standard on FileSystemFileHandle in modern browsers supporting OPFS
    const writable = await (fileHandle as any).createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  } catch (e) {
    console.error(`Failed to write ${filename}`, e);
  }
};

export const readJsonFile = async <T>(dirHandle: FileSystemDirectoryHandle, filename: string): Promise<T | null> => {
  const backend = await getStorageBackend();

  if (backend === 'indexeddb') {
    try {
      return await idbReadFile<T>(filename);
    } catch (e) {
      return null;
    }
  }

  // OPFS path
  try {
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text) as T;
  } catch (e) {
    // If file doesn't exist yet, return null so the app can use defaults
    return null;
  }
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