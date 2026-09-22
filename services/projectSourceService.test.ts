import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectFixture } from '../test/fixtures';
import { ProjectRemoteState, ProjectSource } from '../types';
import { MAX_INDEXED_USAGE_BYTES } from '../utils/projectSources';
import {
  ProjectSourceService,
  classifyProjectSourceError,
  createEmptyProjectRemoteState,
  fingerprintApiKey,
  getProjectSourceAvailability,
  resolveProjectContext,
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
const project = projectFixture({
  instructions: 'Use the project evidence.',
  sources: [source]
});

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
    list: vi.fn(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> { /* no stores */ }
    })),
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

const createInterruptedState = (): ProjectRemoteState => ({
  indexes: {
    [project.id]: {
      projectId: project.id,
      apiKeyFingerprint: fingerprint,
      vectorStoreId: 'vector-1',
      status: 'creating',
      usageBytes: 0,
      files: { [source.id]: {
        projectSourceId: source.id,
        openaiFileId: 'file-interrupted',
        status: 'indexing'
      } }
    },
    'other-project': {
      projectId: 'other-project',
      apiKeyFingerprint: fingerprint,
      vectorStoreId: 'vector-other',
      status: 'ready',
      usageBytes: 0,
      files: {}
    }
  },
  cleanupTombstones: []
});

