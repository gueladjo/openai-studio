import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('round-trips writes with monotonic revisions and recovery copies', async () => {
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
    expect(JSON.parse(
      await fileSystem.readText('data/settings.json.bak') || ''
    )).toEqual({
      theme: 'dark',
      apiKey: 'first-key'
    });
    expect(JSON.parse(
      await fileSystem.readText('data/workspace_manifest.json') || ''
    ).revision).toBe(2);
    expect(JSON.parse(
      await fileSystem.readText('data/workspace_manifest.json.bak') || ''
    ).revision).toBe(1);
    expect(storage.getWorkspaceRevision()).toBe(2);
  });

  it('rejects a stale writer before overwriting workspace data', async () => {
    await fileSystem.writeText(
      'data/workspace_manifest.json',
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        files: {
          sessions: 'sessions.json',
          settings: 'settings.json',
          instructions: 'system_instructions.json'
        }
      })
    );

    await expect(storage.writeJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS,
      { theme: 'dark', apiKey: 'must-not-write' }
    )).rejects.toMatchObject({
      name: 'WorkspaceRevisionConflictError',
      expectedRevision: 0,
      actualRevision: 1
    });
    expect(await fileSystem.readText('data/settings.json')).toBeNull();
  });

  it('recovers a corrupt active snapshot through the previous manifest', async () => {
    const initialSessions = [createSession('Initial')];
    const replacementSessions = [createSession('Replacement')];
    await seedWorkspace(initialSessions);
    await storage.restoreWorkspaceBackup(
      handle,
      createBackup(replacementSessions)
    );

    const manifest = JSON.parse(
      await fileSystem.readText('data/workspace_manifest.json') || ''
    );
    expect(await storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).toEqual(replacementSessions);

    await fileSystem.writeText(
      `data/${manifest.files.sessions}`,
      '{"not":"sessions"}'
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).resolves.toEqual(initialSessions);

    await fileSystem.writeText('data/sessions.json', '{"also":"invalid"}');
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).rejects.toThrow('sessions must be an array');
    warn.mockRestore();
  });

  it('round-trips attachments while excluding and preserving API keys correctly', async () => {
    const attachmentId = await storage.storeAttachment(
      handle,
      new File(['private notes'], 'notes.txt', { type: 'text/plain' })
    );
    const originalSessions = [createSession('Attached', [{
      id: attachmentId,
      name: 'notes.txt',
      type: 'text/plain',
      size: 13
    }])];
    await seedWorkspace(originalSessions);

    const backup = await storage.getWorkspaceBackup(handle);
    expect(backup.settings).toEqual({
      theme: 'dark',
      lastActiveSessionId: originalSessions[0].id
    });
    expect(backup.sessions[0].messages[0].attachments?.[0]).toMatchObject({
      id: attachmentId,
      name: 'notes.txt',
      type: 'text/plain',
      content: 'data:text/plain;base64,cHJpdmF0ZSBub3Rlcw=='
    });

    await storage.writeJsonFile(handle, storage.STORAGE_FILES.SETTINGS, {
      theme: 'light',
      apiKey: 'current-key',
      lastActiveSessionId: originalSessions[0].id
    });
    await storage.restoreWorkspaceBackup(handle, backup);

    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SETTINGS
    )).resolves.toEqual({
      theme: 'dark',
      apiKey: 'current-key',
      lastActiveSessionId: originalSessions[0].id
    });
    const storedSessions = await storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    );
    const restoredAttachment = storedSessions?.[0].messages[0].attachments?.[0];
    expect(restoredAttachment).toMatchObject({
      name: 'notes.txt',
      type: 'text/plain',
      size: 13
    });
    expect(restoredAttachment?.id).not.toBe(attachmentId);
    expect(restoredAttachment).not.toHaveProperty('content');
    await expect(storage.getAttachmentDataUrl(
      handle,
      restoredAttachment!
    )).resolves.toBe(
      'data:text/plain;base64,cHJpdmF0ZSBub3Rlcw=='
    );
  });

  it('keeps the active workspace and removes staged data after a restore write fails', async () => {
    const initialSessions = [createSession('Initial')];
    await seedWorkspace(initialSessions);
    const manifestBefore = await fileSystem.readText(
      'data/workspace_manifest.json'
    );
    const dataDirectory = await fileSystem.getDirectory('data');
    const namesBefore = dataDirectory.names();
    fileSystem.failNextWrite(
      /workspace_snapshot_.*_settings\.json$/
    );
    const replacementSessions = [createSession('Replacement', [{
      name: 'replacement.txt',
      type: 'text/plain',
      size: 11,
      content: 'data:text/plain;base64,cmVwbGFjZW1lbnQ='
    }])];

    await expect(storage.restoreWorkspaceBackup(
      handle,
      createBackup(replacementSessions)
    )).rejects.toThrow('Simulated disk full');

    expect(await fileSystem.readText(
      'data/workspace_manifest.json'
    )).toBe(manifestBefore);
    expect(
      dataDirectory.names().filter(name => name !== 'attachments')
    ).toEqual(namesBefore);
    expect(
      dataDirectory.names().some(name => name.startsWith('workspace_snapshot_'))
    ).toBe(false);
    await expect(storage.readJsonFile(
      handle,
      storage.STORAGE_FILES.SESSIONS
    )).resolves.toEqual(initialSessions);
    const attachmentsDirectory = await fileSystem.getDirectory(
      'data/attachments'
    );
    expect(attachmentsDirectory.names()).toEqual([]);
  });
});
