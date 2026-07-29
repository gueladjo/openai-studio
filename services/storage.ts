import {
  FileAttachment,
  LocalBlobReference,
  Session,
  SystemInstruction
} from '../types';
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
import {
  AppSettings,
  BackupSettings,
  MAX_WORKSPACE_BACKUP_BYTES,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceBackup,
  parseAppSettings,
  parseJsonText,
  parseStoredSessions,
  parseSystemInstructions,
  parseWorkspaceBackup,
  validateWorkspaceReferences
} from './workspaceSchema';
import {
  ValidWorkspaceGeneration,
  WorkspaceGenerationData,
  WorkspaceGenerationStore
} from './workspaceGenerationStore';
import {
  WORKSPACE_MANIFEST_SLOTS
} from './workspaceGeneration';

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
let workspaceGenerationCache: ValidWorkspaceGeneration | null = null;

const IDB_NAME = 'openai-studio-storage';
const IDB_STORE = 'files';
const IDB_VERSION = 1;
const BACKEND_IDENTITY_KEY = 'openai-studio-storage-backend-v1';
const BACKEND_IDENTITY_VERSION = 1;
const BACKUP_SUFFIX = '.bak';
const ATTACHMENTS_DIRECTORY = 'attachments';
const ATTACHMENT_KEY_PREFIX = `${ATTACHMENTS_DIRECTORY}/`;

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
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    if (typeof writable.abort === 'function') {
      try {
        await writable.abort();
      } catch {
        // Preserve the write failure.
      }
    }
    throw error;
  }
};

const splitStoragePath = (path: string): string[] => {
  const segments = path.split('/');
  if (
    segments.length === 0 ||
    segments.some(segment => (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\\')
    ))
  ) {
    throw new Error(`Storage path ${path} is invalid.`);
  }
  return segments;
};

