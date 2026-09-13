import {
  FileAttachment,
  LocalBlobReference,
  Project,
  ProjectRemoteState,
  Session,
  SystemInstruction
} from '../types';
import {
  getAttachmentMimeType,
  validateAttachments
} from '../utils/attachmentValidation';
import {
  AppSettings,
  BackupSettings,
  parseAppSettings,
  parseProjectRemoteState,
  parseProjects,
  parseStoredSessions,
  parseSystemInstructions,
  validateWorkspaceReferences
} from './workspaceSchema';
import {
  ValidWorkspaceGeneration,
  WorkspaceGenerationData,
  WorkspaceGenerationStore
} from './workspaceGenerationStore';
import { sha256Text } from './contentAddressing';
import { SerializedOperationQueue } from './serializedOperationQueue';

export type {
  AppSettings,
  BackupSettings
} from './workspaceSchema';
export { validateWorkspaceReferences } from './workspaceSchema';

// The workspace lives in the Origin Private File System. A browser or Electron
// renderer without a writable OPFS fails visibly instead of opening a
// different store.
let opfsDataDir: FileSystemDirectoryHandle | null = null;
let workspaceRevision: number | null = null;
let workspaceGenerationCache: ValidWorkspaceGeneration | null = null;
let workspaceStorageReadOnly = false;
const workspaceWriteQueue = new SerializedOperationQueue();

const RETIRED_INDEXEDDB_NAME = 'openai-studio-storage';
const RETIRED_INDEXEDDB_STORE = 'files';

export interface StorageInitializationOptions {
  readOnly?: boolean;
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

const isElectronDesktop = (): boolean => (
  typeof window !== 'undefined' && Boolean(window.electronAPI)
);

const isNotFoundError = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotFoundError'
);

// Check that OPFS directories and writable file streams are both available,
// without sharing a probe path across tabs.
const checkOPFSSupport = async (): Promise<boolean> => {
  let root: FileSystemDirectoryHandle | null = null;
  let probeName: string | null = null;

  try {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      return false;
    }
    root = await navigator.storage.getDirectory();
    probeName = `__opfs_test_${crypto.randomUUID()}`;
    const probeDirectory = await root.getDirectoryHandle(probeName, { create: true });
    const probeFile = await probeDirectory.getFileHandle('probe', { create: true });
    return typeof (probeFile as any).createWritable === 'function';
  } catch {
    return false;
  } finally {
    if (root && probeName) {
      try {
        await root.removeEntry(probeName, { recursive: true });
      } catch (error) {
        if (!isNotFoundError(error)) {
          console.warn(`Failed to remove OPFS capability probe ${probeName}.`, error);
        }
      }
    }
  }
};

const initializeOpfsStorage = async (
  options: StorageInitializationOptions
): Promise<FileSystemDirectoryHandle> => {
  if (!(await checkOPFSSupport())) {
    throw new Error(
      isElectronDesktop()
        ? 'OPFS is unavailable in Electron. Workspace loading stopped instead of opening a fallback store.'
        : 'This browser does not provide a writable Origin Private File System, so the workspace cannot be opened.'
    );
  }

  const root = await navigator.storage.getDirectory();
  const dataDir = await root.getDirectoryHandle('data', { create: true });
  workspaceStorageReadOnly = Boolean(options.readOnly);
  workspaceRevision = null;
  workspaceGenerationCache = null;
  opfsDataDir = dataDir;
  return dataDir;
};

// Access the sandboxed OPFS `data` directory. Storage must be explicitly
// initialized so later calls cannot silently open a different location.
export const getStorageHandle = async (
  options: StorageInitializationOptions = {}
): Promise<FileSystemDirectoryHandle> => (
  opfsDataDir || initializeOpfsStorage(options)
);

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
    const blob = await readOpfsBlobPath(dirHandle, path);
    return blob ? blob.text() : null;
  },
  writeText: (path, text) => writeOpfsBlobPath(dirHandle, path, text),
  readBlob: path => readOpfsBlobPath(dirHandle, path),
  writeBlob: (path, blob) => writeOpfsBlobPath(dirHandle, path, blob),
  delete: path => deleteOpfsPath(dirHandle, path),
  list: prefix => listOpfsPaths(dirHandle, prefix)
});

const UNSUPPORTED_LOCAL_WORKSPACE_FILES = new Set([
  'sessions.json',
  'settings.json',
  'system_instructions.json',
  'workspace_manifest.json',
  'workspace_revision.json'
]);

const isUnsupportedLocalWorkspacePath = (path: string): boolean => (
  UNSUPPORTED_LOCAL_WORKSPACE_FILES.has(path) ||
  path.endsWith('.bak') ||
  path.startsWith('workspace_snapshot_') ||
  path.startsWith('attachments/')
);

