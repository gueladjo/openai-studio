import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, Project, ProjectRemoteState, ProjectSource } from '../types';
import { MAX_INDEXED_USAGE_BYTES } from '../utils/projectSources';
import {
  ProjectSourceService,
  classifyProjectSourceError,
  createEmptyProjectRemoteState,
  fingerprintApiKey,
  getProjectSourceAvailability,
} from './projectSourceService';

const fingerprint = 'a'.repeat(64);
const source: ProjectSource = {
  id: 'source-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  byteSize: 5,
  localBlob: {
    sha256: 'b'.repeat(64),
    byteSize: 5,
    mimeType: 'text/plain'
  },
  capability: 'file_search',
  addedAt: 1
};
const project: Project = {
  id: 'project-1',
  name: 'Research',
  icon: 'research',
  instructions: 'Use the project evidence.',
  defaultConfig: {
    model: DEFAULT_CONFIG.model,
    reasoningEffort: DEFAULT_CONFIG.reasoningEffort,
    textVerbosity: DEFAULT_CONFIG.textVerbosity,
    tools: DEFAULT_CONFIG.tools
  },
  sources: [source],
  createdAt: 1,
  updatedAt: 1
};

const createClient = () => ({
  files: {
    create: vi.fn().mockResolvedValue({ id: 'file-new' }),
    delete: vi.fn().mockResolvedValue({ deleted: true }),
    retrieve: vi.fn().mockResolvedValue({ id: 'file-new' })
  },
  vectorStores: {
    create: vi.fn().mockResolvedValue({
      id: 'vector-1',
      status: 'completed',
      usage_bytes: 0
    }),
    retrieve: vi.fn().mockResolvedValue({
      id: 'vector-1',
      status: 'completed',
      usage_bytes: 100
    }),
    delete: vi.fn().mockResolvedValue({ deleted: true }),
    files: {
      createAndPoll: vi.fn().mockResolvedValue({
        status: 'completed',
        usage_bytes: 100
      }),
      retrieve: vi.fn().mockResolvedValue({
        status: 'completed',
        usage_bytes: 100
      })
    }
  }
});