const resolveOpfsParent = async (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Promise<{ directory: FileSystemDirectoryHandle; filename: string } | null> => {
  const segments = splitStoragePath(path);
  const filename = segments.pop()!;
  let directory = root;

  try {
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
  } catch (error) {
    if (!create && isNotFoundError(error)) return null;
    throw error;
  }
  return { directory, filename };
};

const readOpfsBlobPath = async (
  root: FileSystemDirectoryHandle,
  path: string
): Promise<Blob | null> => {
  const parent = await resolveOpfsParent(root, path, false);
  if (!parent) return null;
  try {
    const handle = await parent.directory.getFileHandle(parent.filename);
    return await handle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
};

const writeOpfsBlobPath = async (
  root: FileSystemDirectoryHandle,
  path: string,
  data: Blob | string
): Promise<void> => {
  const parent = await resolveOpfsParent(root, path, true);
  if (!parent) throw new Error(`Storage path ${path} could not be created.`);
  const handle = await parent.directory.getFileHandle(parent.filename, { create: true });
  const writable = await (handle as any).createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    if (typeof writable.abort === 'function') {
      try {
        await writable.abort();
      } catch {
        // Preserve the write failure.
      }
    }
    throw error;
  }
};

const deleteOpfsPath = async (
  root: FileSystemDirectoryHandle,
  path: string
): Promise<void> => {
  const parent = await resolveOpfsParent(root, path, false);
  if (!parent) return;
  try {
    await parent.directory.removeEntry(parent.filename);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
};

const listOpfsPaths = async (
  root: FileSystemDirectoryHandle,
  prefix: string
): Promise<string[]> => {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const segments = splitStoragePath(normalizedPrefix.slice(0, -1));
  let directory = root;
  try {
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment);
    }
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  const paths: string[] = [];
  for await (const [name, entry] of (directory as any).entries()) {
    if (entry.kind === 'file') paths.push(`${normalizedPrefix}${name}`);
  }
  return paths.sort();
};

const createWorkspaceGenerationStore = (
  dirHandle: FileSystemDirectoryHandle
): WorkspaceGenerationStore => new WorkspaceGenerationStore({
  readText: async path => {
    const backend = await getStorageBackend();
    if (backend === 'indexeddb') return idbReadRawFile(path);
    const blob = await readOpfsBlobPath(dirHandle, path);
    return blob ? blob.text() : null;
  },
  writeText: async (path, text) => {
    const backend = await getStorageBackend();
    if (backend === 'indexeddb') {
      await idbWriteRawFile(path, text);
    } else {
      await writeOpfsBlobPath(dirHandle, path, text);
    }
  },
  readBlob: async path => {
    const backend = await getStorageBackend();
    if (backend === 'indexeddb') {
      const record = await idbReadRawData(path);
      return record?.data instanceof Blob ? record.data : null;
    }
    return readOpfsBlobPath(dirHandle, path);
  },
  writeBlob: async (path, blob) => {
    const backend = await getStorageBackend();
    if (backend === 'indexeddb') {
      await idbWriteRawData(path, blob);
    } else {
      await writeOpfsBlobPath(dirHandle, path, blob);
    }
  },
  delete: async path => {
    const backend = await getStorageBackend();
    if (backend === 'indexeddb') {
      await idbDeleteRawFile(path);
    } else {
      await deleteOpfsPath(dirHandle, path);
    }
  },
  list: async prefix => {
    const backend = await getStorageBackend();
    if (backend === 'indexeddb') {
      return (await idbListRawFiles(prefix)).map(record => record.filename);
    }
    return listOpfsPaths(dirHandle, prefix);
  }
});

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
  const generationRevisions = WORKSPACE_MANIFEST_SLOTS.flatMap(slot => {
    const record = records.find(candidate => candidate.filename === slot);
    if (!record || typeof record.data !== 'string') return [];
    try {
      const value = JSON.parse(record.data) as {
        schemaVersion?: unknown;
        revision?: unknown;
      };
      return value.schemaVersion === 2 &&
        Number.isSafeInteger(value.revision) &&
        (value.revision as number) >= 0
        ? [value.revision as number]
        : [];
    } catch {
      return [];
    }
  });
  if (generationRevisions.length > 0) {
    return Math.max(...generationRevisions);
  }

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

    if (
      entry.kind !== 'directory' ||
      ![ATTACHMENTS_DIRECTORY, 'objects', 'blobs', 'recovery'].includes(name)
    ) {
      extraDescriptors.push(`${entry.kind}:${name}`);
      continue;
    }

    for await (const [childName, childEntry] of entry.entries()) {
      if (childEntry.kind !== 'file') {
        extraDescriptors.push(
          `${name}/${childEntry.kind}:${childName}`
        );
        continue;
      }

      records.push({
        filename: `${name}/${childName}`,
        data: name === 'objects'
          ? await (await childEntry.getFile()).text()
          : await childEntry.getFile()
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
  for (const record of [...writtenRecords].reverse()) {
    await deleteOpfsPath(dataDir, record.filename);
  }
  for (const directory of [ATTACHMENTS_DIRECTORY, 'objects', 'blobs', 'recovery']) {
    try {
      await dataDir.removeEntry(directory);
    } catch (error) {
      if (!isNotFoundError(error)) {
        console.warn(`Failed to remove empty migration directory ${directory}.`, error);
      }
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

      if (record.filename.includes('/')) {
        const [directory, child, ...extra] = record.filename.split('/');
        const isAllowedDirectory = [
          ATTACHMENTS_DIRECTORY,
          'objects',
          'blobs',
          'recovery'
        ].includes(directory);
        const expectsText = directory === 'objects';
        if (
          !isAllowedDirectory ||
          !child ||
          extra.length > 0 ||
          (expectsText
            ? typeof record.data !== 'string'
            : !(record.data instanceof Blob))
        ) {
          throw new Error(`IndexedDB nested record ${record.filename} is invalid.`);
        }
        await writeOpfsBlobPath(dataDir, record.filename, record.data);
      } else {
        if (
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
  workspaceGenerationCache = null;

  if (selectedBackend === 'opfs') {
    const root = opfs.opfsRoot || await navigator.storage.getDirectory();
    opfsDataDir = opfsDataDir || opfs.opfsDataDir ||
      await root.getDirectoryHandle('data', { create: true });
  }

  console.log(`Using ${selectedBackend === 'opfs' ? 'OPFS' : 'IndexedDB'} storage backend`);
  return selectedBackend;
}

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

const readPersistedWorkspaceRevision = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<number> => {
  const generation = await ensureWorkspaceGeneration(dirHandle, true);
  return generation.manifest.revision;
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

const getAttachmentStorageKey = (id: string): string => `${ATTACHMENT_KEY_PREFIX}${id}`;

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

const readLegacyWorkspaceData = async (
  dirHandle: FileSystemDirectoryHandle,
  migrateSessions: (sessions: Session[]) => Promise<Session[]>
): Promise<{ revision: number; data: WorkspaceGenerationData }> => {
  const state = await readWorkspaceManifestState(dirHandle);
  const candidates = [
    state.active,
    ...(state.backup ? [state.backup] : [])
  ];
  let firstError: unknown = null;

  for (const manifest of candidates) {
    try {
      const sessionText = await readBackendTextFile(
        dirHandle,
        manifest.files.sessions
      );
      const settingsText = await readBackendTextFile(
        dirHandle,
        manifest.files.settings
      );
      const instructionsText = await readBackendTextFile(
        dirHandle,
        manifest.files.instructions
      );
      const parsedSessions = sessionText === null
        ? []
        : parseJsonText(manifest.files.sessions, sessionText, parseStoredSessions);
      const settings = settingsText === null
        ? { theme: 'dark' as const, apiKey: '' }
        : parseJsonText(
            manifest.files.settings,
            settingsText,
            value => parseAppSettings(value) as AppSettings
          );
      const instructions = instructionsText === null
        ? []
        : parseJsonText(
            manifest.files.instructions,
            instructionsText,
            parseSystemInstructions
          );
      validateWorkspaceReferences(
        { sessions: parsedSessions, settings, instructions },
        { allowDanglingSelections: true }
      );
      const sessions = await migrateSessions(parsedSessions);
      validateWorkspaceReferences(
        { sessions, settings, instructions },
        { allowDanglingSelections: true }
      );
      return {
        revision: manifest.revision,
        data: { sessions, settings, instructions }
      };
    } catch (error) {
      firstError ||= error;
    }
  }

  const backupFiles = {
    sessions: getBackupFilename(state.active.files.sessions),
    settings: getBackupFilename(state.active.files.settings),
    instructions: getBackupFilename(state.active.files.instructions)
  };
  try {
    const [sessionText, settingsText, instructionsText] = await Promise.all([
      readBackendTextFile(dirHandle, backupFiles.sessions),
      readBackendTextFile(dirHandle, backupFiles.settings),
      readBackendTextFile(dirHandle, backupFiles.instructions)
    ]);
    if (sessionText === null || settingsText === null || instructionsText === null) {
      throw firstError || new Error('The legacy workspace is incomplete.');
    }
    const parsedSessions = parseJsonText(
      backupFiles.sessions,
      sessionText,
      parseStoredSessions
    );
    const settings = parseJsonText(
      backupFiles.settings,
      settingsText,
      value => parseAppSettings(value) as AppSettings
    );
    const instructions = parseJsonText(
      backupFiles.instructions,
      instructionsText,
      parseSystemInstructions
    );
    validateWorkspaceReferences(
      { sessions: parsedSessions, settings, instructions },
      { allowDanglingSelections: true }
    );
    const sessions = await migrateSessions(parsedSessions);
    validateWorkspaceReferences(
      { sessions, settings, instructions },
      { allowDanglingSelections: true }
    );
    return {
      revision: Math.max(0, state.active.revision - 1),
      data: { sessions, settings, instructions }
    };
  } catch {
    throw firstError || new Error('The legacy workspace could not be validated.');
  }
};

const migrateSessionsToContentBlobs = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[],
  recoverMissingLegacyAttachments = false
): Promise<Session[]> => {
  const store = createWorkspaceGenerationStore(dirHandle);

  return mapSessionAttachments(sessions, async attachment => {
    const name = typeof attachment.name === 'string' ? attachment.name : 'Attachment';
    const type = typeof attachment.type === 'string'
      ? attachment.type
      : 'application/octet-stream';
    const metadataOnlyAttachment: FileAttachment = {
      name,
      type,
      ...(attachment.size !== undefined ? { size: attachment.size } : {})
    };
    const hasStorageLocator = Boolean(
      attachment.localBlob ||
      attachment.content ||
      isValidAttachmentId(attachment.id)
    );
    if (!hasStorageLocator) return metadataOnlyAttachment;

    let blob: Blob | null = null;

    if (attachment.localBlob) {
      blob = await store.readBlob(attachment.localBlob);
    } else if (attachment.content) {
      blob = await dataUrlToBlob(attachment.content);
    } else if (
      typeof attachment.id === 'string' &&
      /^[a-f0-9]{64}$/.test(attachment.id) &&
      Number.isSafeInteger(attachment.size) &&
      (attachment.size as number) >= 0
    ) {
      blob = await store.readBlob({
        sha256: attachment.id,
        byteSize: attachment.size as number,
        ...(type ? { mimeType: type } : {})
      });
      if (!blob) {
        blob = await readAttachmentBlob(dirHandle, attachment.id);
      }
    } else if (isValidAttachmentId(attachment.id)) {
      blob = await readAttachmentBlob(dirHandle, attachment.id);
    }
    if (!blob) {
      if (
        recoverMissingLegacyAttachments &&
        !attachment.localBlob &&
        !attachment.content &&
        isValidAttachmentId(attachment.id)
      ) {
        console.warn(
          `Legacy attachment ${attachment.id} (${name}) is missing; preserved its metadata without the unusable local ID.`
        );
        return metadataOnlyAttachment;
      }
      throw new Error(`Attachment "${name}" is missing from local storage.`);
    }
    validateAttachments([{
      name,
      type: type || blob.type,
      size: blob.size
    }]);
    const localBlob = await store.storeBlob(blob, type || blob.type);
    return {
      name,
      type: type || blob.type || 'application/octet-stream',
      size: blob.size,
      localBlob
    };
  });
};

const normalizeWorkspaceGenerationReferences = (
  data: WorkspaceGenerationData
): WorkspaceGenerationData => {
  const sessionIds = new Set(data.sessions.map(session => session.id));
  const settings = (
    data.settings.lastActiveSessionId &&
    !sessionIds.has(data.settings.lastActiveSessionId)
  )
    ? {
        ...data.settings,
        lastActiveSessionId: data.sessions[0]?.id
      }
    : data.settings;
  const instructionIds = new Set(data.instructions.map(item => item.id));
  const sessions = data.sessions.map(session => (
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

  return settings === data.settings &&
    sessions.every((session, index) => session === data.sessions[index])
    ? data
    : { ...data, sessions, settings };
};

const ensureWorkspaceGeneration = async (
  dirHandle: FileSystemDirectoryHandle,
  refresh = false
): Promise<ValidWorkspaceGeneration> => {
  if (!refresh && workspaceGenerationCache) return workspaceGenerationCache;
  if (refresh) workspaceGenerationCache = null;
  const store = createWorkspaceGenerationStore(dirHandle);
  const current = await store.readCurrent();
  if (current) {
    workspaceGenerationCache = current;
    return current;
  }
  if (await store.hasManifestRecords()) {
    throw new Error(
      'No complete local workspace generation could be validated. The active workspace was not changed.'
    );
  }

  let legacy: { revision: number; data: WorkspaceGenerationData };
  try {
    legacy = await readLegacyWorkspaceData(
      dirHandle,
      sessions => migrateSessionsToContentBlobs(dirHandle, sessions)
    );
  } catch (error) {
    console.warn(
      'No complete legacy workspace generation was found; retrying with missing legacy attachment recovery.',
      error
    );
    legacy = await readLegacyWorkspaceData(
      dirHandle,
      sessions => migrateSessionsToContentBlobs(dirHandle, sessions, true)
    );
  }
  const migrated = await store.commit(
    null,
    normalizeWorkspaceGenerationReferences(legacy.data),
    {
      revision: legacy.revision,
      createdAt: Date.now()
    }
  );
  const verified = await store.readCurrent();
  if (!verified || verified.manifest.revision !== migrated.manifest.revision) {
    throw new Error(
      'The migrated workspace generation could not be read back. Legacy data was retained.'
    );
  }
  workspaceGenerationCache = verified;
  return verified;
};

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
  const parsedData = parseValue(data);
  const current = await ensureWorkspaceGeneration(dirHandle, true);
  if (current.manifest.revision !== workspaceRevision) {
    throw new WorkspaceRevisionConflictError(
      workspaceRevision,
      current.manifest.revision
    );
  }

  const nextData = normalizeWorkspaceGenerationReferences({
    sessions: key === 'sessions'
      ? await migrateSessionsToContentBlobs(
          dirHandle,
          parsedData as Session[]
        )
      : current.sessions,
    settings: key === 'settings'
      ? parsedData as AppSettings
      : current.settings,
    instructions: key === 'instructions'
      ? parsedData as SystemInstruction[]
      : current.instructions
  });

  const committed = await createWorkspaceGenerationStore(dirHandle).commit(
    workspaceRevision,
    nextData
  );
  workspaceGenerationCache = committed;
  workspaceRevision = committed.manifest.revision;
  return committed.manifest.revision;
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
  const generation = await ensureWorkspaceGeneration(dirHandle);
  if (key === 'sessions') return generation.sessions;
  if (key === 'settings') return generation.settings;
  return generation.instructions;
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

            if (attachment.localBlob) {
              storedAttachment.localBlob = attachment.localBlob;
            } else if (isValidAttachmentId(attachment.id)) {
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

const addRuntimeAttachmentMetadata = async (
  dirHandle: FileSystemDirectoryHandle,
  sessions: Session[]
): Promise<Session[]> => mapSessionAttachments(sessions, async attachment => {
  if (attachment.localBlob) {
    try {
      const blob = await createWorkspaceGenerationStore(dirHandle).readBlob(
        attachment.localBlob
      );
      if (!blob) {
        console.warn(
          `Stored attachment ${attachment.localBlob.sha256} (${attachment.name}) is missing.`
        );
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
      console.warn(`Failed to load attachment preview ${attachment.name}.`, error);
      return attachment;
    }
  }

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

export const storeAttachment = async (
  dirHandle: FileSystemDirectoryHandle,
  file: File
): Promise<string> => {
  return (await storeAttachmentBlob(dirHandle, file)).sha256;
};

export const storeAttachmentBlob = async (
  dirHandle: FileSystemDirectoryHandle,
  file: File
): Promise<LocalBlobReference> => {
  const [format] = validateAttachments([file]);
  return createWorkspaceGenerationStore(dirHandle).storeBlob(
    file,
    format.mimeType
  );
};

export const getAttachmentDataUrl = async (
  dirHandle: FileSystemDirectoryHandle,
  attachment: FileAttachment
): Promise<string | undefined> => {
  if (attachment.content) return attachment.content;
  if (attachment.localBlob) {
    const blob = await createWorkspaceGenerationStore(dirHandle).readBlob(
      attachment.localBlob
    );
    if (!blob) {
      throw new Error(`Attachment "${attachment.name}" is missing from local storage.`);
    }
    validateAttachments([{
      name: attachment.name,
      type: attachment.type,
      size: blob.size
    }]);
    return blobToDataUrl(applyAttachmentMimeType(blob, getAttachmentMimeType(attachment)));
  }
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
  return writeJsonFile(dirHandle, STORAGE_FILES.SESSIONS, storedSessions);
};

export const readSessions = async (
  dirHandle: FileSystemDirectoryHandle,
  options: { readOnly?: boolean } = {}
): Promise<Session[]> => {
  const storedSessions = await readJsonFile(dirHandle, STORAGE_FILES.SESSIONS) || [];
  void options;
  return addRuntimeAttachmentMetadata(dirHandle, storedSessions);
};

export interface WorkspaceSnapshot {
  revision: number;
  createdAt: number;
  sessions: Session[];
  settings: AppSettings;
  instructions: SystemInstruction[];
  readBlob: (reference: LocalBlobReference) => Promise<Blob>;
  release?: () => void;
}

export interface WorkspaceReplacement {
  sessions: Session[];
  settings?: BackupSettings | null;
  instructions: SystemInstruction[];
  blobs: ReadonlyMap<string, Blob>;
}

export const readWorkspaceSnapshot = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<WorkspaceSnapshot> => {
  const generation = await ensureWorkspaceGeneration(dirHandle);
  const store = createWorkspaceGenerationStore(dirHandle);
  const release = store.pin(generation.manifest);
  return {
    revision: generation.manifest.revision,
    createdAt: generation.manifest.createdAt,
    sessions: generation.sessions,
    settings: generation.settings,
    instructions: generation.instructions,
    release,
    readBlob: async reference => {
      const blob = await store.readBlob(reference);
      if (!blob) {
        throw new Error(`Workspace blob ${reference.sha256} is missing.`);
      }
      return blob;
    }
  };
};

export const readLocalBlob = async (
  dirHandle: FileSystemDirectoryHandle,
  reference: LocalBlobReference
): Promise<Blob | null> => (
  createWorkspaceGenerationStore(dirHandle).readBlob(reference)
);

export const storeLocalBlob = async (
  dirHandle: FileSystemDirectoryHandle,
  blob: Blob,
  mimeType = blob.type
): Promise<LocalBlobReference> => (
  createWorkspaceGenerationStore(dirHandle).storeBlob(blob, mimeType)
);

// Keep the original path so existing verified restore points remain readable.
const INTERNAL_RECOVERY_ARCHIVE = 'recovery/pre-restore.zip';

export const writeInternalRecoveryArchive = async (
  dirHandle: FileSystemDirectoryHandle,
  archive: Blob
): Promise<void> => {
  const backend = await getStorageBackend();
  if (backend === 'indexeddb') {
    await idbWriteRawData(INTERNAL_RECOVERY_ARCHIVE, archive);
  } else {
    await writeOpfsBlobPath(dirHandle, INTERNAL_RECOVERY_ARCHIVE, archive);
  }
  const stored = await readInternalRecoveryArchive(dirHandle);
  if (!stored || stored.size !== archive.size) {
    throw new Error('The workspace recovery archive could not be verified.');
  }
};

export const readInternalRecoveryArchive = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<Blob | null> => {
  const backend = await getStorageBackend();
  if (backend === 'indexeddb') {
    const record = await idbReadRawData(INTERNAL_RECOVERY_ARCHIVE);
    return record?.data instanceof Blob ? record.data : null;
  }
  return readOpfsBlobPath(dirHandle, INTERNAL_RECOVERY_ARCHIVE);
};

export const clearInternalRecoveryArchive = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<void> => {
  const backend = await getStorageBackend();
  if (backend === 'indexeddb') {
    await idbDeleteRawFile(INTERNAL_RECOVERY_ARCHIVE);
  } else {
    await deleteOpfsPath(dirHandle, INTERNAL_RECOVERY_ARCHIVE);
  }
};

export const replaceWorkspaceSnapshot = async (
  dirHandle: FileSystemDirectoryHandle,
  replacement: WorkspaceReplacement
): Promise<number> => {
  if (workspaceRevision === null) {
    throw new Error('Workspace revision has not been initialized.');
  }
  const current = await ensureWorkspaceGeneration(dirHandle, true);
  if (current.manifest.revision !== workspaceRevision) {
    throw new WorkspaceRevisionConflictError(
      workspaceRevision,
      current.manifest.revision
    );
  }

  const store = createWorkspaceGenerationStore(dirHandle);
  for (const [hash, blob] of replacement.blobs) {
    const stored = await store.storeBlob(blob, blob.type);
    if (stored.sha256 !== hash) {
      throw new Error(`Restore blob ${hash} failed its SHA-256 check.`);
    }
  }
  const sessions = await migrateSessionsToContentBlobs(
    dirHandle,
    replacement.sessions
  );
  const restoredSettings: AppSettings = replacement.settings
    ? {
        theme: replacement.settings.theme,
        apiKey: current.settings.apiKey,
        ...(replacement.settings.lastActiveSessionId
          ? { lastActiveSessionId: replacement.settings.lastActiveSessionId }
          : {})
      }
    : {
        theme: current.settings.theme,
        apiKey: current.settings.apiKey,
        ...(sessions[0] ? { lastActiveSessionId: sessions[0].id } : {})
      };
  validateWorkspaceReferences({
    sessions,
    settings: restoredSettings,
    instructions: replacement.instructions
  });

  const committed = await store.commit(workspaceRevision, {
    sessions: toStoredSessions(sessions),
    settings: restoredSettings,
    instructions: replacement.instructions
  });
  workspaceGenerationCache = committed;
  workspaceRevision = committed.manifest.revision;
  return committed.manifest.revision;
};

export class LegacyWorkspaceBackupUnsupportedError extends Error {
  constructor() {
    super(
      'Legacy JSON workspace backups are unsupported. Restore a verified OpenAI Studio ZIP backup instead.'
    );
    this.name = 'LegacyWorkspaceBackupUnsupportedError';
  }
}

export const getWorkspaceBackup = async (
  _dirHandle: FileSystemDirectoryHandle,
  _options: { readOnly?: boolean } = {}
): Promise<WorkspaceBackup> => {
  throw new LegacyWorkspaceBackupUnsupportedError();
};

export const restoreWorkspaceBackup = async (
  _dirHandle: FileSystemDirectoryHandle,
  _backupValue: unknown
): Promise<void> => {
  throw new LegacyWorkspaceBackupUnsupportedError();
};