// Earlier versions could keep a browser workspace in IndexedDB. That store is
// retired, but its records must never be hidden behind a freshly initialized
// empty OPFS workspace.
const hasRetiredIndexedDbWorkspace = async (): Promise<boolean> => {
  if (
    typeof indexedDB === 'undefined' ||
    typeof indexedDB.databases !== 'function' ||
    !(await indexedDB.databases()).some(database => database.name === RETIRED_INDEXEDDB_NAME)
  ) {
    return false;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RETIRED_INDEXEDDB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const finish = (result: boolean | Error) => {
        database.close();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      if (!database.objectStoreNames.contains(RETIRED_INDEXEDDB_STORE)) {
        finish(false);
        return;
      }
      const countRequest = database
        .transaction(RETIRED_INDEXEDDB_STORE, 'readonly')
        .objectStore(RETIRED_INDEXEDDB_STORE)
        .count();
      countRequest.onerror = () => finish(countRequest.error || new Error('IndexedDB read failed.'));
      countRequest.onsuccess = () => finish(countRequest.result > 0);
    };
  });
};

const findUnsupportedLocalWorkspace = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<string | null> => {
  for await (const [name, entry] of (dirHandle as any).entries()) {
    if (
      (entry.kind === 'file' && isUnsupportedLocalWorkspacePath(name)) ||
      (entry.kind === 'directory' && name === 'attachments')
    ) {
      return 'This local workspace uses an unsupported storage format. Its data was not changed.';
    }
  }
  if (await hasRetiredIndexedDbWorkspace()) {
    return 'This browser holds a workspace in the retired IndexedDB store, which this version cannot open. Its data was not changed.';
  }
  return null;
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
  const unsupportedReason = await findUnsupportedLocalWorkspace(dirHandle);
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }
  if (workspaceStorageReadOnly) {
    throw new Error('An empty workspace must be initialized by the writer tab.');
  }

  const initialized = await store.commit(null, {
    sessions: [],
    settings: { theme: 'dark', apiKey: '' },
    instructions: [],
    projects: [],
    projectRemoteState: { indexes: {}, cleanupTombstones: [] }
  });
  workspaceGenerationCache = initialized;
  return initialized;
};

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

            if (attachment.localBlob) storedAttachment.localBlob = attachment.localBlob;

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
    // The generation was already validated during this load, so the declared
    // byte size is trusted and image previews skip hash verification.
    const sizedAttachment: FileAttachment = {
      ...attachment,
      size: attachment.localBlob.byteSize
    };
    if (!attachment.type.startsWith('image/')) {
      return sizedAttachment;
    }

    try {
      const blob = await createWorkspaceGenerationStore(dirHandle).readBlobData(
        attachment.localBlob
      );
      if (!blob) {
        console.warn(
          `Stored attachment ${attachment.localBlob.sha256} (${attachment.name}) is missing.`
        );
        return sizedAttachment;
      }
      return {
        ...sizedAttachment,
        previewUrl: URL.createObjectURL(applyAttachmentMimeType(blob, attachment.type))
      };
    } catch (error) {
      console.warn(`Failed to load attachment preview ${attachment.name}.`, error);
      return sizedAttachment;
    }
  }

  return attachment;
});

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
  return undefined;
};

export type WorkspaceChanges = Partial<WorkspaceGenerationData>;

const writeWorkspaceStateNow = async (
  dirHandle: FileSystemDirectoryHandle,
  changes: WorkspaceChanges,
  options: { publishTwice?: boolean } = {}
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
  const projects = changes.projects === undefined
    ? current.projects
    : parseProjects(changes.projects);
  const sessions = changes.sessions === undefined
    ? current.sessions
    : parseStoredSessions(toStoredSessions(changes.sessions));
  const projectRemoteState = changes.projectRemoteState === undefined
    ? current.projectRemoteState
    : parseProjectRemoteState(changes.projectRemoteState, projects);
  const data: WorkspaceGenerationData = normalizeWorkspaceGenerationReferences({
    sessions: toStoredSessions(sessions),
    settings: changes.settings === undefined
      ? current.settings
      : parseAppSettings(changes.settings) as AppSettings,
    instructions: changes.instructions === undefined
      ? current.instructions
      : parseSystemInstructions(changes.instructions),
    projects,
    projectRemoteState
  });
  validateWorkspaceReferences(data);
  let committed = await createWorkspaceGenerationStore(dirHandle).commit(
    workspaceRevision,
    data
  );
  if (options.publishTwice) {
    committed = await createWorkspaceGenerationStore(dirHandle).commit(
      committed.manifest.revision,
      data
    );
  }
  workspaceGenerationCache = committed;
  workspaceRevision = committed.manifest.revision;
  return committed.manifest.revision;
};

