import { FileAttachment, Session, SystemInstruction } from '../types';

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
const ATTACHMENTS_DIRECTORY = 'attachments';
const ATTACHMENT_KEY_PREFIX = `${ATTACHMENTS_DIRECTORY}/`;
const ATTACHMENT_GC_GRACE_MS = 5 * 60 * 1000;
const ATTACHMENT_GC_INTERVAL_MS = 60 * 1000;
let lastAttachmentGcAt = 0;

interface StoredFileRecord {
  filename: string;
  data: string | Blob;
  updatedAt?: number;
}

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

const isValidJsonText = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
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
const idbReadRawData = async (filename: string): Promise<StoredFileRecord | null> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readonly');
    const store = transaction.objectStore(IDB_STORE);
    const request = store.get(filename);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
};

const idbReadRawFile = async (filename: string): Promise<string | null> => {
  const record = await idbReadRawData(filename);
  return typeof record?.data === 'string' ? record.data : null;
};

const idbWriteRawData = async (filename: string, data: string | Blob): Promise<void> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readwrite');
    const store = transaction.objectStore(IDB_STORE);
    store.put({ filename, data, updatedAt: Date.now() });

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write was aborted.'));
  });
};

const idbWriteRawFile = async (filename: string, text: string): Promise<void> => {
  await idbWriteRawData(filename, text);
};

const idbDeleteRawFile = async (filename: string): Promise<void> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readwrite');
    const store = transaction.objectStore(IDB_STORE);
    store.delete(filename);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB delete failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB delete was aborted.'));
  });
};

const idbListRawFiles = async (prefix: string): Promise<Array<{ filename: string; updatedAt: number }>> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readonly');
    const store = transaction.objectStore(IDB_STORE);
    const request = store.openCursor();
    const records: Array<{ filename: string; updatedAt: number }> = [];

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(records);
        return;
      }

      const record = cursor.value as StoredFileRecord;
      if (record.filename.startsWith(prefix)) {
        records.push({
          filename: record.filename,
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0
        });
      }
      cursor.continue();
    };
  });
};

const idbWriteFile = async (filename: string, data: any): Promise<void> => {
  const nextText = JSON.stringify(data, null, 2);
  const previousText = await idbReadRawFile(filename);

  if (previousText && previousText !== nextText && isValidJsonText(previousText)) {
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

const getOpfsAttachmentsDirectory = async (
  dirHandle: FileSystemDirectoryHandle,
  create: boolean
): Promise<FileSystemDirectoryHandle | null> => {
  try {
    return await dirHandle.getDirectoryHandle(ATTACHMENTS_DIRECTORY, { create });
  } catch (error) {
    if (!create && isNotFoundError(error)) return null;
    throw error;
  }
};

const isValidAttachmentId = (id: unknown): id is string => (
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
);

const createAttachmentId = (): string => {
  const cryptoWithUuid = crypto as Crypto & { randomUUID?: () => string };
  if (cryptoWithUuid.randomUUID) return cryptoWithUuid.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const getAttachmentStorageKey = (id: string): string => `${ATTACHMENT_KEY_PREFIX}${id}`;

const writeAttachmentBlob = async (
  dirHandle: FileSystemDirectoryHandle,
  id: string,
  blob: Blob
): Promise<void> => {
  if (!isValidAttachmentId(id)) throw new Error('Attachment ID is invalid.');

  const backend = await getStorageBackend();
  if (backend === 'indexeddb') {
    await idbWriteRawData(getAttachmentStorageKey(id), blob);
    return;
  }

  const attachmentsDir = await getOpfsAttachmentsDirectory(dirHandle, true);
  if (!attachmentsDir) throw new Error('Attachment directory is unavailable.');

  const fileHandle = await attachmentsDir.getFileHandle(id, { create: true });
  const writable = await (fileHandle as any).createWritable();
  await writable.write(blob);
  await writable.close();
};

const readAttachmentBlob = async (
  dirHandle: FileSystemDirectoryHandle,
  id: string
): Promise<Blob | null> => {
  if (!isValidAttachmentId(id)) return null;

  const backend = await getStorageBackend();
  if (backend === 'indexeddb') {
    const record = await idbReadRawData(getAttachmentStorageKey(id));
    return record?.data instanceof Blob ? record.data : null;
  }

  const attachmentsDir = await getOpfsAttachmentsDirectory(dirHandle, false);
  if (!attachmentsDir) return null;

  try {
    const fileHandle = await attachmentsDir.getFileHandle(id);
    return await fileHandle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
};

const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Attachment content is not a data URL.');
  }

  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error('Attachment data URL could not be decoded.');
  return response.blob();
};

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onloadend = () => {
    if (typeof reader.result === 'string') resolve(reader.result);
    else reject(new Error('Attachment could not be encoded for the API.'));
  };
  reader.onerror = () => reject(reader.error || new Error('Attachment could not be read.'));
  reader.readAsDataURL(blob);
});

