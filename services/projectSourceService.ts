import OpenAI from 'openai';
import {
  Project,
  ProjectRemoteIndex,
  ProjectRemoteState,
  ProjectSource,
  RemoteCleanupTombstone,
  ResolvedProjectContext
} from '../types';
import { sha256Text } from './contentAddressing';
import { MAX_INDEXED_USAGE_BYTES } from '../utils/projectSources';

export type ProjectSourceErrorKind =
  | 'authentication'
  | 'quota'
  | 'unsupported_format'
  | 'retryable'
  | 'terminal';

export class ProjectSourceServiceError extends Error {
  constructor(
    message: string,
    readonly kind: ProjectSourceErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ProjectSourceServiceError';
  }
}

type ProjectSourceClient = Pick<OpenAI, 'files' | 'vectorStores'>;
type PersistRemoteState = (state: ProjectRemoteState) => Promise<void>;

const cloneState = (state: ProjectRemoteState): ProjectRemoteState => (
  JSON.parse(JSON.stringify(state)) as ProjectRemoteState
);

const getErrorDetails = (error: unknown): {
  message: string;
  status?: number;
  code?: string;
} => {
  if (typeof error !== 'object' || error === null) {
    return { message: String(error) };
  }
  const value = error as Record<string, unknown>;
  const nested = typeof value.error === 'object' && value.error !== null
    ? value.error as Record<string, unknown>
    : undefined;
  return {
    message: (
      typeof value.message === 'string'
        ? value.message
        : typeof nested?.message === 'string'
          ? nested.message
          : 'Project source operation failed.'
    ),
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
    ...(typeof value.code === 'string'
      ? { code: value.code }
      : typeof nested?.code === 'string'
        ? { code: nested.code }
        : {})
  };
};

export const classifyProjectSourceError = (
  error: unknown
): ProjectSourceServiceError => {
  if (error instanceof ProjectSourceServiceError) return error;
  const details = getErrorDetails(error);
  const normalized = `${details.code || ''} ${details.message}`.toLowerCase();
  let kind: ProjectSourceErrorKind = 'terminal';
  if (details.status === 401 || details.status === 403) kind = 'authentication';
  else if (details.status === 429 || normalized.includes('quota')) kind = 'quota';
  else if (
    normalized.includes('unsupported_file') ||
    normalized.includes('unsupported file') ||
    normalized.includes('invalid_file')
  ) kind = 'unsupported_format';
  else if (
    details.status === undefined ||
    details.status >= 500 ||
    details.status === 408 ||
    details.status === 409
  ) kind = 'retryable';
  return new ProjectSourceServiceError(details.message, kind, details.status);
};

export const isAlreadyDeletedError = (error: unknown): boolean => (
  getErrorDetails(error).status === 404
);

export const fingerprintApiKey = (apiKey: string): string => sha256Text(apiKey);

export const createEmptyProjectRemoteState = (): ProjectRemoteState => ({
  indexes: {},
  cleanupTombstones: []
});

const createId = (): string => {
  const cryptoWithUuid = crypto as Crypto & { randomUUID?: () => string };
  if (cryptoWithUuid.randomUUID) return cryptoWithUuid.randomUUID();
  return Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')
  ).join('');
};

export const createSourceCleanupTombstone = (
  projectId: string,
  projectSourceId: string,
  index: ProjectRemoteIndex | undefined
): RemoteCleanupTombstone | null => {
  const remoteFile = index?.files[projectSourceId];
  if (!index || !remoteFile?.openaiFileId) return null;
  return {
    id: createId(),
    projectId,
    projectSourceId,
    apiKeyFingerprint: index.apiKeyFingerprint,
    openaiFileIds: [remoteFile.openaiFileId],
    createdAt: Date.now()
  };
};

export const createProjectCleanupTombstone = (
  projectId: string,
  index: ProjectRemoteIndex | undefined
): RemoteCleanupTombstone | null => {
  if (!index) return null;
  const openaiFileIds = Object.values(index.files)
    .flatMap(file => file.openaiFileId ? [file.openaiFileId] : []);
  if (openaiFileIds.length === 0 && !index.vectorStoreId) return null;
  return {
    id: createId(),
    projectId,
    apiKeyFingerprint: index.apiKeyFingerprint,
    openaiFileIds: [...new Set(openaiFileIds)],
    ...(index.vectorStoreId ? { vectorStoreId: index.vectorStoreId } : {}),
    createdAt: Date.now()
  };
};

const createRemoteIndex = (
  projectId: string,
  apiKeyFingerprint: string
): ProjectRemoteIndex => ({
  projectId,
  apiKeyFingerprint,
  status: 'disconnected',
  usageBytes: 0,
  files: {}
});