describe('project source service', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([0, 1])('checks fresh aggregate usage before recovering a completed index: excess %i', async excess => {
    const client = createClient();
    client.vectorStores.retrieve.mockImplementation(async id => ({
      id, status: 'completed',
      usage_bytes: id === 'vector-1' ? 100 : MAX_INDEXED_USAGE_BYTES - 100 + excess
    }));
    const state = createInterruptedState();
    state.indexes['other-key'] = {
      projectId: 'other-key', apiKeyFingerprint: 'different-key',
      vectorStoreId: 'vector-other-key', status: 'ready',
      usageBytes: MAX_INDEXED_USAGE_BYTES, files: {}
    };
    const persisted: ProjectRemoteState[] = [];
    const service = new ProjectSourceService('key', client as never);
    const next = await service.reconcile([project], state, fingerprint, async update => {
      persisted.push(structuredClone(update));
    });

    expect(client.vectorStores.retrieve).toHaveBeenCalledWith('vector-other');
    expect(client.vectorStores.retrieve).not.toHaveBeenCalledWith('vector-other-key');
    expect(next.indexes['other-project'].usageBytes)
      .toBe(MAX_INDEXED_USAGE_BYTES - 100 + excess);
    const recovered = next.indexes[project.id].files[source.id];
    if (excess) {
      expect(recovered).toMatchObject({ status: 'failed', lastError: expect.stringContaining('900 MiB') });
      expect(recovered.openaiFileId).toBeUndefined();
      expect(client.files.delete).toHaveBeenCalledExactlyOnceWith('file-interrupted');
      expect(persisted.every(update => update.indexes[project.id].files[source.id].status !== 'ready'))
        .toBe(true);
    } else {
      expect(recovered).toMatchObject({ status: 'ready', openaiFileId: 'file-interrupted', indexedUsageBytes: 100 });
      expect(client.files.delete).not.toHaveBeenCalled();
    }
    expect(state.indexes[project.id].files[source.id].status).toBe('indexing');
  });

  it('keeps an over-limit recovered File recorded and unavailable when rollback fails', async () => {
    const client = createClient();
    client.vectorStores.retrieve.mockResolvedValue({
      id: 'vector-1', status: 'completed', usage_bytes: MAX_INDEXED_USAGE_BYTES
    });
    const persist = vi.fn(async (_state: ProjectRemoteState) => undefined);
    client.files.delete.mockImplementation(async () => {
      expect(persist.mock.calls.at(-1)?.[0].indexes[project.id].files[source.id])
        .toMatchObject({ status: 'failed', openaiFileId: 'file-interrupted' });
      throw { status: 503, message: 'Cleanup unavailable.' };
    });
    const service = new ProjectSourceService('key', client as never);
    const next = await service.reconcile([project], createInterruptedState(), fingerprint, persist);
    expect(next.indexes[project.id].files[source.id]).toMatchObject({
      status: 'failed', openaiFileId: 'file-interrupted',
      lastError: expect.stringContaining('Cleanup unavailable.')
    });
    const reloaded = await service.reconcile([project], next, fingerprint, persist);
    expect(reloaded.indexes[project.id].files[source.id].status).toBe('failed');
    expect(client.vectorStores.files.retrieve).toHaveBeenCalledOnce();
  });

  it('refuses recovery when another managed store usage cannot be verified', async () => {
    const client = createClient();
    client.vectorStores.retrieve.mockImplementation(async id => {
      if (id === 'vector-other') throw { status: 503, message: 'Usage unavailable.' };
      return { id, status: 'completed', usage_bytes: 100 };
    });
    const service = new ProjectSourceService('key', client as never);
    const next = await service.reconcile([project], createInterruptedState(), fingerprint, async () => undefined);
    expect(next.indexes[project.id].files[source.id]).toMatchObject({
      status: 'failed', openaiFileId: 'file-interrupted', lastError: 'Usage unavailable.'
    });
    expect(client.files.delete).not.toHaveBeenCalled();
  });

  it('rechecks other managed stores after live indexing completes', async () => {
    const client = createClient();
    let completed = false;
    client.vectorStores.files.createAndPoll.mockImplementation(async () => {
      completed = true;
      return { status: 'completed', usage_bytes: 100 };
    });
    client.vectorStores.retrieve.mockImplementation(async id => ({
      id, status: 'completed',
      usage_bytes: !completed ? 0 : id === 'vector-1' ? 100 : MAX_INDEXED_USAGE_BYTES
    }));
    const state = createInterruptedState();
    state.indexes[project.id].files = {};
    const service = new ProjectSourceService('key', client as never);
    await expect(service.ingestSource({
      project, source, blob: new Blob(['notes']), state,
      apiKeyFingerprint: fingerprint, persist: async () => undefined
    })).rejects.toMatchObject({ kind: 'quota' });
    expect(client.files.delete).toHaveBeenCalledExactlyOnceWith('file-new');
  });

  it('preserves the File ID without deleting if quota rejection cannot be journaled', async () => {
    const client = createClient();
    client.vectorStores.retrieve.mockResolvedValue({
      id: 'vector-1', status: 'completed', usage_bytes: MAX_INDEXED_USAGE_BYTES
    });
    const service = new ProjectSourceService('key', client as never);
    let rejectJournal = true;
    const next = await service.reconcile([project], createInterruptedState(), fingerprint, async state => {
      if (rejectJournal && state.indexes[project.id].files[source.id].status === 'failed') {
        rejectJournal = false;
        throw new Error('Quota rejection could not be saved.');
      }
    });
    expect(client.files.delete).not.toHaveBeenCalled();
    expect(next.indexes[project.id].files[source.id]).toMatchObject({
      status: 'failed', openaiFileId: 'file-interrupted',
      lastError: 'Quota rejection could not be saved.'
    });
  });

  it('ingests when another project\'s vector store no longer exists', async () => {
    const client = createClient();
    client.vectorStores.retrieve.mockImplementation(async id => {
      if (id === 'vector-other') {
        throw { status: 404, message: 'No vector store found with id vector-other.' };
      }
      return { id, status: 'completed', usage_bytes: 100 };
    });
    const state = createInterruptedState();
    state.indexes[project.id].files = {};
    const service = new ProjectSourceService('key', client as never);

    const next = await service.ingestSource({
      project, source, blob: new Blob(['notes']), state,
      apiKeyFingerprint: fingerprint, persist: async () => undefined
    });

    expect(next.indexes[project.id].files[source.id]).toMatchObject({
      status: 'ready', openaiFileId: 'file-new'
    });
    expect(next.indexes['other-project']).toMatchObject({ status: 'disconnected', usageBytes: 0 });
    expect(next.indexes['other-project'].vectorStoreId).toBeUndefined();
  });

  it('keeps another project\'s analysis files ready when its vector store no longer exists', async () => {
    const client = createClient();
    client.vectorStores.retrieve.mockImplementation(async id => {
      if (id === 'vector-other') {
        throw { status: 404, message: 'No vector store found with id vector-other.' };
      }
      return { id, status: 'completed', usage_bytes: 100 };
    });
    const otherSearch: ProjectSource = { ...source, id: 'other-search' };
    const otherAnalysis: ProjectSource = {
      ...source, id: 'other-analysis', name: 'data.csv', capability: 'code_interpreter'
    };
    const other = projectFixture({ id: 'other-project', sources: [otherSearch, otherAnalysis] });
    const state = createInterruptedState();
    state.indexes[project.id].files = {};
    state.indexes[other.id].files = {
      [otherSearch.id]: { projectSourceId: otherSearch.id, openaiFileId: 'file-os', status: 'ready' },
      [otherAnalysis.id]: { projectSourceId: otherAnalysis.id, openaiFileId: 'file-oa', status: 'ready' }
    };
    const service = new ProjectSourceService('key', client as never);

    const next = await service.ingestSource({
      project, source, blob: new Blob(['notes']), state,
      apiKeyFingerprint: fingerprint, persist: async () => undefined,
      projects: [project, other]
    });

    expect(next.indexes[other.id]).toMatchObject({ status: 'disconnected', usageBytes: 0 });
    expect(next.indexes[other.id].files[otherSearch.id].status).toBe('failed');
    expect(next.indexes[other.id].files[otherAnalysis.id]).toMatchObject({
      status: 'ready', openaiFileId: 'file-oa'
    });
  });

  it('adopts an empty store created for the project whose ID was never saved instead of creating another', async () => {
    const client = createClient();
    const managed = (id: string, total: number, projectId = project.id) => ({
      id, status: 'completed', usage_bytes: 0, created_at: 1,
      file_counts: { total, completed: total, failed: 0, cancelled: 0, in_progress: 0 },
      metadata: { application: 'openai-studio', project_id: projectId }
    });
    const stores = [
      { ...managed('vector-foreign', 0), metadata: null },
      managed('vector-other-project', 0, 'other-project'),
      managed('vector-referenced', 0),
      managed('vector-populated', 2),
      managed('vector-orphan', 0),
      managed('vector-older-orphan', 0)
    ];
    client.vectorStores.list.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() { yield* stores; }
    }));
    const state = createEmptyProjectRemoteState();
    state.indexes[project.id] = {
      projectId: project.id, apiKeyFingerprint: fingerprint, status: 'creating', usageBytes: 0, files: {}
    };
    state.cleanupTombstones = [{
      id: 'tombstone-1', projectId: 'deleted-project', apiKeyFingerprint: fingerprint,
      openaiFileIds: [], vectorStoreId: 'vector-referenced', createdAt: 1
    }];
    const service = new ProjectSourceService('key', client as never);

    const next = await service.ingestSource({
      project, source, blob: new Blob(['notes']), state,
      apiKeyFingerprint: fingerprint, persist: async () => undefined
    });

    expect(client.vectorStores.create).not.toHaveBeenCalled();
    expect(next.indexes[project.id]).toMatchObject({ vectorStoreId: 'vector-orphan', status: 'ready' });
    expect(client.vectorStores.files.createAndPoll).toHaveBeenCalledWith(
      'vector-orphan', expect.objectContaining({ file_id: 'file-new' })
    );
    expect(next.indexes[project.id].files[source.id]).toMatchObject({ status: 'ready' });
  });

  it('creates a store for a fresh index without scanning for orphans', async () => {
    const client = createClient();
    const service = new ProjectSourceService('key', client as never);

    await service.ingestSource({
      project, source, blob: new Blob(['notes']), state: createEmptyProjectRemoteState(),
      apiKeyFingerprint: fingerprint, persist: async () => undefined
    });

    expect(client.vectorStores.list).not.toHaveBeenCalled();
    expect(client.vectorStores.create).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('reconciles an interrupted store creation (orphan found: %s)', async found => {
    const client = createClient();
    client.vectorStores.list.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        if (found) {
          yield {
            id: 'vector-orphan', status: 'completed', usage_bytes: 0, created_at: 1,
            file_counts: { total: 0, completed: 0, failed: 0, cancelled: 0, in_progress: 0 },
            metadata: { application: 'openai-studio', project_id: project.id }
          };
        }
      }
    }));
    const state = createEmptyProjectRemoteState();
    state.indexes[project.id] = {
      projectId: project.id, apiKeyFingerprint: fingerprint, status: 'creating', usageBytes: 0,
      files: { [source.id]: { projectSourceId: source.id, status: 'uploading' } }
    };
    const service = new ProjectSourceService('key', client as never);

    const next = await service.reconcile([project], state, fingerprint, async () => undefined);

    expect(client.vectorStores.create).not.toHaveBeenCalled();
    if (found) {
      expect(next.indexes[project.id]).toMatchObject({ vectorStoreId: 'vector-orphan', status: 'ready' });
    } else {
      expect(next.indexes[project.id].status).toBe('disconnected');
      expect(next.indexes[project.id].vectorStoreId).toBeUndefined();
    }
    expect(next.indexes[project.id].files[source.id]).toMatchObject({
      status: 'failed', lastError: expect.stringContaining('interrupted')
    });
  });

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

  it('excludes removed source IDs from search while their remote cleanup is pending', async () => {
    const client = createClient();
    client.files.delete.mockRejectedValue({ status: 503, message: 'Try again' });
    const apiKey = 'matching-key';
    const state: ProjectRemoteState = {
      indexes: {
        [project.id]: {
          projectId: project.id,
          apiKeyFingerprint: fingerprintApiKey(apiKey),
          vectorStoreId: 'vector-1',
          status: 'ready',
          usageBytes: 100,
          files: {
            [source.id]: { projectSourceId: source.id, openaiFileId: 'file-kept', status: 'ready' }
          }
        }
      },
      cleanupTombstones: [{
        id: 'cleanup-removed',
        projectId: project.id,
        projectSourceId: 'source-removed',
        apiKeyFingerprint: fingerprintApiKey(apiKey),
        openaiFileIds: ['file-removed'],
        createdAt: 1
      }]
    };
    let persisted = state;
    await expect(new ProjectSourceService(apiKey, client as never).runCleanup(
      state, 'cleanup-removed', async next => { persisted = next; }
    )).rejects.toThrow('Try again');
    expect(persisted.cleanupTombstones).toHaveLength(1);
    expect(getProjectSourceAvailability(project, persisted, apiKey).ready).toBe(true);
    expect(resolveProjectContext(project, persisted, apiKey)).toMatchObject({
      vectorStoreId: 'vector-1',
      searchSourceIds: [source.id]
    });
    expect(resolveProjectContext(project, persisted, 'different-key').searchSourceIds).toEqual([]);
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

  it('keeps the search index ready when one source is rejected', async () => {
    const client = createClient();
    const rejected: ProjectSource = { ...source, id: 'source-rejected', name: 'broken.pdf' };
    const twoSources = projectFixture({ sources: [source, rejected] });
    const apiKey = 'matching-key';
    const service = new ProjectSourceService(apiKey, client as never);
    let state = await service.ingestSource({
      project: twoSources, source, blob: new Blob(['notes']),
      state: createEmptyProjectRemoteState(),
      apiKeyFingerprint: fingerprintApiKey(apiKey), persist: async () => undefined
    });
    client.vectorStores.files.createAndPoll.mockResolvedValueOnce({
      status: 'failed', usage_bytes: 0,
      last_error: { code: 'unsupported_file', message: 'Unsupported file.' }
    });

    await expect(service.ingestSource({
      project: twoSources, source: rejected, blob: new Blob(['broken']), state,
      apiKeyFingerprint: fingerprintApiKey(apiKey), persist: async next => { state = next; }
    })).rejects.toMatchObject({ kind: 'unsupported_format' });

    expect(state.indexes[twoSources.id]).toMatchObject({ status: 'ready', vectorStoreId: 'vector-1' });
    expect(getProjectSourceAvailability(twoSources, state, apiKey).reason).toBe('broken.pdf: failed.');
    // Deleting the rejected source leaves the remaining source searchable.
    const remaining = projectFixture({ sources: [source] });
    expect(getProjectSourceAvailability(remaining, state, apiKey)).toEqual({ expected: true, ready: true });
    expect(resolveProjectContext(remaining, state, apiKey).vectorStoreId).toBe('vector-1');
  });

  it('keeps ready search sources available across a failed analysis upload and its retry', async () => {
    const client = createClient();
    const analysis: ProjectSource = {
      ...source, id: 'source-analysis', name: 'data.csv', mimeType: 'text/csv', capability: 'code_interpreter'
    };
    const mixed = projectFixture({ sources: [source, analysis] });
    const apiKey = 'matching-key';
    const service = new ProjectSourceService(apiKey, client as never);
    let state = await service.ingestSource({
      project: mixed, source, blob: new Blob(['notes']),
      state: createEmptyProjectRemoteState(),
      apiKeyFingerprint: fingerprintApiKey(apiKey), persist: async () => undefined
    });
    client.files.create.mockRejectedValueOnce({ status: 503, message: 'Upload failed.' });

    await expect(service.ingestSource({
      project: mixed, source: analysis, blob: new Blob(['a,b']), state,
      apiKeyFingerprint: fingerprintApiKey(apiKey), persist: async next => { state = next; }
    })).rejects.toMatchObject({ kind: 'retryable' });
    expect(state.indexes[mixed.id].status).toBe('ready');

    state = await service.ingestSource({
      project: mixed, source: analysis, blob: new Blob(['a,b']), state,
      apiKeyFingerprint: fingerprintApiKey(apiKey), persist: async () => undefined
    });
    expect(getProjectSourceAvailability(mixed, state, apiKey)).toEqual({ expected: true, ready: true });
    expect(resolveProjectContext(mixed, state, apiKey)).toMatchObject({
      vectorStoreId: 'vector-1', analysisFileIds: ['file-new'], searchSourceIds: [source.id]
    });
  });

  it('marks the index failed only when its vector store cannot be created', async () => {
    const client = createClient();
    client.vectorStores.create.mockRejectedValueOnce({ status: 500, message: 'Store unavailable.' });
    const apiKey = 'matching-key';
    const service = new ProjectSourceService(apiKey, client as never);
    let state = createEmptyProjectRemoteState();

    await expect(service.ingestSource({
      project, source, blob: new Blob(['notes']), state,
      apiKeyFingerprint: fingerprintApiKey(apiKey), persist: async next => { state = next; }
    })).rejects.toMatchObject({ kind: 'retryable' });

    expect(state.indexes[project.id].status).toBe('failed');
    expect(state.indexes[project.id].vectorStoreId).toBeUndefined();
    expect(state.indexes[project.id].files[source.id].status).toBe('failed');
    expect(getProjectSourceAvailability(project, state, apiKey).reason).toBe('notes.txt: failed.');
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
