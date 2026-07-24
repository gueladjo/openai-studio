import { FileAttachment, Session, SystemInstruction } from '../types';
import {
  selectStorageBackend,
  StorageBackend,
  StorageBackendChoice,
  StorageBackendChoiceRequest,
  StorageBackendSnapshot
} from './storageBackend';

export type {
  StorageBackend,
  StorageBackendChoice,
  StorageBackendChoiceRequest
} from './storageBackend';

export interface AppSettings {
  theme: 'dark' | 'light';
  apiKey: string;
  lastActiveSessionId?: string;
}

export const STORAGE_FILES = {
  SESSIONS: 'sessions.json',
  SETTINGS: 'settings.json',
  INSTRUCTIONS: 'system_instructions.json',
  REVISION: 'workspace_revision.json'
};

// Storage abstraction that uses OPFS when available, IndexedDB as fallback (for iOS Safari)
let storageBackend: StorageBackend | null = null;
let idbDatabase: IDBDatabase | null = null;
let workspaceRevision: number | null = null;

const IDB_NAME = 'openai-studio-storage';
const IDB_STORE = 'files';
const IDB_VERSION = 1;
const BACKEND_IDENTITY_KEY = 'openai-studio-storage-backend-v1';
const BACKEND_IDENTITY_VERSION = 1;
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

interface WorkspaceRevisionRecord {
  revision: number;
}

interface StorageBackendIdentity {
  version: number;
  backend: StorageBackend;
}

interface BackendRecord {
  filename: string;
  data: string | Blob;
}

interface BackendInspection {
  snapshot: StorageBackendSnapshot;
  records: BackendRecord[];
  opfsRoot?: FileSystemDirectoryHandle;
  opfsDataDir?: FileSystemDirectoryHandle | null;
}

export interface StorageInitializationOptions {
  readOnly?: boolean;
  resolveBackendChoice?: (
    request: StorageBackendChoiceRequest
  ) => StorageBackendChoice | Promise<StorageBackendChoice>;
}

