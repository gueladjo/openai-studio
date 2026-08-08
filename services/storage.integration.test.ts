import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  DEFAULT_CONFIG,
  type FileAttachment,
  type Project,
  type ProjectRemoteState,
  type Session,
  type SystemInstruction
} from '../types';
import { sha256Blob, sha256Text, encodeUtf8 } from './contentAddressing';

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
type StoredWorkspaceState = Awaited<ReturnType<StorageModule['readWorkspaceState']>>;
type StoredWorkspaceKey = Exclude<keyof StoredWorkspaceState, 'revision'>;

const readWorkspaceField = async <Key extends StoredWorkspaceKey>(
  storage: StorageModule,
  handle: FileSystemDirectoryHandle,
  key: Key
): Promise<StoredWorkspaceState[Key]> => (
  (await storage.readWorkspaceState(handle))[key]
);

const writeWorkspaceField = (
  storage: StorageModule,
  handle: FileSystemDirectoryHandle,
  key: StoredWorkspaceKey,
  value: unknown
): Promise<number> => storage.writeWorkspaceState(handle, {
  [key]: value
} as Partial<Pick<StoredWorkspaceState, StoredWorkspaceKey>>);

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

const seedLegacyWorkspaceFiles = async (
  fileSystem: MemoryFileSystem,
  sessions: Session[],
  revision = 7
): Promise<void> => {
  await fileSystem.writeText('data/sessions.json', JSON.stringify(sessions));
  await fileSystem.writeText('data/settings.json', JSON.stringify({
    theme: 'dark',
    apiKey: 'legacy-key',
    lastActiveSessionId: sessions[0]?.id
  }));
  await fileSystem.writeText(
    'data/system_instructions.json',
    JSON.stringify(instructions)
  );
  await fileSystem.writeText(
    'data/workspace_revision.json',
    JSON.stringify({ revision })
  );
};