export const writeWorkspaceState = (
  dirHandle: FileSystemDirectoryHandle,
  changes: WorkspaceChanges,
  options: { publishTwice?: boolean } = {}
): Promise<number> => workspaceWriteQueue.enqueue(
  () => writeWorkspaceStateNow(dirHandle, changes, options),
  { blocksInteractions: false }
);

export interface WorkspaceState extends WorkspaceGenerationData {
  revision: number;
}

export const readWorkspaceState = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<WorkspaceState> => {
  const generation = await ensureWorkspaceGeneration(dirHandle);
  return {
    revision: generation.manifest.revision,
    sessions: await addRuntimeAttachmentMetadata(dirHandle, generation.sessions),
    settings: generation.settings,
    instructions: generation.instructions,
    projects: generation.projects,
    projectRemoteState: generation.projectRemoteState
  };
};

export interface WorkspaceSnapshot {
  revision: number;
  createdAt: number;
  sessions: Session[];
  settings: AppSettings;
  instructions: SystemInstruction[];
  projects?: Project[];
  projectRemoteState?: ProjectRemoteState;
  readBlob: (reference: LocalBlobReference) => Promise<Blob>;
  release?: () => void;
}

export interface WorkspaceReplacement {
  sessions: Session[];
  settings?: BackupSettings | null;
  instructions: SystemInstruction[];
  projects?: Project[];
  projectRemoteState?: ProjectRemoteState;
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
    projects: generation.projects,
    projectRemoteState: generation.projectRemoteState,
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
  await writeOpfsBlobPath(dirHandle, INTERNAL_RECOVERY_ARCHIVE, archive);
  const stored = await readInternalRecoveryArchive(dirHandle);
  if (!stored || stored.size !== archive.size) {
    throw new Error('The workspace recovery archive could not be verified.');
  }
};

export const readInternalRecoveryArchive = (
  dirHandle: FileSystemDirectoryHandle
): Promise<Blob | null> => readOpfsBlobPath(dirHandle, INTERNAL_RECOVERY_ARCHIVE);

export const clearInternalRecoveryArchive = (
  dirHandle: FileSystemDirectoryHandle
): Promise<void> => deleteOpfsPath(dirHandle, INTERNAL_RECOVERY_ARCHIVE);

const createPortableReplacementRemoteState = (
  current: ProjectRemoteState,
  revision: number
): ProjectRemoteState => {
  const cleanupTombstones = current.cleanupTombstones.map(tombstone => ({
    ...tombstone,
    openaiFileIds: [...tombstone.openaiFileIds]
  }));
  const usedIds = new Set(cleanupTombstones.map(tombstone => tombstone.id));
  Object.values(current.indexes).forEach(index => {
    const openaiFileIds = [...new Set(
      Object.values(index.files).flatMap(file => (
        file.openaiFileId ? [file.openaiFileId] : []
      ))
    )];
    if (openaiFileIds.length === 0 && !index.vectorStoreId) return;
    const baseId = `cleanup-restore-${sha256Text(`${revision}:${index.projectId}`)}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    cleanupTombstones.push({
      id,
      projectId: index.projectId,
      apiKeyFingerprint: index.apiKeyFingerprint,
      openaiFileIds,
      ...(index.vectorStoreId ? { vectorStoreId: index.vectorStoreId } : {}),
      createdAt: Date.now()
    });
  });
  return { indexes: {}, cleanupTombstones };
};

const replaceWorkspaceSnapshotNow = async (
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
  const sessions = parseStoredSessions(toStoredSessions(replacement.sessions));
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
    instructions: replacement.instructions,
    projects: replacement.projects || []
  });

  const committed = await store.commit(workspaceRevision, {
    sessions: toStoredSessions(sessions),
    settings: restoredSettings,
    instructions: replacement.instructions,
    projects: replacement.projects || [],
    // Portable replacements never import remote IDs. Existing device resources
    // become durable cleanup work so restore/undo cannot silently orphan them.
    projectRemoteState: replacement.projectRemoteState ||
      createPortableReplacementRemoteState(
        current.projectRemoteState,
        current.manifest.revision
      )
  });
  workspaceGenerationCache = committed;
  workspaceRevision = committed.manifest.revision;
  return committed.manifest.revision;
};

export const replaceWorkspaceSnapshot = (
  dirHandle: FileSystemDirectoryHandle,
  replacement: WorkspaceReplacement
): Promise<number> => workspaceWriteQueue.enqueue(
  () => replaceWorkspaceSnapshotNow(dirHandle, replacement),
  { blocksInteractions: false }
);