describe('project source service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates one lazy vector store and durably advances a searchable source to ready', async () => {
    const client = createClient();
    const persist = vi.fn(async () => undefined);
    const service = new ProjectSourceService('key', client as never);

    const state = await service.ingestSource({
      project,
      source,
      blob: new Blob(['notes'], { type: 'text/plain' }),
      state: createEmptyProjectRemoteState(),
      apiKeyFingerprint: fingerprint,
      persist
    });

    expect(client.vectorStores.create).toHaveBeenCalledTimes(1);
    expect(client.files.create).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'assistants'
    }));
    expect(client.vectorStores.files.createAndPoll).toHaveBeenCalledWith(
      'vector-1',
      expect.objectContaining({ file_id: 'file-new' })
    );
    expect(state.indexes[project.id]).toMatchObject({
      vectorStoreId: 'vector-1',
      status: 'ready',
      usageBytes: 100,
      files: {
        [source.id]: {
          openaiFileId: 'file-new',
          status: 'ready',
          indexedUsageBytes: 100
        }
      }
    });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      indexes: expect.any(Object)
    }));
  });

  it('uploads analysis sources without creating a vector store', async () => {
    const client = createClient();
    const analysisSource: ProjectSource = {
      ...source,
      id: 'source-analysis',
      name: 'metrics.csv',
      mimeType: 'text/csv',
      capability: 'code_interpreter'
    };
    const analysisProject = { ...project, sources: [analysisSource] };
    const service = new ProjectSourceService('key', client as never);

    const state = await service.ingestSource({
      project: analysisProject,
      source: analysisSource,
      blob: new Blob(['value\n1'], { type: 'text/csv' }),
      state: createEmptyProjectRemoteState(),
      apiKeyFingerprint: fingerprint,
      persist: async () => undefined
    });

    expect(client.vectorStores.create).not.toHaveBeenCalled();
    expect(client.vectorStores.files.createAndPoll).not.toHaveBeenCalled();
    expect(state.indexes[analysisProject.id].files[analysisSource.id])
      .toMatchObject({ openaiFileId: 'file-new', status: 'ready' });
  });

  it('deletes a failed source File before uploading its retry', async () => {
    const client = createClient();
    const service = new ProjectSourceService('key', client as never);
    const state: ProjectRemoteState = {
      indexes: {
        [project.id]: {
          projectId: project.id,
          apiKeyFingerprint: fingerprint,
          vectorStoreId: 'vector-1',
          status: 'failed',
          usageBytes: 10,
          files: {
            [source.id]: {
              projectSourceId: source.id,
              openaiFileId: 'file-old',
              status: 'failed'
            }
          }
        }
      },
      cleanupTombstones: []
    };

    await service.ingestSource({
      project,
      source,
      blob: new Blob(['notes']),
      state,
      apiKeyFingerprint: fingerprint,
      persist: async () => undefined
    });

    expect(client.files.delete).toHaveBeenCalledWith('file-old');
    expect(client.files.delete.mock.invocationCallOrder[0])
      .toBeLessThan(client.files.create.mock.invocationCallOrder[0]);
  });

  it('rolls back the new File when actual indexed usage exceeds 900 MiB', async () => {
    const client = createClient();
    client.vectorStores.retrieve.mockResolvedValue({
      id: 'vector-1',
      status: 'completed',
      usage_bytes: MAX_INDEXED_USAGE_BYTES + 1
    });
    const persisted: ProjectRemoteState[] = [];
    const service = new ProjectSourceService('key', client as never);

    await expect(service.ingestSource({
      project,
      source,
      blob: new Blob(['notes']),
      state: createEmptyProjectRemoteState(),
      apiKeyFingerprint: fingerprint,
      persist: async state => { persisted.push(state); }
    })).rejects.toMatchObject({ kind: 'quota' });

    expect(client.files.delete).toHaveBeenCalledWith('file-new');
    expect(persisted.at(-1)?.indexes[project.id].files[source.id]).toMatchObject({
      status: 'failed'
    });
    expect(persisted.at(-1)?.indexes[project.id].files[source.id].openaiFileId)
      .toBeUndefined();
  });

  it('persists a terminal indexing failure with the uploaded File available for cleanup', async () => {
    const client = createClient();
    client.vectorStores.files.createAndPoll.mockResolvedValue({
      status: 'failed',
      usage_bytes: 0,
      last_error: {
        code: 'unsupported_file',
        message: 'This file cannot be indexed.'
      }
    });
    const persisted: ProjectRemoteState[] = [];
    const service = new ProjectSourceService('key', client as never);

    await expect(service.ingestSource({
      project,
      source,
      blob: new Blob(['notes']),
      state: createEmptyProjectRemoteState(),
      apiKeyFingerprint: fingerprint,
      persist: async state => { persisted.push(state); }
    })).rejects.toMatchObject({ kind: 'unsupported_format' });

    expect(persisted.at(-1)?.indexes[project.id].files[source.id]).toMatchObject({
      openaiFileId: 'file-new',
      status: 'failed',
      lastError: 'This file cannot be indexed.'
    });
  });

  it('keeps direct-attachment sources local without creating remote resources', async () => {
    const client = createClient();
    const directSource: ProjectSource = {
      ...source,
      id: 'source-image',
      name: 'diagram.png',
      mimeType: 'image/png',
      capability: 'direct_attachment'
    };
    const state = createEmptyProjectRemoteState();
    const service = new ProjectSourceService('key', client as never);

    await expect(service.ingestSource({
      project: { ...project, sources: [directSource] },
      source: directSource,
      blob: new Blob(['image'], { type: 'image/png' }),
      state,
      apiKeyFingerprint: fingerprint,
      persist: async () => undefined
    })).resolves.toBe(state);

    expect(client.files.create).not.toHaveBeenCalled();
    expect(client.vectorStores.create).not.toHaveBeenCalled();
  });

  it('deletes every File before its vector store and treats 404 as success', async () => {
    const client = createClient();
    client.files.delete
      .mockResolvedValueOnce({ deleted: true })
      .mockRejectedValueOnce({ status: 404, message: 'Not found' });
    const service = new ProjectSourceService('key', client as never);
    const state: ProjectRemoteState = {
      indexes: {},
      cleanupTombstones: [{
        id: 'cleanup-1',
        projectId: project.id,
        apiKeyFingerprint: fingerprint,
        openaiFileIds: ['file-1', 'file-2'],
        vectorStoreId: 'vector-1',
        createdAt: 1
      }]
    };

    const cleaned = await service.runCleanup(
      state,
      'cleanup-1',
      async () => undefined
    );

    expect(client.files.delete).toHaveBeenNthCalledWith(1, 'file-1');
    expect(client.files.delete).toHaveBeenNthCalledWith(2, 'file-2');
    expect(client.files.delete.mock.invocationCallOrder[1])
      .toBeLessThan(client.vectorStores.delete.mock.invocationCallOrder[0]);
    expect(cleaned.cleanupTombstones).toEqual([]);
  });

  it('keeps cleanup durable when authentication fails', async () => {
    const client = createClient();
    client.files.delete.mockRejectedValue({ status: 401, message: 'Invalid key.' });
    const persisted: ProjectRemoteState[] = [];
    const service = new ProjectSourceService('key', client as never);
    const state: ProjectRemoteState = {
      indexes: {},
      cleanupTombstones: [{
        id: 'cleanup-auth',
        apiKeyFingerprint: fingerprint,
        openaiFileIds: ['file-1'],
        createdAt: 1
      }]
    };

    await expect(service.runCleanup(
      state,
      'cleanup-auth',
      async next => { persisted.push(next); }
    )).rejects.toMatchObject({ kind: 'authentication' });

    expect(persisted.at(-1)?.cleanupTombstones).toEqual([
      expect.objectContaining({ id: 'cleanup-auth', lastError: 'Invalid key.' })
    ]);
  });

  it('reconciles an upload interrupted before its File ID was saved', async () => {
    const client = createClient();
    const service = new ProjectSourceService('key', client as never);
    const state: ProjectRemoteState = {
      indexes: {
        [project.id]: {
          projectId: project.id,
          apiKeyFingerprint: fingerprint,
          status: 'creating',
          usageBytes: 0,
          files: {
            [source.id]: {
              projectSourceId: source.id,
              status: 'uploading'
            }
          }
        }
      },
      cleanupTombstones: []
    };

    const reconciled = await service.reconcile(
      [project],
      state,
      fingerprint,
      async () => undefined
    );

    expect(reconciled.indexes[project.id].files[source.id]).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('interrupted')
    });
    expect(client.files.create).not.toHaveBeenCalled();
  });

  it('blocks source context when the vector store is disconnected', () => {
    const state: ProjectRemoteState = {
      indexes: {
        [project.id]: {
          projectId: project.id,
          apiKeyFingerprint: fingerprint,
          status: 'disconnected',
          usageBytes: 0,
          files: {
            [source.id]: {
              projectSourceId: source.id,
              openaiFileId: 'file-1',
              status: 'ready'
            }
          }
        }
      },
      cleanupTombstones: []
    };
    const apiKey = 'matching-key';
    state.indexes[project.id].apiKeyFingerprint = fingerprintApiKey(apiKey);

    const availability = getProjectSourceAvailability(project, state, apiKey);
    expect(availability).toMatchObject({
      expected: true,
      ready: false,
      reason: 'The project search index is unavailable.'
    });
  });

  it.each([
    [{ status: 401, message: 'Bad key' }, 'authentication'],
    [{ status: 429, message: 'Quota exhausted' }, 'quota'],
    [{ status: 500, message: 'Try again' }, 'retryable'],
    [{ status: 400, code: 'unsupported_file', message: 'Unsupported' }, 'unsupported_format']
  ] as const)('classifies remote failures', (error, kind) => {
    expect(classifyProjectSourceError(error).kind).toBe(kind);
  });
});
