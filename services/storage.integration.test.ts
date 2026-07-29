import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  DEFAULT_CONFIG,
  type FileAttachment,
  type Session,
  type SystemInstruction
} from '../types';

const notFound = (name: string): DOMException => (
  new DOMException(`${name} was not found.`, 'NotFoundError')
);

class MemoryFileHandle {
  readonly kind = 'file';
  private data = new Blob();
  private lastModified = Date.now();

  constructor(
    readonly name: string,
    private readonly path: string,
    private readonly fileSystem: MemoryFileSystem
  ) {}

  async getFile(): Promise<File> {
    return new File([this.data], this.name, {
      type: this.data.type,
      lastModified: this.lastModified
    });
  }

  async createWritable() {
    let nextData = this.data;

    return {
      write: async (value: unknown): Promise<void> => {
        this.fileSystem.assertWriteAllowed(this.path);
        if (value instanceof Blob) {
          nextData = value;
        } else if (
          typeof value === 'string' ||
          value instanceof ArrayBuffer ||
          ArrayBuffer.isView(value)
        ) {
          nextData = new Blob([value as BlobPart]);
        } else {
          throw new Error(`Unsupported in-memory write for ${this.path}.`);
        }
      },
      close: async (): Promise<void> => {
        this.data = nextData;
        this.lastModified = Date.now();
      }
    };
  }
}

type MemoryEntry = MemoryDirectoryHandle | MemoryFileHandle;

class MemoryDirectoryHandle {
  readonly kind = 'directory';
  private readonly children = new Map<string, MemoryEntry>();

  constructor(
    readonly name: string,
    readonly path: string,
    private readonly fileSystem: MemoryFileSystem
  ) {}

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {}
  ): Promise<MemoryDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing?.kind === 'directory') return existing;
    if (existing || !options.create) throw notFound(name);

    const directory = new MemoryDirectoryHandle(
      name,
      this.childPath(name),
      this.fileSystem
    );
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(
    name: string,
    options: { create?: boolean } = {}
  ): Promise<MemoryFileHandle> {
    const existing = this.children.get(name);
    if (existing?.kind === 'file') return existing;
    if (existing || !options.create) throw notFound(name);

    const file = new MemoryFileHandle(
      name,
      this.childPath(name),
      this.fileSystem
    );
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw notFound(name);
  }

  async *entries(): AsyncGenerator<[string, MemoryEntry]> {
    for (const entry of this.children.entries()) {
      yield entry;
    }
  }

  getEntry(name: string): MemoryEntry | undefined {
    return this.children.get(name);
  }

  names(): string[] {
    return [...this.children.keys()].sort();
  }

  private childPath(name: string): string {
    return this.path ? `${this.path}/${name}` : name;
  }
}

class MemoryFileSystem {
  readonly root = new MemoryDirectoryHandle('', '', this);
  private failingWrite: RegExp | null = null;

  failNextWrite(pattern: RegExp): void {
    this.failingWrite = pattern;
  }

  assertWriteAllowed(path: string): void {
    if (!this.failingWrite?.test(path)) return;
    this.failingWrite = null;
    throw new Error(`Simulated disk full while writing ${path}.`);
  }

  async getDirectory(path: string): Promise<MemoryDirectoryHandle> {
    let current = this.root;
    for (const segment of this.segments(path)) {
      current = await current.getDirectoryHandle(segment);
    }
    return current;
  }

  async readText(path: string): Promise<string | null> {
    const { directory, name } = await this.resolveParent(path);
    const entry = directory.getEntry(name);
    if (!entry || entry.kind !== 'file') return null;
    return (await entry.getFile()).text();
  }

  async writeText(path: string, text: string): Promise<void> {
    const { directory, name } = await this.resolveParent(path, true);
    const file = await directory.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async remove(path: string): Promise<void> {
    const { directory, name } = await this.resolveParent(path);
    await directory.removeEntry(name);
  }

  private segments(path: string): string[] {
    return path.split('/').filter(Boolean);
  }

  private async resolveParent(
    path: string,
    create = false
  ): Promise<{ directory: MemoryDirectoryHandle; name: string }> {
    const segments = this.segments(path);
    const name = segments.pop();
    if (!name) throw new Error(`Invalid in-memory path: ${path}`);

    let directory = this.root;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
    return { directory, name };
  }
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

interface IndexedDbRecord {
  filename: string;
  data: string | Blob;
  updatedAt: number;
}

const openIndexedDb = (
  indexedDb: IDBFactory
): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDb.open('openai-studio-storage', 1);
  request.onerror = () => reject(request.error);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('files')) {
      database.createObjectStore('files', { keyPath: 'filename' });
    }
  };
  request.onsuccess = () => resolve(request.result);
});