const applyAttachmentMimeType = (blob: Blob, type: string): Blob => (
  type && blob.type !== type ? blob.slice(0, blob.size, type) : blob
);

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

    if (previousText && previousText !== nextText && isValidJsonText(previousText)) {
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

const mapSessionAttachments = async (
  sessions: Session[],
  mapAttachment: (attachment: FileAttachment) => Promise<FileAttachment>
): Promise<Session[]> => Promise.all(sessions.map(async session => ({
  ...session,
  messages: await Promise.all(session.messages.map(async message => (
    message.attachments
      ? {
          ...message,
          attachments: await Promise.all(message.attachments.map(mapAttachment))
        }
      : message
  )))
})));

const toStoredSessions = (sessions: Session[]): Session[] => sessions.map(session => ({
  ...session,
  messages: session.messages.map(message => (
    message.attachments
      ? {
          ...message,
          attachments: message.attachments.map(attachment => {
            const storedAttachment: FileAttachment = {
              name: attachment.name,
              type: attachment.type
            };

            if (isValidAttachmentId(attachment.id)) {
              storedAttachment.id = attachment.id;
            } else if (attachment.content) {
              // Preserve an unreadable legacy attachment until it can be migrated.
              storedAttachment.content = attachment.content;
            }

            return storedAttachment;
          })
        }
      : message
  ))
}));

const externalizeSessionAttachments = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[],
  regenerateIds = false
): Promise<{ sessions: Session[]; changed: boolean }> => {
  let changed = false;

  const externalizedSessions = await mapSessionAttachments(sessions, async attachment => {
    const existingId = isValidAttachmentId(attachment.id) ? attachment.id : undefined;
    const name = typeof attachment.name === 'string' ? attachment.name : 'Attachment';
    const type = typeof attachment.type === 'string' ? attachment.type : 'application/octet-stream';

    if (!attachment.content) {
      const normalizedAttachment: FileAttachment = {
        name,
        type,
        ...(!regenerateIds && existingId ? { id: existingId } : {})
      };

      if (
        attachment.previewUrl ||
        attachment.id !== existingId ||
        (regenerateIds && existingId)
      ) {
        changed = true;
      }
      return normalizedAttachment;
    }

    try {
      const blob = await dataUrlToBlob(attachment.content);
      const id = regenerateIds || !existingId ? createAttachmentId() : existingId;
      await writeAttachmentBlob(dirHandle, id, blob);
      changed = true;
      return {
        id,
        name,
        type: type || blob.type
      };
    } catch (error) {
      console.warn(`Failed to externalize attachment ${name}`, error);
      changed = true;
      return {
        name,
        type,
        ...(typeof attachment.content === 'string' && attachment.content.startsWith('data:')
          ? { content: attachment.content }
          : {})
      };
    }
  });

  return { sessions: externalizedSessions, changed };
};

const addRuntimeAttachmentPreviews = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[]
): Promise<Session[]> => mapSessionAttachments(sessions, async attachment => {
  if (!attachment.type.startsWith('image/') || !isValidAttachmentId(attachment.id)) {
    return attachment;
  }

  try {
    const blob = await readAttachmentBlob(dirHandle, attachment.id);
    if (!blob) {
      console.warn(`Stored attachment ${attachment.id} (${attachment.name}) is missing.`);
      return attachment;
    }

    return {
      ...attachment,
      previewUrl: URL.createObjectURL(applyAttachmentMimeType(blob, attachment.type))
    };
  } catch (error) {
    console.warn(`Failed to load attachment preview ${attachment.name}`, error);
    return attachment;
  }
});

const collectAttachmentIds = (sessions: Session[]): Set<string> => {
  const ids = new Set<string>();

  sessions.forEach(session => {
    session.messages.forEach(message => {
      message.attachments?.forEach(attachment => {
        if (isValidAttachmentId(attachment.id)) ids.add(attachment.id);
      });
    });
  });

  return ids;
};

const readRawTextFile = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: string
): Promise<string | null> => {
  const backend = await getStorageBackend();
  return backend === 'indexeddb'
    ? idbReadRawFile(filename)
    : readOpfsTextFile(dirHandle, filename);
};

const pruneUnreferencedAttachments = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[],
  force = false
): Promise<void> => {
  const now = Date.now();
  if (!force && now - lastAttachmentGcAt < ATTACHMENT_GC_INTERVAL_MS) return;
  lastAttachmentGcAt = now;

  const referencedIds = collectAttachmentIds(sessions);
  const backupText = await readRawTextFile(
    dirHandle,
    getBackupFilename(STORAGE_FILES.SESSIONS)
  );

  if (backupText) {
    try {
      collectAttachmentIds(JSON.parse(backupText) as Session[]).forEach(id => referencedIds.add(id));
    } catch (error) {
      // Avoid deleting files when the recovery metadata cannot be inspected.
      console.warn('Skipped attachment cleanup because sessions.json.bak is invalid.', error);
      return;
    }
  }

  const cutoff = now - ATTACHMENT_GC_GRACE_MS;
  const backend = await getStorageBackend();

  if (backend === 'indexeddb') {
    const files = await idbListRawFiles(ATTACHMENT_KEY_PREFIX);
    await Promise.all(files.map(async file => {
      const id = file.filename.slice(ATTACHMENT_KEY_PREFIX.length);
      if (!referencedIds.has(id) && file.updatedAt < cutoff) {
        await idbDeleteRawFile(file.filename);
      }
    }));
    return;
  }

  const attachmentsDir = await getOpfsAttachmentsDirectory(dirHandle, false);
  if (!attachmentsDir) return;

  for await (const [name, entry] of (attachmentsDir as any).entries()) {
    if (entry.kind !== 'file' || referencedIds.has(name)) continue;

    const file = await entry.getFile();
    if (file.lastModified < cutoff) {
      await attachmentsDir.removeEntry(name);
    }
  }
};

