import { FileAttachment, Session, SystemInstruction } from '../types';
import {
  getAttachmentMimeType,
  getDataUrlByteLength,
  validateAttachments
} from '../utils/attachmentValidation';
import {
  selectStorageBackend,
  StorageBackend,
  StorageBackendChoice,
  StorageBackendChoiceRequest,
  StorageBackendSnapshot
} from './storageBackend';
import { commitAtomicWorkspaceSnapshot } from './atomicWorkspaceSnapshot';
import {
  AppSettings,
  BackupSettings,
  MAX_WORKSPACE_BACKUP_BYTES,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceBackup,
  parseAppSettings,
  parseJsonText,
  parseJsonTextWithBackup,
  parseStoredSessions,
  parseSystemInstructions,
  parseWorkspaceBackup,
  validateWorkspaceReferences
} from './workspaceSchema';

export type {
  StorageBackend,
  StorageBackendChoice,
  StorageBackendChoiceRequest
} from './storageBackend';
export type {
  AppSettings,
  BackupSettings,
  WorkspaceBackup
} from './workspaceSchema';
export {
  MAX_WORKSPACE_BACKUP_BYTES,
  parseWorkspaceBackup,
  validateWorkspaceReferences
} from './workspaceSchema';

export const STORAGE_FILES = {
  SESSIONS: 'sessions.json',
  SETTINGS: 'settings.json',
  INSTRUCTIONS: 'system_instructions.json',
  MANIFEST: 'workspace_manifest.json',
  REVISION: 'workspace_revision.json'
} as const;

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

interface LegacyWorkspaceRevisionRecord {
  revision: number;
}

type WorkspaceDataKey = 'sessions' | 'settings' | 'instructions';
type WorkspaceDataFilename = (
  typeof STORAGE_FILES.SESSIONS |
  typeof STORAGE_FILES.SETTINGS |
  typeof STORAGE_FILES.INSTRUCTIONS
);

// The manifest is the single active-snapshot pointer. Workspaces created before
// schema version 1 continue through the canonical filenames and legacy revision.
interface WorkspaceManifest {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  revision: number;
  files: Record<WorkspaceDataKey, string>;
}

interface WorkspaceManifestState {
  active: WorkspaceManifest;
  backup: WorkspaceManifest | null;
}

const DEFAULT_WORKSPACE_FILES: Record<WorkspaceDataKey, WorkspaceDataFilename> = {
  sessions: STORAGE_FILES.SESSIONS,
  settings: STORAGE_FILES.SETTINGS,
  instructions: STORAGE_FILES.INSTRUCTIONS
};

const WORKSPACE_DATA_KEY_BY_FILENAME: Record<WorkspaceDataFilename, WorkspaceDataKey> = {
  [STORAGE_FILES.SESSIONS]: 'sessions',
  [STORAGE_FILES.SETTINGS]: 'settings',
  [STORAGE_FILES.INSTRUCTIONS]: 'instructions'
};

const SNAPSHOT_FILE_PREFIX = 'workspace_snapshot_';

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