const seedIndexedDb = async (
  indexedDb: IDBFactory,
  records: IndexedDbRecord[]
): Promise<IDBDatabase> => {
  const database = await openIndexedDb(indexedDb);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['files'], 'readwrite');
    const store = transaction.objectStore('files');
    records.forEach(record => store.put(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return database;
};

const readIndexedDbRecord = (
  database: IDBDatabase,
  filename: string
): Promise<IndexedDbRecord | undefined> => new Promise((resolve, reject) => {
  const transaction = database.transaction(['files'], 'readonly');
  const request = transaction.objectStore('files').get(filename);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(
    request.result as IndexedDbRecord | undefined
  );
});

class MemoryFileReader {
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then(buffer => {
      const binary = Array.from(
        new Uint8Array(buffer),
        byte => String.fromCharCode(byte)
      ).join('');
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
      this.onloadend?.();
    }).catch(error => {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.onerror?.();
    });
  }
}

type StorageModule = typeof import('./storage');

const createSession = (
  title: string,
  attachments?: FileAttachment[]
): Session => ({
  id: `session-${title.toLowerCase().replace(/\s+/g, '-')}`,
  title,
  config: { ...DEFAULT_CONFIG, tools: { ...DEFAULT_CONFIG.tools } },
  lastModified: 1,
  messages: [{
    id: `message-${title.toLowerCase().replace(/\s+/g, '-')}`,
    role: 'user',
    content: `Content for ${title}.`,
    timestamp: 1,
    ...(attachments ? { attachments } : {})
  }]
});

const instructions: SystemInstruction[] = [{
  id: 'instruction-1',
  title: 'Concise',
  content: 'Be concise.'
}];

const createBackup = (
  sessions: Session[],
  settings: Record<string, unknown> | null = { theme: 'light' }
) => ({
  schemaVersion: 1,
  sessions,
  settings,
  instructions,
  timestamp: 2
});