export class WorkspaceRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Workspace changed in another tab (expected revision ${expectedRevision}, found ${actualRevision}).`
    );
    this.name = 'WorkspaceRevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
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

const createOpfsProbeName = (): string => {
  const cryptoWithUuid = crypto as Crypto & { randomUUID?: () => string };
  const id = cryptoWithUuid.randomUUID
    ? cryptoWithUuid.randomUUID()
    : Array.from(
        crypto.getRandomValues(new Uint8Array(12)),
        byte => byte.toString(16).padStart(2, '0')
      ).join('');
  return `__opfs_test_${id}`;
};

// Check if OPFS is supported without sharing a probe path across tabs.
const checkOPFSSupport = async (): Promise<boolean> => {
  let root: FileSystemDirectoryHandle | null = null;
  let probeName: string | null = null;
  let probeCreated = false;

  try {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      return false;
    }
    root = await navigator.storage.getDirectory();
    probeName = createOpfsProbeName();
    await root.getDirectoryHandle(probeName, { create: true });
    probeCreated = true;
    return true;
  } catch {
    return false;
  } finally {
    if (root && probeName && probeCreated) {
      try {
        await root.removeEntry(probeName);
      } catch (error) {
        console.warn(`Failed to remove OPFS capability probe ${probeName}.`, error);
      }
    }
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

// Storage must be explicitly initialized so calls cannot silently select a
// different backend after startup.
const getStorageBackend = async (): Promise<StorageBackend> => {
  if (storageBackend === null) {
    throw new Error('Workspace storage backend has not been initialized.');
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

const idbListAllRawData = async (): Promise<StoredFileRecord[]> => {
  if (!idbDatabase) {
    idbDatabase = await initIndexedDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = idbDatabase!.transaction([IDB_STORE], 'readonly');
    const store = transaction.objectStore(IDB_STORE);
    const request = store.openCursor();
    const records: StoredFileRecord[] = [];

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(records);
        return;
      }

      const record = cursor.value as StoredFileRecord;
      records.push(record);
      cursor.continue();
    };
  });
};

const idbListRawFiles = async (
  prefix: string
): Promise<Array<{ filename: string; updatedAt: number }>> => {
  const records = await idbListAllRawData();
  return records
    .filter(record => record.filename.startsWith(prefix))
    .map(record => ({
      filename: record.filename,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0
    }));
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
export const getStorageHandle = async (
  options: StorageInitializationOptions = {}
): Promise<FileSystemDirectoryHandle> => {
  const backend = storageBackend || await initializeStorageBackend(options);

  if (backend === 'indexeddb') {
    // Return a dummy handle for IndexedDB - actual operations use idb functions
    return {} as FileSystemDirectoryHandle;
  }

  if (opfsDataDir) {
    return opfsDataDir;
  }

  const root = await navigator.storage.getDirectory();
  opfsDataDir = await root.getDirectoryHandle('data', { create: true });
  return opfsDataDir;
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

const readBackendIdentity = (value: string | null): StorageBackendIdentity | null => {
  if (!value) return null;

  try {
    const identity = JSON.parse(value) as Partial<StorageBackendIdentity>;
    if (
      identity.version !== BACKEND_IDENTITY_VERSION ||
      (identity.backend !== 'opfs' && identity.backend !== 'indexeddb')
    ) {
      return null;
    }
    return {
      version: identity.version,
      backend: identity.backend
    };
  } catch {
    return null;
  }
};

const getPersistedBackend = (): StorageBackend | null => {
  try {
    return readBackendIdentity(window.localStorage.getItem(BACKEND_IDENTITY_KEY))?.backend || null;
  } catch (error) {
    throw new Error(`Storage backend identity could not be read: ${getErrorMessage(error)}`);
  }
};

const persistBackend = (backend: StorageBackend): void => {
  const identity: StorageBackendIdentity = {
    version: BACKEND_IDENTITY_VERSION,
    backend
  };
  const serialized = JSON.stringify(identity);

  try {
    window.localStorage.setItem(BACKEND_IDENTITY_KEY, serialized);
    if (window.localStorage.getItem(BACKEND_IDENTITY_KEY) !== serialized) {
      throw new Error('The stored value could not be verified.');
    }
  } catch (error) {
    throw new Error(`Storage backend identity could not be persisted: ${getErrorMessage(error)}`);
  }
};

export const getActiveStorageBackend = (): StorageBackend | null => storageBackend;

export const subscribeToStorageBackendChanges = (
  listener: (backend: StorageBackend) => void
): (() => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== BACKEND_IDENTITY_KEY) return;
    const identity = readBackendIdentity(event.newValue);
    if (identity) listener(identity.backend);
  };

  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
};

const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const hashText = (text: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const getRecordsFingerprint = (
  records: BackendRecord[],
  extraDescriptors: string[] = []
): string => {
  const descriptors = records.map(record => (
    typeof record.data === 'string'
      ? `${record.filename}:text:${record.data.length}:${hashText(record.data)}`
      : `${record.filename}:blob:${record.data.size}`
  ));
  return [...descriptors, ...extraDescriptors].sort().join('|');
};

const getBlobDigest = async (blob: Blob): Promise<string> => {
  const bytes = await blob.arrayBuffer();
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => (
      byte.toString(16).padStart(2, '0')
    )).join('');
  }

  let hash = 2166136261;
  for (const byte of new Uint8Array(bytes)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const backendRecordsMatch = async (
  leftRecords: BackendRecord[],
  rightRecords: BackendRecord[]
): Promise<boolean> => {
  if (leftRecords.length !== rightRecords.length) return false;
  const rightByFilename = new Map(
    rightRecords.map(record => [record.filename, record])
  );

  for (const left of leftRecords) {
    const right = rightByFilename.get(left.filename);
    if (!right || typeof left.data !== typeof right.data) return false;

    if (typeof left.data === 'string' && typeof right.data === 'string') {
      if (left.data !== right.data) return false;
      continue;
    }

    if (!(left.data instanceof Blob) || !(right.data instanceof Blob)) return false;
    if (left.data.size !== right.data.size) return false;
    if (await getBlobDigest(left.data) !== await getBlobDigest(right.data)) return false;
  }

  return true;
};

const getRevisionFromRecords = (records: BackendRecord[]): number | null => {
  const revisionRecord = records.find(record => record.filename === STORAGE_FILES.REVISION);
  if (!revisionRecord || typeof revisionRecord.data !== 'string') return null;

  try {
    return parseWorkspaceRevision(revisionRecord.data);
  } catch {
    return null;
  }
};

const createSnapshot = (
  backend: StorageBackend,
  available: boolean,
  records: BackendRecord[],
  extraDescriptors: string[] = []
): StorageBackendSnapshot => ({
  backend,
  available,
  hasWorkspace: records.length > 0 || extraDescriptors.length > 0,
  fingerprint: records.length > 0 || extraDescriptors.length > 0
    ? getRecordsFingerprint(records, extraDescriptors)
    : null,
  revision: getRevisionFromRecords(records),
  recordCount: records.length + extraDescriptors.length
});

const inspectIndexedDbBackend = async (): Promise<BackendInspection> => {
  if (typeof indexedDB === 'undefined') {
    return {
      snapshot: createSnapshot('indexeddb', false, []),
      records: []
    };
  }

  idbDatabase = await initIndexedDB();
  const storedRecords = await idbListAllRawData();
  const extraDescriptors: string[] = [];
  const records = storedRecords
    .flatMap(record => {
      if (
        typeof record.filename !== 'string' ||
        (typeof record.data !== 'string' && !(record.data instanceof Blob))
      ) {
        extraDescriptors.push(`invalid-record:${String(record.filename)}`);
        return [];
      }
      return [{
        filename: record.filename,
        data: record.data
      }];
    });

  return {
    snapshot: createSnapshot('indexeddb', true, records, extraDescriptors),
    records
  };
};

const getExistingOpfsDataDirectory = async (
  root: FileSystemDirectoryHandle
): Promise<FileSystemDirectoryHandle | null> => {
  try {
    return await root.getDirectoryHandle('data');
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
};

const inspectOpfsBackend = async (supported: boolean): Promise<BackendInspection> => {
  if (!supported) {
    return {
      snapshot: createSnapshot('opfs', false, []),
      records: []
    };
  }

  const root = await navigator.storage.getDirectory();
  const dataDir = await getExistingOpfsDataDirectory(root);
  if (!dataDir) {
    return {
      snapshot: createSnapshot('opfs', true, []),
      records: [],
      opfsRoot: root,
      opfsDataDir: null
    };
  }

  const records: BackendRecord[] = [];
  const extraDescriptors: string[] = [];

  for await (const [name, entry] of (dataDir as any).entries()) {
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      records.push({
        filename: name,
        data: await file.text()
      });
      continue;
    }

    if (entry.kind !== 'directory' || name !== ATTACHMENTS_DIRECTORY) {
      extraDescriptors.push(`${entry.kind}:${name}`);
      continue;
    }

    for await (const [attachmentName, attachmentEntry] of entry.entries()) {
      if (attachmentEntry.kind !== 'file') {
        extraDescriptors.push(
          `attachments/${attachmentEntry.kind}:${attachmentName}`
        );
        continue;
      }

      records.push({
        filename: `${ATTACHMENT_KEY_PREFIX}${attachmentName}`,
        data: await attachmentEntry.getFile()
      });
    }
  }

  return {
    snapshot: createSnapshot('opfs', true, records, extraDescriptors),
    records,
    opfsRoot: root,
    opfsDataDir: dataDir
  };
};

const rollbackOpfsMigration = async (
  dataDir: FileSystemDirectoryHandle,
  writtenRecords: BackendRecord[]
): Promise<void> => {
  const attachmentNames = writtenRecords
    .filter(record => record.filename.startsWith(ATTACHMENT_KEY_PREFIX))
    .map(record => record.filename.slice(ATTACHMENT_KEY_PREFIX.length));
  const topLevelNames = writtenRecords
    .filter(record => !record.filename.startsWith(ATTACHMENT_KEY_PREFIX))
    .map(record => record.filename);

  for (const filename of topLevelNames) {
    try {
      await dataDir.removeEntry(filename);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  if (attachmentNames.length === 0) return;
  const attachmentsDir = await getOpfsAttachmentsDirectory(dataDir, false);
  if (!attachmentsDir) return;

  for (const filename of attachmentNames) {
    try {
      await attachmentsDir.removeEntry(filename);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  try {
    await dataDir.removeEntry(ATTACHMENTS_DIRECTORY);
  } catch (error) {
    if (!isNotFoundError(error)) {
      console.warn('Failed to remove the empty migration attachment directory.', error);
    }
  }
};

const copyIndexedDbWorkspaceToOpfs = async (
  indexeddb: BackendInspection,
  opfs: BackendInspection
): Promise<() => Promise<void>> => {
  if (!opfs.opfsRoot || opfs.snapshot.hasWorkspace) {
    throw new Error('OPFS migration requires an available, empty destination.');
  }

  const dataDir = opfs.opfsDataDir ||
    await opfs.opfsRoot.getDirectoryHandle('data', { create: true });
  const writtenRecords: BackendRecord[] = [];

  try {
    for (const record of indexeddb.records) {
      if (record.filename.startsWith(ATTACHMENT_KEY_PREFIX)) {
        const attachmentName = record.filename.slice(ATTACHMENT_KEY_PREFIX.length);
        if (!isValidAttachmentId(attachmentName) || !(record.data instanceof Blob)) {
          throw new Error(`IndexedDB attachment record ${record.filename} is invalid.`);
        }

        const attachmentsDir = await getOpfsAttachmentsDirectory(dataDir, true);
        if (!attachmentsDir) throw new Error('OPFS attachment directory is unavailable.');
        const fileHandle = await attachmentsDir.getFileHandle(attachmentName, { create: true });
        const writable = await (fileHandle as any).createWritable();
        await writable.write(record.data);
        await writable.close();
      } else {
        if (
          record.filename.includes('/') ||
          typeof record.data !== 'string'
        ) {
          throw new Error(`IndexedDB file record ${record.filename} is invalid.`);
        }
        await writeOpfsTextFile(dataDir, record.filename, record.data);
      }

      writtenRecords.push(record);
    }

    const verified = await inspectOpfsBackend(true);
    if (
      !verified.snapshot.hasWorkspace ||
      verified.snapshot.fingerprint !== indexeddb.snapshot.fingerprint ||
      !(await backendRecordsMatch(indexeddb.records, verified.records))
    ) {
      throw new Error('The OPFS migration copy did not match the IndexedDB source.');
    }

    opfsDataDir = dataDir;
    return () => rollbackOpfsMigration(dataDir, writtenRecords);
  } catch (error) {
    try {
      await rollbackOpfsMigration(dataDir, writtenRecords);
    } catch (rollbackError) {
      console.error('Failed to roll back an incomplete OPFS migration.', rollbackError);
    }
    throw error;
  }
};

async function initializeStorageBackend(
  options: StorageInitializationOptions
): Promise<StorageBackend> {
  const persistedBackend = getPersistedBackend();
  const hasOpfs = await checkOPFSSupport();
  const [opfs, indexeddb] = await Promise.all([
    inspectOpfsBackend(hasOpfs),
    inspectIndexedDbBackend()
  ]);

  const needsContentComparison = (
    opfs.snapshot.hasWorkspace &&
    indexeddb.snapshot.hasWorkspace &&
    opfs.snapshot.fingerprint === indexeddb.snapshot.fingerprint &&
    (persistedBackend === null || persistedBackend === 'indexeddb')
  );
  if (
    needsContentComparison &&
    !(await backendRecordsMatch(opfs.records, indexeddb.records))
  ) {
    opfs.snapshot = {
      ...opfs.snapshot,
      fingerprint: `${opfs.snapshot.fingerprint}:different-content`
    };
  }

  const selection = selectStorageBackend({
    persistedBackend,
    opfs: opfs.snapshot,
    indexeddb: indexeddb.snapshot,
    isElectron: isElectronDesktop(),
    readOnly: Boolean(options.readOnly)
  });

  if (selection.kind === 'error') throw new Error(selection.message);

  let selectedBackend: StorageBackend;
  let rollbackMigration: (() => Promise<void>) | null = null;

  if (selection.kind === 'use') {
    selectedBackend = selection.backend;
  } else {
    if (!options.resolveBackendChoice) {
      throw new Error('Storage backend selection requires confirmation in the writer tab.');
    }

    const choice = await options.resolveBackendChoice(selection.request);
    if (choice === 'cancel') {
      throw new Error('Storage backend selection was cancelled.');
    }

    if (selection.request.kind === 'migration') {
      if (choice === 'indexeddb') {
        selectedBackend = 'indexeddb';
      } else if (choice === 'migrate-to-opfs' || choice === 'opfs') {
        if (opfs.snapshot.fingerprint !== indexeddb.snapshot.fingerprint) {
          rollbackMigration = await copyIndexedDbWorkspaceToOpfs(indexeddb, opfs);
        }
        selectedBackend = 'opfs';
      } else {
        throw new Error(`Unsupported storage migration choice: ${choice}`);
      }
    } else if (choice === 'opfs' || choice === 'indexeddb') {
      selectedBackend = choice;
    } else {
      throw new Error(`Unsupported storage conflict choice: ${choice}`);
    }
  }

  if (selectedBackend === 'opfs' && !opfs.snapshot.available) {
    throw new Error('OPFS was selected but is unavailable.');
  }
  if (selectedBackend === 'indexeddb' && !indexeddb.snapshot.available) {
    throw new Error('IndexedDB was selected but is unavailable.');
  }
  if (isElectronDesktop() && selectedBackend !== 'opfs') {
    throw new Error('Electron requires OPFS and will not open an IndexedDB fallback workspace.');
  }

  if (!options.readOnly) {
    try {
      persistBackend(selectedBackend);
    } catch (error) {
      if (rollbackMigration) {
        try {
          await rollbackMigration();
        } catch (rollbackError) {
          console.error('Failed to roll back OPFS after identity persistence failed.', rollbackError);
        }
      }
      throw error;
    }
  }

  storageBackend = selectedBackend;
  workspaceRevision = null;

  if (selectedBackend === 'opfs') {
    const root = opfs.opfsRoot || await navigator.storage.getDirectory();
    opfsDataDir = opfsDataDir || opfs.opfsDataDir ||
      await root.getDirectoryHandle('data', { create: true });
  }

  console.log(`Using ${selectedBackend === 'opfs' ? 'OPFS' : 'IndexedDB'} storage backend`);
  return selectedBackend;
}

const parseWorkspaceRevision = (text: string | null): number => {
  if (text === null) return 0;

  const value = parseStoredJson<WorkspaceRevisionRecord>(STORAGE_FILES.REVISION, text);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error(`Stored file ${STORAGE_FILES.REVISION} has an invalid revision.`);
  }
  return value.revision;
};

const readPersistedWorkspaceRevision = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<number> => {
  const backend = await getStorageBackend();
  const text = backend === 'indexeddb'
    ? await idbReadRawFile(STORAGE_FILES.REVISION)
    : await readOpfsTextFile(dirHandle, STORAGE_FILES.REVISION);
  return parseWorkspaceRevision(text);
};

const writePersistedWorkspaceRevision = async (
  dirHandle: FileSystemDirectoryHandle,
  revision: number
): Promise<void> => {
  const text = JSON.stringify({ revision } satisfies WorkspaceRevisionRecord, null, 2);
  const backend = await getStorageBackend();

  if (backend === 'indexeddb') {
    await idbWriteRawFile(STORAGE_FILES.REVISION, text);
  } else {
    await writeOpfsTextFile(dirHandle, STORAGE_FILES.REVISION, text);
  }
};

export const synchronizeWorkspaceRevision = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<number> => {
  workspaceRevision = await readPersistedWorkspaceRevision(dirHandle);
  return workspaceRevision;
};

export const getWorkspaceRevision = (): number => {
  if (workspaceRevision === null) {
    throw new Error('Workspace revision has not been initialized.');
  }
  return workspaceRevision;
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
export const writeJsonFile = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
  data: any
): Promise<number> => {
  if (filename === STORAGE_FILES.REVISION) {
    throw new Error('Workspace revisions are managed internally.');
  }
  if (workspaceRevision === null) {
    throw new Error('Workspace revision has not been initialized.');
  }

  const backend = await getStorageBackend();
  const persistedRevision = await readPersistedWorkspaceRevision(dirHandle);
  if (persistedRevision !== workspaceRevision) {
    throw new WorkspaceRevisionConflictError(workspaceRevision, persistedRevision);
  }

  if (backend === 'indexeddb') {
    try {
      await idbWriteFile(filename, data);
    } catch (e) {
      console.error(`Failed to write ${filename} to IndexedDB`, e);
      throw e;
    }
  } else {
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
  }

  const nextRevision = persistedRevision + 1;
  await writePersistedWorkspaceRevision(dirHandle, nextRevision);
  workspaceRevision = nextRevision;
  return nextRevision;
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
): Promise<number> => {
  const storedSessions = toStoredSessions(sessions);
  const revision = await writeJsonFile(dirHandle, STORAGE_FILES.SESSIONS, storedSessions);

  try {
    await pruneUnreferencedAttachments(dirHandle, storedSessions);
  } catch (error) {
    console.warn('Failed to clean up unreferenced attachments.', error);
  }

  return revision;
};

export const readSessions = async (
  dirHandle: FileSystemDirectoryHandle,
  options: { readOnly?: boolean } = {}
): Promise<Session[]> => {
  const storedSessions = await readJsonFile<Session[]>(dirHandle, STORAGE_FILES.SESSIONS) || [];
  if (options.readOnly) {
    return addRuntimeAttachmentPreviews(dirHandle, storedSessions);
  }

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

export const getWorkspaceBackup = async (
  dirHandle: FileSystemDirectoryHandle,
  options: { readOnly?: boolean } = {}
): Promise<WorkspaceBackup> => {
  const storedSessions = await readJsonFile<Session[]>(dirHandle, STORAGE_FILES.SESSIONS) || [];
  const externalized = options.readOnly
    ? { sessions: storedSessions, changed: false }
    : await externalizeSessionAttachments(dirHandle, storedSessions);
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