const parseStoredJsonWithBackup = async <T>(
  filename: string,
  text: string,
  readBackupText: () => Promise<string | null>,
  parseValue: (value: unknown) => T
): Promise<T> => {
  return parseJsonTextWithBackup({
    filename,
    primaryText: text,
    readBackupText,
    parseValue,
    onFallback: backupFilename => {
      console.warn(`Failed to validate ${filename}; loaded ${backupFilename} instead.`);
    }
  });
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
  const manifestRecord = records.find(record => record.filename === STORAGE_FILES.MANIFEST);
  if (manifestRecord && typeof manifestRecord.data === 'string') {
    try {
      return parseWorkspaceManifestText(
        STORAGE_FILES.MANIFEST,
        manifestRecord.data
      ).revision;
    } catch {
      const backupManifest = records.find(
        record => record.filename === getBackupFilename(STORAGE_FILES.MANIFEST)
      );
      if (backupManifest && typeof backupManifest.data === 'string') {
        try {
          return parseWorkspaceManifestText(
            getBackupFilename(STORAGE_FILES.MANIFEST),
            backupManifest.data
          ).revision;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  const revisionRecord = records.find(record => record.filename === STORAGE_FILES.REVISION);
  if (!revisionRecord || typeof revisionRecord.data !== 'string') return null;

  try {
    return parseLegacyWorkspaceRevision(revisionRecord.data);
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
      // Track the attempted destination before creating it so rollback also
      // removes a partial file when the write itself fails.
      writtenRecords.push(record);

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

const getWorkspaceDataPhysicalFilename = (
  key: WorkspaceDataKey,
  id: string
): string => `${SNAPSHOT_FILE_PREFIX}${id}_${DEFAULT_WORKSPACE_FILES[key]}`;

const isWorkspaceDataPhysicalFilename = (
  key: WorkspaceDataKey,
  filename: unknown
): filename is string => {
  if (filename === DEFAULT_WORKSPACE_FILES[key]) return true;
  if (typeof filename !== 'string' || filename.length > 255) return false;
  const expectedSuffix = `_${DEFAULT_WORKSPACE_FILES[key]}`;
  const snapshotId = filename.startsWith(SNAPSHOT_FILE_PREFIX) &&
    filename.endsWith(expectedSuffix)
    ? filename.slice(SNAPSHOT_FILE_PREFIX.length, -expectedSuffix.length)
    : '';
  return /^[A-Za-z0-9_-]{1,128}$/.test(snapshotId);
};

function parseWorkspaceManifestText(
  filename: string,
  text: string
): WorkspaceManifest {
  return parseJsonText(filename, text, value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('workspace manifest must be an object.');
    }
    const manifest = value as Record<string, unknown>;
    const keys = Object.keys(manifest);
    if (
      keys.some(key => !['schemaVersion', 'revision', 'files'].includes(key))
    ) {
      throw new Error('workspace manifest contains unsupported fields.');
    }
    if (manifest.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error(
        `workspace manifest schemaVersion must be ${WORKSPACE_SCHEMA_VERSION}.`
      );
    }
    if (
      !Number.isSafeInteger(manifest.revision) ||
      (manifest.revision as number) < 0
    ) {
      throw new Error('workspace manifest revision is invalid.');
    }
    if (
      typeof manifest.files !== 'object' ||
      manifest.files === null ||
      Array.isArray(manifest.files)
    ) {
      throw new Error('workspace manifest files must be an object.');
    }

    const files = manifest.files as Record<string, unknown>;
    if (
      Object.keys(files).length !== 3 ||
      !isWorkspaceDataPhysicalFilename('sessions', files.sessions) ||
      !isWorkspaceDataPhysicalFilename('settings', files.settings) ||
      !isWorkspaceDataPhysicalFilename('instructions', files.instructions)
    ) {
      throw new Error('workspace manifest file references are invalid.');
    }

    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      revision: manifest.revision as number,
      files: {
        sessions: files.sessions,
        settings: files.settings,
        instructions: files.instructions
      }
    };
  });
}

function parseLegacyWorkspaceRevision(text: string | null): number {
  if (text === null) return 0;

  const value = parseStoredJson<LegacyWorkspaceRevisionRecord>(
    STORAGE_FILES.REVISION,
    text
  );
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error(`Stored file ${STORAGE_FILES.REVISION} has an invalid revision.`);
  }
  return value.revision;
}

const createLegacyWorkspaceManifest = (revision: number): WorkspaceManifest => ({
  schemaVersion: WORKSPACE_SCHEMA_VERSION,
  revision,
  files: { ...DEFAULT_WORKSPACE_FILES }
});

const readBackendTextFile = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: string
): Promise<string | null> => {
  const backend = await getStorageBackend();
  return backend === 'indexeddb'
    ? idbReadRawFile(filename)
    : readOpfsTextFile(dirHandle, filename);
};

const writeBackendTextFile = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
  text: string
): Promise<void> => {
  const backend = await getStorageBackend();
  if (backend === 'indexeddb') {
    await idbWriteRawFile(filename, text);
  } else {
    await writeOpfsTextFile(dirHandle, filename, text);
  }
};

const deleteBackendFile = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: string
): Promise<void> => {
  const backend = await getStorageBackend();
  if (backend === 'indexeddb') {
    await idbDeleteRawFile(filename);
    return;
  }

  try {
    await dirHandle.removeEntry(filename);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
};

const readOptionalWorkspaceManifest = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: string
): Promise<WorkspaceManifest | null> => {
  const text = await readBackendTextFile(dirHandle, filename);
  if (text === null) return null;
  return parseWorkspaceManifestText(filename, text);
};