describe('storage public contracts', () => {
  let fileSystem: MemoryFileSystem;
  let storage: StorageModule;
  let handle: FileSystemDirectoryHandle;

  beforeEach(async () => {
    fileSystem = new MemoryFileSystem();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const localStorage = new MemoryStorage();
    vi.stubGlobal('window', {
      localStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => fileSystem.root)
      }
    });
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('FileReader', MemoryFileReader);
    vi.resetModules();

    storage = await import('./storage');
    handle = await storage.getStorageHandle();
    await storage.synchronizeWorkspaceRevision(handle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const seedWorkspace = async (
    sessions: Session[] = [createSession('Initial')]
  ): Promise<void> => {
    await storage.writeSessions(handle, sessions);
    await storage.writeJsonFile(handle, storage.STORAGE_FILES.SETTINGS, {
      theme: 'dark',
      apiKey: 'initial-key',
      lastActiveSessionId: sessions[0]?.id
    });
    await storage.writeJsonFile(
      handle,
      storage.STORAGE_FILES.INSTRUCTIONS,
      instructions
    );
  };

  it('round-trips writes through alternating immutable generations', async () => {
    await expect(storage.writeJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS,
      { theme: 'dark', apiKey: 'first-key' }
    )).resolves.toBe(1);
    await expect(storage.writeJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS,
      { theme: 'light', apiKey: 'second-key' }
    )).resolves.toBe(2);

    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS
    )).resolves.toEqual({
      theme: 'light',
      apiKey: 'second-key'
    });
    const manifestA = JSON.parse(
      await fileSystem.readText('data/workspace_manifest_a.json') || ''
    );
    const manifestB = JSON.parse(
      await fileSystem.readText('data/workspace_manifest_b.json') || ''
    );
    expect(manifestA.revision).toBe(2);
    expect(manifestB.revision).toBe(1);
    expect(manifestA.settings.sha256).not.toBe(manifestB.settings.sha256);
    expect(JSON.parse(
      await fileSystem.readText(
        `data/objects/${manifestB.settings.sha256}.json`
      ) || ''
    )).toEqual({
      theme: 'dark',
      apiKey: 'first-key'
    });
    expect(storage.getWorkspaceRevision()).toBe(2);
  });

  it('reuses unchanged objects and bounds garbage after repeated saves', async () => {
    await seedWorkspace([createSession('Reusable')]);
    for (let index = 0; index < 8; index += 1) {
      await storage.writeJsonFile(
        handle,
        storage.STORAGE_FILES.SETTINGS,
        {
          theme: index % 2 === 0 ? 'dark' : 'light',
          apiKey: `key-${index}`,
          lastActiveSessionId: 'session-reusable'
        }
      );
    }
    const manifestA = JSON.parse(
      await fileSystem.readText('data/workspace_manifest_a.json') || ''
    );
    const manifestB = JSON.parse(
      await fileSystem.readText('data/workspace_manifest_b.json') || ''
    );
    expect(manifestA.sessions[0].sha256).toBe(manifestB.sessions[0].sha256);
    const objects = await fileSystem.getDirectory('data/objects');
    expect(objects.names().length).toBeLessThanOrEqual(4);
  });

  it('rejects a stale writer before overwriting workspace data', async () => {
    await storage.writeJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS,
      { theme: 'dark', apiKey: 'first' }
    );
    const active = JSON.parse(
      await fileSystem.readText('data/workspace_manifest_b.json') || ''
    );
    await fileSystem.writeText(
      'data/workspace_manifest_a.json',
      JSON.stringify({ ...active, revision: 2, createdAt: active.createdAt + 1 })
    );

    await expect(storage.writeJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS,
      { theme: 'dark', apiKey: 'must-not-write' }
    )).rejects.toMatchObject({
      name: 'WorkspaceRevisionConflictError',
      expectedRevision: 1,
      actualRevision: 2
    });
    const newest = JSON.parse(
      await fileSystem.readText('data/workspace_manifest_a.json') || ''
    );
    expect(newest.settings.sha256).toBe(active.settings.sha256);
  });

  it('falls back as a whole when the newest generation is corrupt', async () => {
    const initialSessions = [createSession('Initial')];
    const replacementSessions = [createSession('Replacement')];
    await seedWorkspace(initialSessions);
    await storage.writeSessions(
      handle,
      replacementSessions
    );

    const manifests = await Promise.all([
      fileSystem.readText('data/workspace_manifest_a.json'),
      fileSystem.readText('data/workspace_manifest_b.json')
    ]);
    const parsed = manifests.map(text => JSON.parse(text || ''));
    const newest = parsed.sort((left, right) => right.revision - left.revision)[0];
    const previous = parsed[1];
    expect(await storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).toEqual(replacementSessions);

    await fileSystem.writeText(
      `data/objects/${newest.sessions[0].sha256}.json`,
      '{"not":"the referenced session"}'
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(storage.synchronizeWorkspaceRevision(handle)).resolves.toBe(
      previous.revision
    );
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).resolves.toEqual(initialSessions);

    await fileSystem.writeText(
      `data/objects/${previous.sessions[0].sha256}.json`,
      '{"also":"invalid"}'
    );
    await expect(storage.synchronizeWorkspaceRevision(handle))
      .rejects.toThrow('No complete local workspace generation');
    warn.mockRestore();
  });

  it('does not replace two corrupt generation manifests with an empty workspace', async () => {
    await seedWorkspace([createSession('Protected')]);
    await fileSystem.writeText('data/workspace_manifest_a.json', '{');
    await fileSystem.writeText('data/workspace_manifest_b.json', '{"schemaVersion":99}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(storage.synchronizeWorkspaceRevision(handle)).rejects.toThrow(
      'No complete local workspace generation'
    );
    expect(await fileSystem.readText('data/sessions.json')).toBeNull();
    warn.mockRestore();
  });

  it('stores attachment bytes by SHA-256 and resolves them for API input', async () => {
    const localBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['private notes'], 'notes.txt', { type: 'text/plain' })
    );
    const originalSessions = [createSession('Attached', [{
      localBlob,
      name: 'notes.txt',
      type: 'text/plain',
      size: 13
    }])];
    await seedWorkspace(originalSessions);

    const storedSessions = await storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    );
    const storedAttachment = storedSessions?.[0].messages[0].attachments?.[0];
    expect(storedAttachment).toMatchObject({
      name: 'notes.txt',
      type: 'text/plain',
      size: 13,
      localBlob
    });
    await expect(storage.getAttachmentDataUrl(
      handle,
      storedAttachment!
    )).resolves.toBe(
      'data:text/plain;base64,cHJpdmF0ZSBub3Rlcw=='
    );
    expect(await fileSystem.readText(`data/blobs/${localBlob.sha256}`))
      .toBe('private notes');
  });

  it('does not collect staged bytes before their session reference is published', async () => {
    const localBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['staged bytes'], 'staged.txt', { type: 'text/plain' })
    );

    await storage.writeJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS,
      { theme: 'light', apiKey: 'updated-key' }
    );
    expect(await fileSystem.readText(`data/blobs/${localBlob.sha256}`))
      .toBe('staged bytes');

    await storage.writeSessions(handle, [createSession('Staged', [{
      name: 'staged.txt',
      type: 'text/plain',
      size: 12,
      localBlob
    }])]);
    expect(await fileSystem.readText(`data/blobs/${localBlob.sha256}`))
      .toBe('staged bytes');
  });

  it('retains content needed by a pinned snapshot across later saves', async () => {
    const localBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['pinned bytes'], 'pinned.txt', { type: 'text/plain' })
    );
    await seedWorkspace([createSession('Pinned', [{
      name: 'pinned.txt',
      type: 'text/plain',
      size: 12,
      localBlob
    }])]);
    const snapshot = await storage.readWorkspaceSnapshot(handle);

    await storage.writeSessions(handle, [createSession('Second')]);
    await storage.writeSessions(handle, [createSession('Third')]);
    await storage.writeSessions(handle, [createSession('Fourth')]);
    await expect(snapshot.readBlob(localBlob)).resolves.toBeInstanceOf(Blob);
    expect(await fileSystem.readText(`data/blobs/${localBlob.sha256}`))
      .toBe('pinned bytes');

    snapshot.release?.();
    await storage.writeSessions(handle, [createSession('Fifth')]);
    expect(await fileSystem.readText(`data/blobs/${localBlob.sha256}`)).toBeNull();
  });

  it('keeps the active generation unchanged when a replacement write fails', async () => {
    const initialSessions = [createSession('Initial')];
    await seedWorkspace(initialSessions);
    const revisionBefore = storage.getWorkspaceRevision();
    const manifestBefore = await fileSystem.readText('data/workspace_manifest_a.json');
    fileSystem.failNextWrite(/objects\/[a-f0-9]{64}\.json$/);

    await expect(storage.replaceWorkspaceSnapshot(
      handle,
      {
        sessions: [createSession('Replacement')],
        settings: { theme: 'light' },
        instructions,
        blobs: new Map()
      }
    )).rejects.toThrow('Simulated disk full');

    expect(storage.getWorkspaceRevision()).toBe(revisionBefore);
    expect(await fileSystem.readText('data/workspace_manifest_a.json'))
      .toBe(manifestBefore);
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).resolves.toEqual(initialSessions);
  });

  it('rejects legacy JSON restore calls with a specific error', async () => {
    await expect(storage.restoreWorkspaceBackup(
      handle,
      createBackup([createSession('Legacy')])
    )).rejects.toMatchObject({
      name: 'LegacyWorkspaceBackupUnsupportedError'
    });
  });

  it('creates a verified recovery point, preserves the local key, and supports undo', async () => {
    const initialSessions = [createSession('Initial')];
    const replacementSessions = [createSession('Replacement')];
    await seedWorkspace(initialSessions);
    const { createWorkspaceArchive } = await import('./workspaceArchive');
    const {
      restoreWorkspaceArchive,
      undoLastWorkspaceRestore
    } = await import('./workspaceRestore');
    const archive = await createWorkspaceArchive({
      revision: 40,
      createdAt: 40,
      sessions: replacementSessions,
      settings: {
        theme: 'light',
        apiKey: 'must-not-be-restored',
        lastActiveSessionId: replacementSessions[0].id
      },
      instructions,
      readBlob: async () => {
        throw new Error('No blobs are referenced.');
      }
    }, { reason: 'manual' });

    await restoreWorkspaceArchive(handle, archive, {
      filename: 'replacement.zip'
    });
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).resolves.toEqual(replacementSessions);
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS
    )).resolves.toMatchObject({
      theme: 'light',
      apiKey: 'initial-key'
    });
    expect(await storage.readInternalRecoveryArchive(handle)).not.toBeNull();

    await undoLastWorkspaceRestore(handle);
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).resolves.toEqual(initialSessions);
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS
    )).resolves.toMatchObject({
      theme: 'dark',
      apiKey: 'initial-key'
    });
  });

  it('aborts restore without changing the workspace when recovery persistence fails', async () => {
    const initialSessions = [createSession('Initial')];
    await seedWorkspace(initialSessions);
    const { createWorkspaceArchive } = await import('./workspaceArchive');
    const { restoreWorkspaceArchive } = await import('./workspaceRestore');
    const replacementSessions = [createSession('Replacement')];
    const archive = await createWorkspaceArchive({
      revision: 2,
      createdAt: 2,
      sessions: replacementSessions,
      settings: { theme: 'light', apiKey: '' },
      instructions,
      readBlob: async () => {
        throw new Error('No blobs are referenced.');
      }
    }, { reason: 'manual' });
    fileSystem.failNextWrite(/recovery\/pre-restore\.zip$/);

    await expect(restoreWorkspaceArchive(handle, archive))
      .rejects.toThrow('Simulated disk full');
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).resolves.toEqual(initialSessions);
  });
});