describe('storage public contracts', () => {
  let fileSystem: MemoryFileSystem;
  let storage: StorageModule;
  let handle: FileSystemDirectoryHandle;

  const readField = <Key extends StoredWorkspaceKey>(
    key: Key
  ): Promise<StoredWorkspaceState[Key]> => readWorkspaceField(
    storage,
    handle,
    key
  );

  const writeField = (
    key: StoredWorkspaceKey,
    value: unknown
  ): Promise<number> => writeWorkspaceField(storage, handle, key, value);

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
    await writeField('sessions', sessions);
    await writeField('settings', {
      theme: 'dark',
      apiKey: 'initial-key',
      lastActiveSessionId: sessions[0]?.id
    });
    await writeField('instructions', instructions);
  };

  it('round-trips writes through alternating immutable generations', async () => {
    await expect(writeField('settings',
      { theme: 'dark', apiKey: 'first-key' }
    )).resolves.toBe(1);
    await expect(writeField('settings',
      { theme: 'light', apiKey: 'second-key' }
    )).resolves.toBe(2);

    await expect(readField('settings')).resolves.toEqual({
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

  it('serializes project edits with concurrent source-state persistence', async () => {
    await seedWorkspace();
    const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
    const project: Project = {
      id: 'project-concurrent-write',
      name: 'Concurrent writes',
      icon: 'folder',
      instructions: '',
      defaultConfig,
      sources: [],
      createdAt: 1,
      updatedAt: 1
    };
    await storage.writeWorkspaceState(handle, { projects: [project] });

    const updatedProject = {
      ...project,
      instructions: 'Instructions edited during an upload.',
      updatedAt: 2
    };
    const remoteState: ProjectRemoteState = {
      indexes: {
        [project.id]: {
          projectId: project.id,
          apiKeyFingerprint: 'a'.repeat(64),
          status: 'creating',
          usageBytes: 0,
          files: {}
        }
      },
      cleanupTombstones: []
    };

    await expect(Promise.all([
      writeField('projects',
        [updatedProject]
      ),
      storage.writeWorkspaceState(handle, { projectRemoteState: remoteState })
    ])).resolves.toHaveLength(2);

    await expect(readField('projects')).resolves.toEqual([updatedProject]);
    await expect(readField('projectRemoteState')).resolves.toEqual(remoteState);
  });

  it('serializes whole-workspace replacement after an already queued save', async () => {
    await seedWorkspace();
    const replacementSession = createSession('Replacement after queued save');

    await expect(Promise.all([
      writeField('settings', {
        theme: 'light',
        apiKey: 'queued-key'
      }),
      storage.replaceWorkspaceSnapshot(handle, {
        sessions: [replacementSession],
        settings: { theme: 'dark' },
        instructions: [],
        projects: [],
        blobs: new Map()
      })
    ])).resolves.toHaveLength(2);

    await expect(readField('sessions')).resolves.toEqual([replacementSession]);
    await expect(readField('settings')).resolves.toEqual({
      theme: 'dark',
      apiKey: 'queued-key'
    });
  });

  it('rejects unsupported generation versions without republishing them', async () => {
    await seedWorkspace();
    const originalManifests = new Map<string, string>();
    for (const slot of ['a', 'b']) {
      const path = `data/workspace_manifest_${slot}.json`;
      const original = await fileSystem.readText(path) || '';
      originalManifests.set(path, original);
      const manifest = JSON.parse(original);
      manifest.schemaVersion = 4;
      await fileSystem.writeText(path, JSON.stringify(manifest));
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    storage = await import('./storage');
    handle = await storage.getStorageHandle();
    await expect(storage.synchronizeWorkspaceRevision(handle))
      .rejects.toThrow('No complete local workspace generation');
    for (const [path, original] of originalManifests) {
      expect(JSON.parse(await fileSystem.readText(path) || '')).toEqual({
        ...JSON.parse(original),
        schemaVersion: 4
      });
    }
    warn.mockRestore();
  });

  it('persists cache-write token usage on assistant messages', async () => {
    const session = createSession('Cache usage');
    session.messages.push({
      id: 'message-cache-usage-assistant',
      role: 'assistant',
      content: 'Cached response.',
      status: 'complete',
      timestamp: 2,
      modelName: 'GPT-5.6 Sol',
      usage: {
        input_tokens: 5_000,
        input_tokens_details: {
          cache_write_tokens: 1_234,
          cached_tokens: 567
        },
        output_tokens: 89,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 5_089
      }
    });

    await writeField('sessions', [session]);

    const storedSessions = await readField('sessions');
    expect(storedSessions[0].messages[1].usage?.input_tokens_details)
      .toEqual({ cache_write_tokens: 1_234, cached_tokens: 567 });
  });

  it('persists ordered assistant output phases', async () => {
    const session = createSession('Assistant phases');
    session.messages.push({
      id: 'message-phases-assistant',
      role: 'assistant',
      content: 'Checking.\n\nComplete.',
      outputMessages: [{
        content: 'Checking.',
        phase: 'commentary'
      }, {
        content: 'Complete.',
        phase: 'final_answer'
      }],
      status: 'complete',
      timestamp: 2,
      modelName: 'GPT-5.6 Sol'
    });

    await writeField('sessions', [session]);

    const storedSessions = await readField('sessions');
    expect(storedSessions[0].messages[1].outputMessages).toEqual([{
      content: 'Checking.',
      phase: 'commentary'
    }, {
      content: 'Complete.',
      phase: 'final_answer'
    }]);
  });

  it('persists Web Search options exactly', async () => {
    const session = createSession('Web Search options');
    session.config.tools.webSearchOptions = {
      searchContextSize: 'low',
      userLocation: null
    };

    await writeField('sessions', [session]);

    const storedSessions = await readField('sessions');
    expect(storedSessions[0].config.tools.webSearchOptions).toEqual({
      searchContextSize: 'low',
      userLocation: null
    });
  });

  it('persists project sources in the exact verified blob union', async () => {
    const bytes = new Blob(['project source'], { type: 'text/plain' });
    const localBlob = await storage.storeLocalBlob(handle, bytes, 'text/plain');
    const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
    const project: Project = {
      id: 'project-storage',
      name: 'Storage project',
      icon: 'folder',
      instructions: 'Use the source.',
      defaultConfig,
      sources: [{
        id: 'source-storage',
        name: 'source.txt',
        mimeType: 'text/plain',
        byteSize: bytes.size,
        localBlob,
        capability: 'file_search',
        addedAt: 1
      }],
      createdAt: 1,
      updatedAt: 1
    };

    await storage.writeWorkspaceState(handle, { projects: [project] });
    await expect(readField('projects')).resolves.toEqual([project]);
    await expect(storage.readLocalBlob(handle, localBlob)).resolves.toMatchObject({
      size: bytes.size
    });

    const currentRevision = storage.getWorkspaceRevision();
    await expect(storage.writeWorkspaceState(handle, { projects: [{
      ...project,
      sources: [{
        ...project.sources[0],
        localBlob: {
          ...project.sources[0].localBlob,
          sha256: 'f'.repeat(64)
        }
      }]
    }]})).rejects.toThrow('is missing');
    expect(storage.getWorkspaceRevision()).toBe(currentRevision);
  });

  it('publishes permanent project deletion through both manifest slots', async () => {
    const bytes = new Blob(['delete me'], { type: 'text/plain' });
    const localBlob = await storage.storeLocalBlob(handle, bytes, 'text/plain');
    const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
    const project: Project = {
      id: 'project-delete',
      name: 'Delete project',
      icon: 'folder',
      instructions: 'Temporary.',
      defaultConfig,
      sources: [{
        id: 'source-delete',
        name: 'delete.txt',
        mimeType: 'text/plain',
        byteSize: bytes.size,
        localBlob,
        capability: 'file_search',
        addedAt: 1
      }],
      createdAt: 1,
      updatedAt: 1
    };
    const session = {
      ...createSession('Project member'),
      projectId: project.id
    };
    await storage.writeWorkspaceState(handle, {
      sessions: [session],
      projects: [project]
    });

    await storage.writeWorkspaceState(handle, {
      sessions: [],
      projects: []
    }, { publishTwice: true });

    for (const slot of ['a', 'b']) {
      const manifest = JSON.parse(
        await fileSystem.readText(`data/workspace_manifest_${slot}.json`) || ''
      );
      expect(manifest.schemaVersion).toBe(5);
      expect(manifest.sessions).toEqual([]);
      expect(JSON.parse(
        await fileSystem.readText(`data/objects/${manifest.projects.sha256}.json`) || ''
      )).toEqual([]);
    }
    await expect(storage.readLocalBlob(handle, localBlob)).resolves.toBeNull();
  });

  it('turns replaced remote indexes into nonportable cleanup tombstones', async () => {
    const bytes = new Blob(['remote source'], { type: 'text/plain' });
    const localBlob = await storage.storeLocalBlob(handle, bytes, 'text/plain');
    const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
    const project: Project = {
      id: 'project-restore-cleanup',
      name: 'Remote project',
      icon: 'folder',
      instructions: '',
      defaultConfig,
      sources: [{
        id: 'source-restore-cleanup',
        name: 'remote.txt',
        mimeType: 'text/plain',
        byteSize: bytes.size,
        localBlob,
        capability: 'file_search',
        addedAt: 1
      }],
      createdAt: 1,
      updatedAt: 1
    };
    await storage.writeWorkspaceState(handle, {
      projects: [project],
      projectRemoteState: {
        indexes: {
          [project.id]: {
            projectId: project.id,
            apiKeyFingerprint: 'e'.repeat(64),
            vectorStoreId: 'vector-restore-cleanup',
            status: 'ready',
            usageBytes: 10,
            files: {
              [project.sources[0].id]: {
                projectSourceId: project.sources[0].id,
                openaiFileId: 'file-restore-cleanup',
                status: 'ready'
              }
            }
          }
        },
        cleanupTombstones: []
      }
    });

    await storage.replaceWorkspaceSnapshot(handle, {
      sessions: [],
      settings: { theme: 'dark' },
      instructions: [],
      projects: [],
      blobs: new Map()
    });

    await expect(readField('projectRemoteState')).resolves.toMatchObject({
      indexes: {},
      cleanupTombstones: [{
        projectId: project.id,
        apiKeyFingerprint: 'e'.repeat(64),
        openaiFileIds: ['file-restore-cleanup'],
        vectorStoreId: 'vector-restore-cleanup'
      }]
    });
  });

  it('reuses unchanged objects and bounds garbage after repeated saves', async () => {
    await seedWorkspace([createSession('Reusable')]);
    for (let index = 0; index < 8; index += 1) {
      await writeField('settings',
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
    expect(objects.names().length).toBeLessThanOrEqual(6);
  });

  it('rejects a stale writer before overwriting workspace data', async () => {
    await writeField('settings',
      { theme: 'dark', apiKey: 'first' }
    );
    const active = JSON.parse(
      await fileSystem.readText('data/workspace_manifest_b.json') || ''
    );
    await fileSystem.writeText(
      'data/workspace_manifest_a.json',
      JSON.stringify({ ...active, revision: 2, createdAt: active.createdAt + 1 })
    );

    await expect(writeField('settings',
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
    await writeField('sessions',
      replacementSessions
    );

    const manifests = await Promise.all([
      fileSystem.readText('data/workspace_manifest_a.json'),
      fileSystem.readText('data/workspace_manifest_b.json')
    ]);
    const parsed = manifests.map(text => JSON.parse(text || ''));
    const newest = parsed.sort((left, right) => right.revision - left.revision)[0];
    const previous = parsed[1];
    expect(await readField('sessions')).toEqual(replacementSessions);

    await fileSystem.writeText(
      `data/objects/${newest.sessions[0].sha256}.json`,
      '{"not":"the referenced session"}'
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(storage.synchronizeWorkspaceRevision(handle)).resolves.toBe(
      previous.revision
    );
    await expect(readField('sessions')).resolves.toEqual(initialSessions);

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

    const storedSessions = await readField('sessions');
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

  it('adds runtime attachment metadata from validated blob references', async () => {
    const imageBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['image bytes'], 'image.png', { type: 'image/png' })
    );
    const documentBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['document bytes'], 'document.txt', { type: 'text/plain' })
    );
    await seedWorkspace([createSession('Attachments', [
      {
        name: 'image.png',
        type: 'image/png',
        size: imageBlob.byteSize,
        localBlob: imageBlob
      },
      {
        name: 'document.txt',
        type: 'text/plain',
        size: documentBlob.byteSize,
        localBlob: documentBlob
      }
    ])]);

    const sessions = await readField('sessions');
    const [image, document] = sessions[0].messages[0].attachments!;
    expect(image.size).toBe(imageBlob.byteSize);
    expect(image.previewUrl).toMatch(/^blob:/);
    expect(document.size).toBe(documentBlob.byteSize);
    expect(document.previewUrl).toBeUndefined();
  });

  it('strips transient attachment fields before an atomic workspace write', async () => {
    const imageBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['image bytes'], 'image.png', { type: 'image/png' })
    );
    await seedWorkspace([createSession('Runtime preview', [{
      name: 'image.png',
      type: 'image/png',
      size: imageBlob.byteSize,
      localBlob: imageBlob
    }])]);

    const sessionsWithRuntimeMetadata = await readField('sessions');
    const runtimeAttachment = sessionsWithRuntimeMetadata[0].messages[0].attachments?.[0];
    expect(runtimeAttachment?.previewUrl).toMatch(/^blob:/);
    runtimeAttachment!.content = 'data:image/png;base64,aW1hZ2UgYnl0ZXM=';

    await expect(storage.writeWorkspaceState(handle, {
      sessions: sessionsWithRuntimeMetadata
    }, { publishTwice: true })).resolves.toBeTypeOf('number');

    const storedSnapshot = await storage.readWorkspaceSnapshot(handle);
    try {
      expect(storedSnapshot.sessions[0].messages[0].attachments?.[0])
        .not.toHaveProperty('previewUrl');
      expect(storedSnapshot.sessions[0].messages[0].attachments?.[0])
        .not.toHaveProperty('content');
    } finally {
      storedSnapshot.release?.();
    }
  });

  it('keeps blob reference metadata and warns when an image preview is unreadable', async () => {
    const imageBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['image bytes'], 'image.png', { type: 'image/png' })
    );
    await seedWorkspace([createSession('Broken preview', [{
      name: 'image.png',
      type: 'image/png',
      size: imageBlob.byteSize,
      localBlob: imageBlob
    }])]);
    await fileSystem.remove(`data/blobs/${imageBlob.sha256}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const sessions = await readField('sessions');
    const attachment = sessions[0].messages[0].attachments![0];
    expect(attachment.size).toBe(imageBlob.byteSize);
    expect(attachment.previewUrl).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('is missing.')
    );
    warn.mockRestore();
  });

  it('preserves manifest session order through repeated validation', async () => {
    const sessions = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(title => createSession(title));
    await seedWorkspace(sessions);

    await expect(readField('sessions')).resolves.toEqual(sessions);
    await storage.synchronizeWorkspaceRevision(handle);
    await expect(readField('sessions')).resolves.toEqual(sessions);
  });

  it('warns and falls back when the newest manifest cannot be parsed', async () => {
    await seedWorkspace([createSession('Stable')]);
    await writeField('sessions', [createSession('Updated')]);

    const [manifestA, manifestB] = await Promise.all([
      fileSystem.readText('data/workspace_manifest_a.json'),
      fileSystem.readText('data/workspace_manifest_b.json')
    ]);
    const generations = ([
      ['a', manifestA],
      ['b', manifestB]
    ] as const)
      .map(([slot, text]) => ({ slot, revision: JSON.parse(text || '{}').revision }))
      .sort((left, right) => right.revision - left.revision);
    await fileSystem.writeText(
      `data/workspace_manifest_${generations[0].slot}.json`,
      '{'
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(storage.synchronizeWorkspaceRevision(handle)).resolves.toBe(
      generations[1].revision
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignored incomplete workspace generation'),
      expect.anything()
    );
    warn.mockRestore();
  });

  it('does not downgrade a missing blob to metadata-only attachment data', async () => {
    const localBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['protected bytes'], 'protected.txt', { type: 'text/plain' })
    );
    await seedWorkspace([createSession('Protected blob', [{
      name: 'protected.txt',
      type: 'text/plain',
      size: 15,
      localBlob
    }])]);
    await fileSystem.remove(`data/blobs/${localBlob.sha256}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(storage.synchronizeWorkspaceRevision(handle)).rejects.toThrow(
      'No complete local workspace generation'
    );
    expect(await fileSystem.readText('data/sessions.json')).toBeNull();
    warn.mockRestore();
  });

  it('does not collect staged bytes before their session reference is published', async () => {
    const localBlob = await storage.storeAttachmentBlob(
      handle,
      new File(['staged bytes'], 'staged.txt', { type: 'text/plain' })
    );

    await writeField('settings',
      { theme: 'light', apiKey: 'updated-key' }
    );
    expect(await fileSystem.readText(`data/blobs/${localBlob.sha256}`))
      .toBe('staged bytes');

    await writeField('sessions', [createSession('Staged', [{
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

    await writeField('sessions', [createSession('Second')]);
    await writeField('sessions', [createSession('Third')]);
    await writeField('sessions', [createSession('Fourth')]);
    await expect(snapshot.readBlob(localBlob)).resolves.toBeInstanceOf(Blob);
    expect(await fileSystem.readText(`data/blobs/${localBlob.sha256}`))
      .toBe('pinned bytes');

    snapshot.release?.();
    await writeField('sessions', [createSession('Fifth')]);
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
    await expect(readField('sessions')).resolves.toEqual(initialSessions);
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
    await expect(readField('sessions')).resolves.toEqual(replacementSessions);
    await expect(readField('settings')).resolves.toMatchObject({
      theme: 'light',
      apiKey: 'initial-key'
    });
    expect(await storage.readInternalRecoveryArchive(handle)).not.toBeNull();

    await undoLastWorkspaceRestore(handle);
    await expect(readField('sessions')).resolves.toEqual(initialSessions);
    await expect(readField('settings')).resolves.toMatchObject({
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
    await expect(readField('sessions')).resolves.toEqual(initialSessions);
  });

  it('merges chats atomically while preserving local settings, selection, and files', async () => {
    const initialSessions = [createSession('Initial')];
    await seedWorkspace(initialSessions);
    const importedBlob = new Blob(['imported attachment'], {
      type: 'text/plain'
    });
    const importedReference = {
      sha256: await sha256Blob(importedBlob),
      byteSize: importedBlob.size,
      mimeType: importedBlob.type
    };
    const importedInstruction: SystemInstruction = {
      id: 'instruction-imported',
      title: 'Imported',
      content: 'Use imported rules.'
    };
    const importedSession = {
      ...createSession('Imported', [{
        name: 'imported.txt',
        type: 'text/plain',
        size: importedBlob.size,
        localBlob: importedReference
      }]),
      config: {
        ...DEFAULT_CONFIG,
        tools: { ...DEFAULT_CONFIG.tools },
        systemInstructionId: importedInstruction.id
      },
      lastModified: 20
    };
    const { createWorkspaceArchive, inspectWorkspaceArchive } = await import(
      './workspaceArchive'
    );
    const { mergeWorkspaceArchive } = await import('./workspaceMerge');
    const {
      getLastWorkspaceRecoveryAction,
      undoLastWorkspaceMutation
    } = await import('./workspaceRestore');
    const archive = await createWorkspaceArchive({
      revision: 20,
      createdAt: 20,
      sessions: [importedSession],
      settings: {
        theme: 'light',
        apiKey: 'must-not-be-restored',
        lastActiveSessionId: importedSession.id
      },
      instructions: [importedInstruction],
      readBlob: async reference => {
        if (reference.sha256 === importedReference.sha256) return importedBlob;
        throw new Error('Unexpected imported blob.');
      }
    }, { reason: 'manual' });

    const result = await mergeWorkspaceArchive(handle, archive, {
      filename: 'merge.zip'
    });

    expect(result.counts).toEqual({
      imported: 1,
      skipped: 0,
      divergent: 0
    });
    await expect(readField('settings')).resolves.toEqual({
      theme: 'dark',
      apiKey: 'initial-key',
      lastActiveSessionId: initialSessions[0].id
    });
    const mergedSessions = await readField('sessions') as Session[];
    expect(mergedSessions.map(session => session.id)).toEqual([
      importedSession.id,
      initialSessions[0].id
    ]);
    const mergedAttachment = mergedSessions[0].messages[0].attachments?.[0];
    await expect(storage.readLocalBlob(
      handle,
      mergedAttachment!.localBlob!
    )).resolves.toBeInstanceOf(Blob);
    await expect(readField('instructions')).resolves.toEqual([...instructions, importedInstruction]);
    const recoveryArchive = await storage.readInternalRecoveryArchive(handle);
    expect(recoveryArchive).not.toBeNull();
    expect((await inspectWorkspaceArchive(
      recoveryArchive!,
      { retainBlobs: false }
    )).preview.reason).toBe('pre-merge');
    await expect(getLastWorkspaceRecoveryAction(handle)).resolves.toBe('merge');

    await undoLastWorkspaceMutation(handle);
    await expect(readField('sessions')).resolves.toEqual(initialSessions);
    await expect(storage.readInternalRecoveryArchive(handle)).resolves.toBeNull();
    await expect(getLastWorkspaceRecoveryAction(handle)).resolves.toBeNull();
  });

  it('does not publish a merge when recovery or generation persistence fails', async () => {
    const initialSessions = [createSession('Initial')];
    const importedSessions = [createSession('Imported')];
    await seedWorkspace(initialSessions);
    const { createWorkspaceArchive } = await import('./workspaceArchive');
    const { mergeWorkspaceArchive } = await import('./workspaceMerge');
    const archive = await createWorkspaceArchive({
      revision: 2,
      createdAt: 2,
      sessions: importedSessions,
      settings: { theme: 'light', apiKey: '' },
      instructions,
      readBlob: async () => {
        throw new Error('No blobs are referenced.');
      }
    }, { reason: 'manual' });

    fileSystem.failNextWrite(/recovery\/pre-restore\.zip$/);
    await expect(mergeWorkspaceArchive(handle, archive))
      .rejects.toThrow('Simulated disk full');
    await expect(readField('sessions')).resolves.toEqual(initialSessions);

    fileSystem.failNextWrite(/objects\/[a-f0-9]{64}\.json$/);
    await expect(mergeWorkspaceArchive(handle, archive))
      .rejects.toThrow('Simulated disk full');
    await expect(readField('sessions')).resolves.toEqual(initialSessions);
  });

  it('keeps only the latest successful workspace mutation undoable', async () => {
    const initialSessions = [createSession('Initial')];
    await seedWorkspace(initialSessions);
    const { createWorkspaceArchive } = await import('./workspaceArchive');
    const { mergeWorkspaceArchive } = await import('./workspaceMerge');
    const { undoLastWorkspaceMutation } = await import('./workspaceRestore');
    const createMergeArchive = (session: Session, revision: number) => (
      createWorkspaceArchive({
        revision,
        createdAt: revision,
        sessions: [session],
        settings: { theme: 'light', apiKey: '' },
        instructions,
        readBlob: async () => {
          throw new Error('No blobs are referenced.');
        }
      }, { reason: 'manual' })
    );

    await mergeWorkspaceArchive(
      handle,
      await createMergeArchive(createSession('First'), 10)
    );
    const sessionsAfterFirst = await readField('sessions');
    await mergeWorkspaceArchive(
      handle,
      await createMergeArchive(createSession('Second'), 11)
    );

    await undoLastWorkspaceMutation(handle);
    await expect(readField('sessions')).resolves.toEqual(sessionsAfterFirst);
    await expect(undoLastWorkspaceMutation(handle))
      .rejects.toThrow('No verified workspace recovery point');
  });

  it('retains the prior undo point when a later merge fails', async () => {
    const initialSessions = [createSession('Initial')];
    await seedWorkspace(initialSessions);
    const { createWorkspaceArchive } = await import('./workspaceArchive');
    const { mergeWorkspaceArchive } = await import('./workspaceMerge');
    const { undoLastWorkspaceMutation } = await import('./workspaceRestore');
    const createMergeArchive = (session: Session, revision: number) => (
      createWorkspaceArchive({
        revision,
        createdAt: revision,
        sessions: [session],
        settings: { theme: 'light', apiKey: '' },
        instructions,
        readBlob: async () => {
          throw new Error('No blobs are referenced.');
        }
      }, { reason: 'manual' })
    );

    await mergeWorkspaceArchive(
      handle,
      await createMergeArchive(createSession('Successful'), 20)
    );
    fileSystem.failNextWrite(/objects\/[a-f0-9]{64}\.json$/);
    await expect(mergeWorkspaceArchive(
      handle,
      await createMergeArchive(createSession('Failed'), 21)
    )).rejects.toThrow('Simulated disk full');

    await undoLastWorkspaceMutation(handle);
    await expect(readField('sessions')).resolves.toEqual(initialSessions);
  });
});

describe('unsupported local workspace contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('rejects canonical-file data without publishing an empty v5 workspace', async () => {
    const fileSystem = new MemoryFileSystem();
    const legacySessions = [createSession('Legacy')];
    await seedLegacyWorkspaceFiles(fileSystem, legacySessions);
    const originalSessions = await fileSystem.readText('data/sessions.json');
    const localStorage = new MemoryStorage();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('window', {
      electronAPI: {},
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

    const storage = await import('./storage');
    const handle = await storage.getStorageHandle();
    await expect(storage.synchronizeWorkspaceRevision(handle)).rejects.toThrow(
      'unsupported storage format'
    );
    expect(await fileSystem.readText('data/workspace_manifest_a.json')).toBeNull();
    expect(await fileSystem.readText('data/workspace_manifest_b.json')).toBeNull();
    expect(await fileSystem.readText('data/sessions.json')).toBe(originalSessions);
  });
});

describe('storage backend migration contracts', () => {
  let database: IDBDatabase;
  let fileSystem: MemoryFileSystem;
  let indexedDb: IDBFactory;
  let indexedDbRecords: IndexedDbRecord[];
  let localStorage: MemoryStorage;
  let storedSession: Session;
  let storedBlobHash: string;
  let storage: StorageModule;

  const backendIdentityKey = 'openai-studio-storage-backend-v1';

  const createCurrentIndexedDbRecords = async (): Promise<IndexedDbRecord[]> => {
    const blob = new Blob(['attachment bytes'], { type: 'text/plain' });
    storedBlobHash = await sha256Blob(blob);
    storedSession = createSession('IndexedDB', [{
      name: 'attachment.txt',
      type: 'text/plain',
      size: blob.size,
      localBlob: {
        sha256: storedBlobHash,
        byteSize: blob.size,
        mimeType: 'text/plain'
      }
    }]);
    const sessionText = JSON.stringify(storedSession);
    const settingsText = JSON.stringify({ theme: 'dark', apiKey: 'local-key' });
    const instructionsText = JSON.stringify(instructions);
    const projectsText = '[]';
    const remoteStateText = JSON.stringify({ indexes: {}, cleanupTombstones: [] });
    const objectReference = (text: string) => ({
      sha256: sha256Text(text),
      byteLength: encodeUtf8(text).byteLength
    });
    const manifest = {
      schemaVersion: 5,
      revision: 7,
      createdAt: 1,
      sessions: [{ id: storedSession.id, ...objectReference(sessionText) }],
      settings: objectReference(settingsText),
      instructions: objectReference(instructionsText),
      projects: objectReference(projectsText),
      projectRemoteState: objectReference(remoteStateText),
      blobs: [{ sha256: storedBlobHash, byteLength: blob.size }]
    };

    return [
      {
        filename: 'workspace_manifest_a.json',
        data: JSON.stringify(manifest),
        updatedAt: 2
      },
      ...[
        [manifest.sessions[0].sha256, sessionText],
        [manifest.settings.sha256, settingsText],
        [manifest.instructions.sha256, instructionsText],
        [manifest.projects.sha256, projectsText],
        [manifest.projectRemoteState.sha256, remoteStateText]
      ].map(([sha256, text]) => ({
        filename: `objects/${sha256}.json`,
        data: text as string,
        updatedAt: 2
      })),
      {
        filename: `blobs/${storedBlobHash}`,
        data: blob,
        updatedAt: 2
      }
    ];
  };

  beforeEach(async () => {
    fileSystem = new MemoryFileSystem();
    indexedDb = new IDBFactory();
    indexedDbRecords = await createCurrentIndexedDbRecords();
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

  it('copies a current workspace and reports its manifest revision before switching', async () => {
    const resolveBackendChoice = vi.fn().mockResolvedValue('migrate-to-opfs');

    const handle = await storage.getStorageHandle({ resolveBackendChoice });
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
    expect(JSON.parse(
      await fileSystem.readText('data/workspace_manifest_a.json') || ''
    )).toMatchObject({ schemaVersion: 5, revision: 7 });
    await expect(readWorkspaceField(storage, handle, 'settings')).resolves.toEqual({
      theme: 'dark',
      apiKey: 'local-key'
    });
    await expect(readWorkspaceField(storage, handle, 'sessions')).resolves.toEqual([storedSession]);
    expect(await fileSystem.readText(`data/blobs/${storedBlobHash}`))
      .toBe('attachment bytes');
    expect(await readIndexedDbRecord(database, 'workspace_manifest_a.json'))
      .toMatchObject({ data: indexedDbRecords[0].data });
  });

  it('rolls back every attempted OPFS record when migration copying fails', async () => {
    fileSystem.failNextWrite(/data\/objects\/[a-f0-9]{64}\.json$/);

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
    expect(await readIndexedDbRecord(database, 'workspace_manifest_a.json'))
      .toMatchObject({ data: indexedDbRecords[0].data });
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