const readWorkspaceManifestState = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<WorkspaceManifestState> => {
  const manifestText = await readBackendTextFile(dirHandle, STORAGE_FILES.MANIFEST);
  if (manifestText !== null) {
    try {
      const active = parseWorkspaceManifestText(STORAGE_FILES.MANIFEST, manifestText);
      let backup: WorkspaceManifest | null = null;
      try {
        backup = await readOptionalWorkspaceManifest(
          dirHandle,
          getBackupFilename(STORAGE_FILES.MANIFEST)
        );
      } catch (error) {
        console.warn('Ignored an invalid workspace manifest backup.', error);
      }
      return { active, backup };
    } catch (primaryError) {
      try {
        const backup = await readOptionalWorkspaceManifest(
          dirHandle,
          getBackupFilename(STORAGE_FILES.MANIFEST)
        );
        if (backup) {
          console.warn('Failed to validate the workspace manifest; loaded its backup.');
          return { active: backup, backup: null };
        }
      } catch (backupError) {
        console.warn('Failed to load the workspace manifest backup.', backupError);
      }
      throw primaryError;
    }
  }

  const legacyRevisionText = await readBackendTextFile(
    dirHandle,
    STORAGE_FILES.REVISION
  );
  return {
    active: createLegacyWorkspaceManifest(
      parseLegacyWorkspaceRevision(legacyRevisionText)
    ),
    backup: null
  };
};

const writePersistedWorkspaceManifest = async (
  dirHandle: FileSystemDirectoryHandle,
  manifest: WorkspaceManifest
): Promise<void> => {
  const nextText = JSON.stringify(manifest, null, 2);
  const previousText = await readBackendTextFile(dirHandle, STORAGE_FILES.MANIFEST);

  if (previousText && previousText !== nextText) {
    try {
      parseWorkspaceManifestText(STORAGE_FILES.MANIFEST, previousText);
      await writeBackendTextFile(
        dirHandle,
        getBackupFilename(STORAGE_FILES.MANIFEST),
        previousText
      );
    } catch (error) {
      console.warn('Did not preserve an invalid workspace manifest as backup.', error);
    }
  } else if (previousText === null) {
    const legacyRevisionText = await readBackendTextFile(
      dirHandle,
      STORAGE_FILES.REVISION
    );
    const legacyManifest = createLegacyWorkspaceManifest(
      parseLegacyWorkspaceRevision(legacyRevisionText)
    );
    await writeBackendTextFile(
      dirHandle,
      getBackupFilename(STORAGE_FILES.MANIFEST),
      JSON.stringify(legacyManifest, null, 2)
    );
  }

  await writeBackendTextFile(dirHandle, STORAGE_FILES.MANIFEST, nextText);
};

const readPersistedWorkspaceRevision = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<number> => (
  (await readWorkspaceManifestState(dirHandle)).active.revision
);

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