describe('storage backend migration contracts', () => {
  let database: IDBDatabase;
  let fileSystem: MemoryFileSystem;
  let indexedDb: IDBFactory;
  let localStorage: MemoryStorage;
  let storage: StorageModule;

  const backendIdentityKey = 'openai-studio-storage-backend-v1';
  const indexedDbRecords: IndexedDbRecord[] = [
    {
      filename: 'sessions.json',
      data: '[]',
      updatedAt: 1
    },
    {
      filename: 'settings.json',
      data: JSON.stringify({
        theme: 'dark',
        apiKey: 'local-key'
      }),
      updatedAt: 1
    },
    {
      filename: 'system_instructions.json',
      data: '[]',
      updatedAt: 1
    },
    {
      filename: 'workspace_revision.json',
      data: JSON.stringify({ revision: 7 }),
      updatedAt: 1
    },
    {
      filename: 'attachments/attachment-1',
      data: new Blob(['attachment bytes'], { type: 'text/plain' }),
      updatedAt: 1
    }
  ];

  beforeEach(async () => {
    fileSystem = new MemoryFileSystem();
    indexedDb = new IDBFactory();
    localStorage = new MemoryStorage();
    localStorage.setItem(
      backendIdentityKey,
      JSON.stringify({ version: 1, backend: 'indexeddb' })
    );
    database = await seedIndexedDb(indexedDb, indexedDbRecords);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('window', {
      localStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => fileSystem.root)
      }
    });
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('FileReader', MemoryFileReader);
    vi.resetModules();
    storage = await import('./storage');
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('copies and byte-verifies an IndexedDB workspace before switching to OPFS', async () => {
    const resolveBackendChoice = vi.fn().mockResolvedValue('migrate-to-opfs');

    const handle = await storage.getStorageHandle({
      resolveBackendChoice
    });
    await expect(storage.synchronizeWorkspaceRevision(handle)).resolves.toBe(7);

    expect(resolveBackendChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'migration',
        persistedBackend: 'indexeddb',
        indexeddb: expect.objectContaining({
          hasWorkspace: true,
          revision: 7,
          recordCount: indexedDbRecords.length
        }),
        opfs: expect.objectContaining({
          available: true,
          hasWorkspace: false
        })
      })
    );
    expect(storage.getActiveStorageBackend()).toBe('opfs');
    expect(JSON.parse(localStorage.getItem(backendIdentityKey) || '')).toEqual({
      version: 1,
      backend: 'opfs'
    });
    expect(await fileSystem.readText('data/settings.json')).toBe(
      indexedDbRecords[1].data
    );
    expect(JSON.parse(
      await fileSystem.readText('data/workspace_manifest_a.json') || ''
    )).toMatchObject({
      schemaVersion: 2,
      revision: 7
    });
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS
    )).resolves.toEqual({
      theme: 'dark',
      apiKey: 'local-key'
    });
    expect(await fileSystem.readText(
      'data/attachments/attachment-1'
    )).toBe('attachment bytes');
    expect(await readIndexedDbRecord(database, 'settings.json')).toMatchObject({
      data: indexedDbRecords[1].data
    });
  });

  it('rolls back every attempted OPFS record when migration copying fails', async () => {
    fileSystem.failNextWrite(/data\/settings\.json$/);

    await expect(storage.getStorageHandle({
      resolveBackendChoice: async () => 'migrate-to-opfs' as const
    })).rejects.toThrow('Simulated disk full');

    expect(storage.getActiveStorageBackend()).toBeNull();
    expect(JSON.parse(localStorage.getItem(backendIdentityKey) || '')).toEqual({
      version: 1,
      backend: 'indexeddb'
    });
    const dataDirectory = await fileSystem.getDirectory('data');
    expect(dataDirectory.names()).toEqual([]);
    expect(await readIndexedDbRecord(database, 'settings.json')).toMatchObject({
      data: indexedDbRecords[1].data
    });
  });

  it('refuses an IndexedDB fallback when Electron cannot use OPFS', async () => {
    (window as any).electronAPI = {};
    vi.mocked(navigator.storage.getDirectory).mockRejectedValue(
      new Error('OPFS unavailable')
    );

    await expect(storage.getStorageHandle()).rejects.toThrow(
      /Electron.*OPFS/
    );
    expect(storage.getActiveStorageBackend()).toBeNull();
    expect(JSON.parse(localStorage.getItem(backendIdentityKey) || '')).toEqual({
      version: 1,
      backend: 'indexeddb'
    });
  });
});