export const resolveProjectContext = (
  project: Project,
  state: ProjectRemoteState,
  apiKey: string
): ResolvedProjectContext => {
  const index = state.indexes[project.id];
  const fingerprint = apiKey ? fingerprintApiKey(apiKey) : '';
  const matchesKey = Boolean(index && index.apiKeyFingerprint === fingerprint);
  const readySearchSources = project.sources.filter(source => (
    source.capability === 'file_search' &&
    matchesKey &&
    index?.files[source.id]?.status === 'ready'
  ));
  const analysisFiles = project.sources.flatMap(source => {
    const remoteFile = index?.files[source.id];
    return source.capability === 'code_interpreter' &&
      matchesKey &&
      remoteFile?.status === 'ready' &&
      remoteFile.openaiFileId
      ? [remoteFile.openaiFileId]
      : [];
  });
  const sourceIdByFileId = Object.fromEntries(
    project.sources.flatMap(source => {
      const fileId = index?.files[source.id]?.openaiFileId;
      return fileId ? [[fileId, source.id]] : [];
    })
  );
  return {
    projectId: project.id,
    instructions: project.instructions,
    ...(readySearchSources.length > 0 && index?.status === 'ready' && index.vectorStoreId
      ? { vectorStoreId: index.vectorStoreId }
      : {}),
    analysisFileIds: analysisFiles,
    sourceIdByFileId
  };
};

export const getProjectSourceAvailability = (
  project: Project,
  state: ProjectRemoteState,
  apiKey: string
): { expected: boolean; ready: boolean; reason?: string } => {
  const automatic = project.sources.filter(source => (
    source.capability !== 'direct_attachment'
  ));
  if (automatic.length === 0) return { expected: false, ready: true };
  if (!apiKey) return { expected: true, ready: false, reason: 'API key is missing.' };
  const index = state.indexes[project.id];
  if (!index) return { expected: true, ready: false, reason: 'Sources need indexing.' };
  if (index.apiKeyFingerprint !== fingerprintApiKey(apiKey)) {
    return {
      expected: true,
      ready: false,
      reason: 'Sources are bound to a different API key.'
    };
  }
  const unavailable = automatic.find(source => index.files[source.id]?.status !== 'ready');
  if (unavailable) {
    const status = index.files[unavailable.id]?.status || 'needs indexing';
    return { expected: true, ready: false, reason: `${unavailable.name}: ${status}.` };
  }
  if (
    automatic.some(source => source.capability === 'file_search') &&
    (!index.vectorStoreId || index.status !== 'ready')
  ) {
    return {
      expected: true,
      ready: false,
      reason: 'The project search index is unavailable.'
    };
  }
  return { expected: true, ready: true };
};

export class ProjectSourceService {
  private readonly client: ProjectSourceClient;