export const storeAttachment = async (
  dirHandle: FileSystemDirectoryHandle,
  file: File
): Promise<string> => {
  const id = createAttachmentId();
  await writeAttachmentBlob(dirHandle, id, file);
  return id;
};

export const getAttachmentDataUrl = async (
  dirHandle: FileSystemDirectoryHandle,
  attachment: FileAttachment
): Promise<string | undefined> => {
  if (attachment.content) return attachment.content;
  if (!isValidAttachmentId(attachment.id)) return undefined;

  const blob = await readAttachmentBlob(dirHandle, attachment.id);
  if (!blob) {
    throw new Error(`Attachment "${attachment.name}" is missing from local storage.`);
  }

  return blobToDataUrl(applyAttachmentMimeType(blob, attachment.type));
};

export const writeSessions = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[]
): Promise<void> => {
  const storedSessions = toStoredSessions(sessions);
  await writeJsonFile(dirHandle, STORAGE_FILES.SESSIONS, storedSessions);

  try {
    await pruneUnreferencedAttachments(dirHandle, storedSessions);
  } catch (error) {
    console.warn('Failed to clean up unreferenced attachments.', error);
  }
};

export const readSessions = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<Session[]> => {
  const storedSessions = await readJsonFile<Session[]>(dirHandle, STORAGE_FILES.SESSIONS) || [];
  const externalized = await externalizeSessionAttachments(dirHandle, storedSessions);

  if (externalized.changed) {
    await writeSessions(dirHandle, externalized.sessions);
  } else {
    try {
      await pruneUnreferencedAttachments(dirHandle, externalized.sessions, true);
    } catch (error) {
      console.warn('Failed to clean up unreferenced attachments.', error);
    }
  }

  return addRuntimeAttachmentPreviews(dirHandle, externalized.sessions);
};

// Data Management
// Exported backups never include the API key; apiKey stays optional so backups
// created before this policy still parse, and restore discards it either way.
export type BackupSettings = Omit<AppSettings, 'apiKey'> & { apiKey?: string };

export interface WorkspaceBackup {
  sessions: Session[];
  settings: BackupSettings | null;
  instructions: SystemInstruction[];
  timestamp: number;
}

const embedAttachmentDataForBackup = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[]
): Promise<Session[]> => mapSessionAttachments(sessions, async attachment => {
  const content = await getAttachmentDataUrl(dirHandle, attachment);

  return {
    ...(isValidAttachmentId(attachment.id) ? { id: attachment.id } : {}),
    name: attachment.name,
    type: attachment.type,
    ...(content ? { content } : {})
  };
});

export const getWorkspaceBackup = async (dirHandle: FileSystemDirectoryHandle): Promise<WorkspaceBackup> => {
  const storedSessions = await readJsonFile<Session[]>(dirHandle, STORAGE_FILES.SESSIONS) || [];
  const externalized = await externalizeSessionAttachments(dirHandle, storedSessions);
  if (externalized.changed) await writeSessions(dirHandle, externalized.sessions);

  const sessions = await embedAttachmentDataForBackup(dirHandle, externalized.sessions);
  const settings = await readJsonFile<AppSettings>(dirHandle, STORAGE_FILES.SETTINGS);
  const instructions = await readJsonFile<SystemInstruction[]>(dirHandle, STORAGE_FILES.INSTRUCTIONS) || [];

  let backupSettings: BackupSettings | null = null;
  if (settings) {
    backupSettings = { ...settings };
    delete backupSettings.apiKey;
  }

  return {
    sessions,
    settings: backupSettings,
    instructions,
    timestamp: Date.now()
  };
};

export const restoreWorkspaceBackup = async (dirHandle: FileSystemDirectoryHandle, backup: WorkspaceBackup): Promise<void> => {
  if (backup.sessions) {
    const externalized = await externalizeSessionAttachments(dirHandle, backup.sessions, true);
    await writeSessions(dirHandle, externalized.sessions);
  }
  if (backup.settings) {
    const currentSettings = await readJsonFile<AppSettings>(dirHandle, STORAGE_FILES.SETTINGS);
    const restoredSettings: AppSettings = {
      ...backup.settings,
      apiKey: currentSettings?.apiKey || ''
    };
    await writeJsonFile(dirHandle, STORAGE_FILES.SETTINGS, restoredSettings);
  }
  if (backup.instructions) await writeJsonFile(dirHandle, STORAGE_FILES.INSTRUCTIONS, backup.instructions);
};