const deleteAttachmentBlob = async (
  dirHandle: FileSystemDirectoryHandle,
  id: string
): Promise<void> => {
  if (!isValidAttachmentId(id)) return;

  const backend = await getStorageBackend();
  if (backend === 'indexeddb') {
    await idbDeleteRawFile(getAttachmentStorageKey(id));
    return;
  }

  const attachmentsDir = await getOpfsAttachmentsDirectory(dirHandle, false);
  if (!attachmentsDir) return;
  try {
    await attachmentsDir.removeEntry(id);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
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
type WorkspaceDataValue = Session[] | AppSettings | SystemInstruction[];

const getWorkspaceDataParser = (
  filename: WorkspaceDataFilename
): ((value: unknown) => WorkspaceDataValue) => {
  if (filename === STORAGE_FILES.SESSIONS) return parseStoredSessions;
  if (filename === STORAGE_FILES.SETTINGS) {
    return value => parseAppSettings(value) as AppSettings;
  }
  return parseSystemInstructions;
};

const getWorkspaceDataKey = (filename: string): WorkspaceDataKey => {
  if (filename in WORKSPACE_DATA_KEY_BY_FILENAME) {
    return WORKSPACE_DATA_KEY_BY_FILENAME[filename as WorkspaceDataFilename];
  }
  throw new Error(`Unsupported workspace data file: ${filename}`);
};

export const writeJsonFile = async (
  dirHandle: FileSystemDirectoryHandle,
  filename: WorkspaceDataFilename,
  data: unknown
): Promise<number> => {
  if (workspaceRevision === null) {
    throw new Error('Workspace revision has not been initialized.');
  }

  const key = getWorkspaceDataKey(filename);
  const parseValue = getWorkspaceDataParser(filename);
  parseValue(data);

  const manifestState = await readWorkspaceManifestState(dirHandle);
  if (manifestState.active.revision !== workspaceRevision) {
    throw new WorkspaceRevisionConflictError(
      workspaceRevision,
      manifestState.active.revision
    );
  }

  const physicalFilename = manifestState.active.files[key];
  const nextText = JSON.stringify(data, null, 2);

  try {
    const previousText = await readBackendTextFile(dirHandle, physicalFilename);
    if (previousText && previousText !== nextText) {
      try {
        parseJsonText(physicalFilename, previousText, parseValue);
        await writeBackendTextFile(
          dirHandle,
          getBackupFilename(physicalFilename),
          previousText
        );
      } catch (error) {
        console.warn(
          `Did not preserve invalid ${physicalFilename} as a backup.`,
          error
        );
      }
    }

    await writeBackendTextFile(dirHandle, physicalFilename, nextText);
  } catch (error) {
    console.error(`Failed to write ${filename}`, error);
    throw error;
  }

  const nextRevision = manifestState.active.revision + 1;
  await writePersistedWorkspaceManifest(dirHandle, {
    ...manifestState.active,
    revision: nextRevision
  });
  workspaceRevision = nextRevision;
  return nextRevision;
};

const readWorkspaceDataFile = async <T>(
  dirHandle: FileSystemDirectoryHandle,
  logicalFilename: WorkspaceDataFilename,
  physicalFilename: string,
  parseValue: (value: unknown) => T
): Promise<T | null> => {
  const text = await readBackendTextFile(dirHandle, physicalFilename);
  if (text === null) {
    if (physicalFilename !== logicalFilename) {
      throw new Error(`Workspace snapshot file ${physicalFilename} is missing.`);
    }
    return null;
  }

  return parseStoredJsonWithBackup<T>(
    physicalFilename,
    text,
    () => readBackendTextFile(dirHandle, getBackupFilename(physicalFilename)),
    parseValue
  );
};

export function readJsonFile(
  dirHandle: FileSystemDirectoryHandle,
  filename: typeof STORAGE_FILES.SESSIONS
): Promise<Session[] | null>;
export function readJsonFile(
  dirHandle: FileSystemDirectoryHandle,
  filename: typeof STORAGE_FILES.SETTINGS
): Promise<AppSettings | null>;
export function readJsonFile(
  dirHandle: FileSystemDirectoryHandle,
  filename: typeof STORAGE_FILES.INSTRUCTIONS
): Promise<SystemInstruction[] | null>;
export async function readJsonFile(
  dirHandle: FileSystemDirectoryHandle,
  filename: WorkspaceDataFilename
): Promise<Session[] | AppSettings | SystemInstruction[] | null> {
  const key = getWorkspaceDataKey(filename);
  const parseValue = getWorkspaceDataParser(filename);
  const manifestState = await readWorkspaceManifestState(dirHandle);

  try {
    return await readWorkspaceDataFile(
      dirHandle,
      filename,
      manifestState.active.files[key],
      parseValue
    );
  } catch (primaryError) {
    const fallbackFilename = manifestState.backup?.files[key];
    if (
      fallbackFilename &&
      fallbackFilename !== manifestState.active.files[key]
    ) {
      try {
        const fallback = await readWorkspaceDataFile(
          dirHandle,
          filename,
          fallbackFilename,
          parseValue
        );
        console.warn(
          `Failed to load ${manifestState.active.files[key]}; `
          + `loaded snapshot backup ${fallbackFilename} instead.`
        );
        return fallback;
      } catch (backupError) {
        console.warn(`Failed to load snapshot backup ${fallbackFilename}.`, backupError);
      }
    }
    throw primaryError;
  }
}

const settledMap = async <T, R>(
  values: T[],
  mapValue: (value: T) => Promise<R>
): Promise<R[]> => {
  const results = await Promise.allSettled(values.map(mapValue));
  const rejection = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (rejection) throw rejection.reason;
  return results.map(result => (result as PromiseFulfilledResult<R>).value);
};

const mapSessionAttachments = async (
  sessions: Session[],
  mapAttachment: (attachment: FileAttachment) => Promise<FileAttachment>
): Promise<Session[]> => settledMap(sessions, async session => ({
  ...session,
  messages: await settledMap(session.messages, async message => (
    message.attachments
      ? {
          ...message,
          attachments: await settledMap(message.attachments, mapAttachment)
        }
      : message
  ))
}));

const toStoredSessions = (sessions: Session[]): Session[] => sessions.map(session => ({
  ...session,
  messages: session.messages.map(message => (
    message.attachments
      ? {
          ...message,
          attachments: message.attachments.map(attachment => {
            const storedAttachment: FileAttachment = {
              name: attachment.name,
              type: attachment.type,
              ...(attachment.size !== undefined ? { size: attachment.size } : {})
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
  regenerateIds = false,
  strict = false,
  onAttachmentStaged?: (id: string) => void
): Promise<{
  sessions: Session[];
  changed: boolean;
  writtenAttachmentIds: string[];
}> => {
  let changed = false;
  const writtenAttachmentIds: string[] = [];

  const externalizedSessions = await mapSessionAttachments(sessions, async attachment => {
    const existingId = isValidAttachmentId(attachment.id) ? attachment.id : undefined;
    const name = typeof attachment.name === 'string' ? attachment.name : 'Attachment';
    const type = typeof attachment.type === 'string' ? attachment.type : 'application/octet-stream';
    const size = Number.isSafeInteger(attachment.size) && (attachment.size as number) >= 0
      ? attachment.size
      : undefined;

    if (!attachment.content) {
      const normalizedAttachment: FileAttachment = {
        name,
        type,
        ...(size !== undefined ? { size } : {}),
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
      const mimeType = getAttachmentMimeType({
        name,
        type: type || blob.type
      });
      validateAttachments([{
        name,
        type: mimeType,
        size: blob.size
      }]);
      writtenAttachmentIds.push(id);
      onAttachmentStaged?.(id);
      await writeAttachmentBlob(dirHandle, id, blob);
      changed = true;
      return {
        id,
        name,
        type: mimeType,
        size: blob.size
      };
    } catch (error) {
      if (strict) {
        throw new Error(
          `Attachment "${name}" could not be staged: ${getErrorMessage(error)}`
        );
      }
      console.warn(`Failed to externalize attachment ${name}`, error);
      changed = true;
      return {
        name,
        type,
        ...(size !== undefined ? { size } : {}),
        ...(typeof attachment.content === 'string' && attachment.content.startsWith('data:')
          ? { content: attachment.content }
          : {})
      };
    }
  });

  return {
    sessions: externalizedSessions,
    changed,
    writtenAttachmentIds
  };
};

const addRuntimeAttachmentMetadata = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[]
): Promise<Session[]> => mapSessionAttachments(sessions, async attachment => {
  if (!isValidAttachmentId(attachment.id)) {
    if (!attachment.content) return attachment;

    try {
      return {
        ...attachment,
        size: getDataUrlByteLength(attachment.content)
      };
    } catch {
      return attachment;
    }
  }

  try {
    const blob = await readAttachmentBlob(dirHandle, attachment.id);
    if (!blob) {
      console.warn(`Stored attachment ${attachment.id} (${attachment.name}) is missing.`);
      return attachment;
    }

    return {
      ...attachment,
      size: blob.size,
      ...(attachment.type.startsWith('image/')
        ? { previewUrl: URL.createObjectURL(applyAttachmentMimeType(blob, attachment.type)) }
        : {})
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

const pruneUnreferencedAttachments = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[],
  force = false
): Promise<void> => {
  const now = Date.now();
  if (!force && now - lastAttachmentGcAt < ATTACHMENT_GC_INTERVAL_MS) return;
  lastAttachmentGcAt = now;

  const referencedIds = collectAttachmentIds(sessions);
  const manifestState = await readWorkspaceManifestState(dirHandle);
  const recoverySessionFiles = new Set<string>([
    getBackupFilename(manifestState.active.files.sessions)
  ]);
  if (manifestState.backup) {
    recoverySessionFiles.add(manifestState.backup.files.sessions);
    recoverySessionFiles.add(
      getBackupFilename(manifestState.backup.files.sessions)
    );
  }

  for (const filename of recoverySessionFiles) {
    const recoveryText = await readBackendTextFile(dirHandle, filename);
    if (!recoveryText) continue;
    try {
      const recoverySessions = parseJsonText(
        filename,
        recoveryText,
        parseStoredSessions
      );
      collectAttachmentIds(recoverySessions).forEach(id => referencedIds.add(id));
    } catch (error) {
      console.warn(
        `Skipped attachment cleanup because recovery file ${filename} is invalid.`,
        error
      );
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
  validateAttachments([file]);
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

  validateAttachments([{
    name: attachment.name,
    type: attachment.type,
    size: blob.size
  }]);
  const mimeType = getAttachmentMimeType(attachment);
  return blobToDataUrl(applyAttachmentMimeType(blob, mimeType));
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
  const storedSessions = await readJsonFile(dirHandle, STORAGE_FILES.SESSIONS) || [];
  if (options.readOnly) {
    return addRuntimeAttachmentMetadata(dirHandle, storedSessions);
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

  return addRuntimeAttachmentMetadata(dirHandle, externalized.sessions);
};

const embedAttachmentDataForBackup = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[]
): Promise<Session[]> => mapSessionAttachments(sessions, async attachment => {
  const content = await getAttachmentDataUrl(dirHandle, attachment);

  return {
    ...(isValidAttachmentId(attachment.id) ? { id: attachment.id } : {}),
    name: attachment.name,
    type: attachment.type,
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(content ? { content } : {})
  };
});

export const getWorkspaceBackup = async (
  dirHandle: FileSystemDirectoryHandle,
  options: { readOnly?: boolean } = {}
): Promise<WorkspaceBackup> => {
  const storedSessions = await readJsonFile(dirHandle, STORAGE_FILES.SESSIONS) || [];
  const externalized = options.readOnly
    ? { sessions: storedSessions, changed: false }
    : await externalizeSessionAttachments(dirHandle, storedSessions);
  if (externalized.changed) await writeSessions(dirHandle, externalized.sessions);

  const embeddedSessions = await embedAttachmentDataForBackup(
    dirHandle,
    externalized.sessions
  );
  const settings = await readJsonFile(dirHandle, STORAGE_FILES.SETTINGS);
  const instructions = await readJsonFile(dirHandle, STORAGE_FILES.INSTRUCTIONS) || [];
  const instructionIds = new Set(instructions.map(instruction => instruction.id));
  const sessions = embeddedSessions.map(session => (
    session.config.systemInstructionId &&
    !instructionIds.has(session.config.systemInstructionId)
      ? {
          ...session,
          config: {
            ...session.config,
            systemInstructionId: undefined
          }
        }
      : session
  ));

  let backupSettings: BackupSettings | null = null;
  if (settings) {
    backupSettings = { ...settings };
    delete backupSettings.apiKey;
    if (
      backupSettings.lastActiveSessionId &&
      !sessions.some(session => session.id === backupSettings?.lastActiveSessionId)
    ) {
      backupSettings.lastActiveSessionId = sessions[0]?.id;
    }
  }

  return parseWorkspaceBackup({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    sessions,
    settings: backupSettings,
    instructions,
    timestamp: Date.now()
  });
};

export const restoreWorkspaceBackup = async (
  dirHandle: FileSystemDirectoryHandle,
  backupValue: unknown
): Promise<void> => {
  if (workspaceRevision === null) {
    throw new Error('Workspace revision has not been initialized.');
  }

  const backup = parseWorkspaceBackup(backupValue);
  const manifestState = await readWorkspaceManifestState(dirHandle);
  if (manifestState.active.revision !== workspaceRevision) {
    throw new WorkspaceRevisionConflictError(
      workspaceRevision,
      manifestState.active.revision
    );
  }

  const currentSettings = await readJsonFile(dirHandle, STORAGE_FILES.SETTINGS);
  const currentInstructions = backup.instructions === undefined
    ? await readJsonFile(dirHandle, STORAGE_FILES.INSTRUCTIONS) || []
    : backup.instructions;
  const restoredSettings: AppSettings = backup.settings
    ? {
        theme: backup.settings.theme,
        apiKey: currentSettings?.apiKey || '',
        ...(backup.settings.lastActiveSessionId
          ? { lastActiveSessionId: backup.settings.lastActiveSessionId }
          : {})
      }
    : {
        theme: currentSettings?.theme || 'dark',
        apiKey: currentSettings?.apiKey || '',
        ...(currentSettings?.lastActiveSessionId &&
          backup.sessions.some(session => (
            session.id === currentSettings.lastActiveSessionId
          ))
          ? { lastActiveSessionId: currentSettings.lastActiveSessionId }
          : backup.sessions[0]
            ? { lastActiveSessionId: backup.sessions[0].id }
            : {})
      };

  validateWorkspaceReferences({
    sessions: backup.sessions,
    settings: restoredSettings,
    instructions: currentInstructions
  });

  const snapshotId = createAttachmentId();
  const stagedFiles: Record<WorkspaceDataKey, string> = {
    sessions: getWorkspaceDataPhysicalFilename('sessions', snapshotId),
    settings: getWorkspaceDataPhysicalFilename('settings', snapshotId),
    instructions: getWorkspaceDataPhysicalFilename('instructions', snapshotId)
  };
  let writtenAttachmentIds: string[] = [];
  let switched = false;
  let manifestSwitchStarted = false;

  try {
    const externalized = await externalizeSessionAttachments(
      dirHandle,
      backup.sessions,
      true,
      true,
      id => writtenAttachmentIds.push(id)
    );
    const storedSessions = toStoredSessions(externalized.sessions);

    parseStoredSessions(storedSessions);
    parseAppSettings(restoredSettings);
    parseSystemInstructions(currentInstructions);
    validateWorkspaceReferences({
      sessions: storedSessions,
      settings: restoredSettings,
      instructions: currentInstructions
    });

    const stagedTexts: Record<WorkspaceDataKey, string> = {
      sessions: JSON.stringify(storedSessions, null, 2),
      settings: JSON.stringify(restoredSettings, null, 2),
      instructions: JSON.stringify(currentInstructions, null, 2)
    };

    const nextManifest: WorkspaceManifest = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      revision: manifestState.active.revision + 1,
      files: stagedFiles
    };
    // The helper verifies every staged file before the manifest makes any of
    // them visible as the active workspace.
    await commitAtomicWorkspaceSnapshot({
      files: [
        {
          filename: stagedFiles.sessions,
          text: stagedTexts.sessions,
          validate: text => {
            parseJsonText(stagedFiles.sessions, text, parseStoredSessions);
          }
        },
        {
          filename: stagedFiles.settings,
          text: stagedTexts.settings,
          validate: text => {
            parseJsonText(
              stagedFiles.settings,
              text,
              value => parseAppSettings(value) as AppSettings
            );
          }
        },
        {
          filename: stagedFiles.instructions,
          text: stagedTexts.instructions,
          validate: text => {
            parseJsonText(
              stagedFiles.instructions,
              text,
              parseSystemInstructions
            );
          }
        }
      ],
      writeText: (filename, text) => (
        writeBackendTextFile(dirHandle, filename, text)
      ),
      readText: filename => readBackendTextFile(dirHandle, filename),
      deleteFile: filename => deleteBackendFile(dirHandle, filename),
      beforeSwitch: async () => {
        const currentManifest = (
          await readWorkspaceManifestState(dirHandle)
        ).active;
        if (currentManifest.revision !== manifestState.active.revision) {
          throw new WorkspaceRevisionConflictError(
            manifestState.active.revision,
            currentManifest.revision
          );
        }
      },
      switchManifest: async () => {
        manifestSwitchStarted = true;
        await writePersistedWorkspaceManifest(dirHandle, nextManifest);
      }
    });
    switched = true;
    workspaceRevision = nextManifest.revision;
  } finally {
    if (!switched && !manifestSwitchStarted) {
      await Promise.all(writtenAttachmentIds.map(async id => {
        try {
          await deleteAttachmentBlob(dirHandle, id);
        } catch (error) {
          console.warn(`Failed to remove staged attachment ${id}.`, error);
        }
      }));
    }
  }
};