  constructor(
    apiKey: string,
    client?: ProjectSourceClient
  ) {
    this.client = client || new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
      timeout: 30 * 60 * 1000
    });
  }

  private async publish(
    state: ProjectRemoteState,
    persist: PersistRemoteState
  ): Promise<ProjectRemoteState> {
    await persist(state);
    return state;
  }

  async refreshUsage(
    state: ProjectRemoteState,
    apiKeyFingerprint: string,
    persist: PersistRemoteState
  ): Promise<ProjectRemoteState> {
    const next = cloneState(state);
    for (const index of Object.values(next.indexes)) {
      if (index.apiKeyFingerprint !== apiKeyFingerprint || !index.vectorStoreId) continue;
      const vectorStore = await this.client.vectorStores.retrieve(index.vectorStoreId);
      index.usageBytes = vectorStore.usage_bytes;
      index.lastVerifiedAt = Date.now();
      index.status = vectorStore.status === 'completed' ? 'ready' : 'creating';
    }
    return this.publish(next, persist);
  }

  async ingestSource({
    project,
    source,
    blob,
    state,
    apiKeyFingerprint,
    persist
  }: {
    project: Project;
    source: ProjectSource;
    blob: Blob;
    state: ProjectRemoteState;
    apiKeyFingerprint: string;
    persist: PersistRemoteState;
  }): Promise<ProjectRemoteState> {
    if (source.capability === 'direct_attachment') return state;
    let next = cloneState(state);
    let index = next.indexes[project.id];
    if (index && index.apiKeyFingerprint !== apiKeyFingerprint) {
      throw new ProjectSourceServiceError(
        'Project sources are bound to a different API key.',
        'authentication'
      );
    }
    if (!index) {
      index = createRemoteIndex(project.id, apiKeyFingerprint);
      next.indexes[project.id] = index;
    }
    let previousFileId = index.files[source.id]?.openaiFileId;
    const previousIndexedUsageBytes = index.files[source.id]?.indexedUsageBytes;
    if (previousFileId) {
      index.files[source.id] = {
        projectSourceId: source.id,
        openaiFileId: previousFileId,
        status: 'removing',
        ...(previousIndexedUsageBytes === undefined
          ? {}
          : { indexedUsageBytes: previousIndexedUsageBytes })
      };
      next = await this.publish(next, persist);
      try {
        await this.deleteFile(previousFileId);
        previousFileId = undefined;
      } catch (error) {
        const classified = classifyProjectSourceError(error);
        next = cloneState(next);
        index = next.indexes[project.id];
        index.files[source.id] = {
          projectSourceId: source.id,
          openaiFileId: previousFileId,
          status: 'failed',
          lastError: classified.message.slice(0, 4096),
          ...(previousIndexedUsageBytes === undefined
            ? {}
            : { indexedUsageBytes: previousIndexedUsageBytes })
        };
        index.status = 'failed';
        await this.publish(next, persist);
        throw classified;
      }
    }
    index.files[source.id] = {
      projectSourceId: source.id,
      status: 'uploading'
    };
    next = await this.publish(next, persist);

    let uploadedFileId: string | undefined;
    try {
      if (source.capability === 'file_search') {
        next = await this.refreshUsage(next, apiKeyFingerprint, persist);
        index = next.indexes[project.id];
        if (!index.vectorStoreId) {
          index.status = 'creating';
          next = await this.publish(next, persist);
          const vectorStore = await this.client.vectorStores.create({
            name: `OpenAI Studio — ${project.name}`.slice(0, 256),
            description: 'OpenAI Studio local project sources',
            metadata: {
              application: 'openai-studio',
              project_id: project.id
            }
          });
          index.vectorStoreId = vectorStore.id;
          index.usageBytes = vectorStore.usage_bytes;
          index.status = vectorStore.status === 'completed' ? 'ready' : 'creating';
          next = await this.publish(next, persist);
        }
      }

      const upload = new File([blob], source.name, {
        type: source.mimeType || blob.type || 'application/octet-stream'
      });
      const uploaded = await this.client.files.create({
        file: upload,
        purpose: 'assistants'
      });
      uploadedFileId = uploaded.id;
      index = next.indexes[project.id];
      index.files[source.id] = {
        projectSourceId: source.id,
        openaiFileId: uploaded.id,
        status: source.capability === 'file_search' ? 'indexing' : 'ready'
      };
      next = await this.publish(next, persist);

      if (source.capability === 'file_search') {
        const vectorStoreId = index.vectorStoreId!;
        const indexed = await this.client.vectorStores.files.createAndPoll(
          vectorStoreId,
          {
            file_id: uploaded.id,
            attributes: {
              openai_studio_project_id: project.id,
              openai_studio_source_id: source.id
            }
          }
        );
        if (indexed.status !== 'completed') {
          throw new ProjectSourceServiceError(
            indexed.last_error?.message || `Indexing ended with ${indexed.status}.`,
            indexed.last_error?.code === 'unsupported_file'
              ? 'unsupported_format'
              : 'terminal'
          );
        }
        const vectorStore = await this.client.vectorStores.retrieve(vectorStoreId);
        index = next.indexes[project.id];
        index.usageBytes = vectorStore.usage_bytes;
        index.lastVerifiedAt = Date.now();
        const totalUsage = Object.values(next.indexes)
          .filter(value => value.apiKeyFingerprint === apiKeyFingerprint)
          .reduce((sum, value) => sum + value.usageBytes, 0);
        if (totalUsage > MAX_INDEXED_USAGE_BYTES) {
          await this.deleteFile(uploaded.id);
          uploadedFileId = undefined;
          index.files[source.id] = {
            projectSourceId: source.id,
            status: 'failed',
            lastError: 'Indexing would exceed the 900 MiB application limit.'
          };
          next = await this.publish(next, persist);
          throw new ProjectSourceServiceError(
            'Indexing would exceed the 900 MiB application limit.',
            'quota'
          );
        }
        index.files[source.id] = {
          projectSourceId: source.id,
          openaiFileId: uploaded.id,
          status: 'ready',
          indexedUsageBytes: indexed.usage_bytes
        };
        index.status = 'ready';
        next = await this.publish(next, persist);
      }
      return next;
    } catch (error) {
      const classified = classifyProjectSourceError(error);
      next = cloneState(next);
      index = next.indexes[project.id] || createRemoteIndex(project.id, apiKeyFingerprint);
      next.indexes[project.id] = index;
      const existing = index.files[source.id];
      index.files[source.id] = {
        projectSourceId: source.id,
        ...(uploadedFileId || previousFileId
          ? { openaiFileId: uploadedFileId || previousFileId }
          : {}),
        status: 'failed',
        lastError: classified.message.slice(0, 4096),
        ...(existing?.indexedUsageBytes !== undefined
          ? { indexedUsageBytes: existing.indexedUsageBytes }
          : {})
      };
      index.status = 'failed';
      await this.publish(next, persist);
      throw classified;
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.client.files.delete(fileId);
    } catch (error) {
      if (!isAlreadyDeletedError(error)) throw classifyProjectSourceError(error);
    }
  }

  async deleteVectorStore(vectorStoreId: string): Promise<void> {
    try {
      await this.client.vectorStores.delete(vectorStoreId);
    } catch (error) {
      if (!isAlreadyDeletedError(error)) throw classifyProjectSourceError(error);
    }
  }

  async runCleanup(
    state: ProjectRemoteState,
    tombstoneId: string,
    persist: PersistRemoteState
  ): Promise<ProjectRemoteState> {
    let next = cloneState(state);
    const tombstone = next.cleanupTombstones.find(item => item.id === tombstoneId);
    if (!tombstone) return next;
    try {
      for (const fileId of tombstone.openaiFileIds) {
        await this.deleteFile(fileId);
      }
      if (tombstone.vectorStoreId) {
        await this.deleteVectorStore(tombstone.vectorStoreId);
      }
      next.cleanupTombstones = next.cleanupTombstones.filter(
        item => item.id !== tombstoneId
      );
      return this.publish(next, persist);
    } catch (error) {
      const classified = classifyProjectSourceError(error);
      next = cloneState(next);
      const pending = next.cleanupTombstones.find(item => item.id === tombstoneId);
      if (pending) pending.lastError = classified.message.slice(0, 4096);
      await this.publish(next, persist);
      throw classified;
    }
  }

  async reconcile(
    projects: Project[],
    state: ProjectRemoteState,
    apiKeyFingerprint: string,
    persist: PersistRemoteState
  ): Promise<ProjectRemoteState> {
    let next = cloneState(state);
    for (const project of projects) {
      const index = next.indexes[project.id];
      if (!index || index.apiKeyFingerprint !== apiKeyFingerprint) continue;
      if (index.vectorStoreId) {
        try {
          const vectorStore = await this.client.vectorStores.retrieve(index.vectorStoreId);
          index.usageBytes = vectorStore.usage_bytes;
          index.status = vectorStore.status === 'completed' ? 'ready' : 'creating';
          index.lastVerifiedAt = Date.now();
        } catch (error) {
          const classified = classifyProjectSourceError(error);
          index.status = classified.status === 404 ? 'disconnected' : 'failed';
          if (classified.status === 404) {
            delete index.vectorStoreId;
            index.usageBytes = 0;
            project.sources
              .filter(source => source.capability === 'file_search')
              .forEach(source => {
                const file = index.files[source.id];
                if (!file) return;
                index.files[source.id] = {
                  ...file,
                  status: 'failed',
                  lastError: 'The project search index is unavailable; retry this source.'
                };
              });
          }
        }
      }
      for (const source of project.sources) {
        const file = index.files[source.id];
        if (!file || file.status === 'ready' || file.status === 'failed') continue;
        if (!file.openaiFileId) {
          index.files[source.id] = {
            projectSourceId: source.id,
            status: 'failed',
            lastError: 'Remote upload was interrupted before a File ID was saved.'
          };
          continue;
        }
        try {
          if (source.capability === 'file_search' && index.vectorStoreId) {
            const remote = await this.client.vectorStores.files.retrieve(
              file.openaiFileId,
              { vector_store_id: index.vectorStoreId }
            );
            index.files[source.id] = {
              projectSourceId: source.id,
              openaiFileId: file.openaiFileId,
              status: remote.status === 'completed'
                ? 'ready'
                : remote.status === 'failed' || remote.status === 'cancelled'
                  ? 'failed'
                  : 'indexing',
              indexedUsageBytes: remote.usage_bytes,
              ...(remote.last_error ? { lastError: remote.last_error.message } : {})
            };
          } else {
            await this.client.files.retrieve(file.openaiFileId);
            index.files[source.id] = { ...file, status: 'ready' };
          }
        } catch (error) {
          const classified = classifyProjectSourceError(error);
          index.files[source.id] = {
            ...file,
            status: 'failed',
            lastError: classified.message.slice(0, 4096)
          };
        }
      }
    }
    return this.publish(next, persist);
  }
}
