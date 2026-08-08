import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
  type Entry
} from '@zip.js/zip.js';
import { APP_VERSION } from '../constants';
import { LocalBlobReference, Project, Session, SystemInstruction } from '../types';
import { MAX_ATTACHMENT_BYTES } from '../utils/attachmentValidation';
import {
  BackupSettings,
  parseAppSettings,
  parseProjects,
  parseStoredSessions,
  parseSystemInstructions,
  validateWorkspaceReferences
} from './workspaceSchema';
import {
  encodeUtf8,
  SHA256_PATTERN,
  sha256Blob,
  sha256Text
} from './contentAddressing';
import {
  WorkspaceReplacement,
  WorkspaceSnapshot,
  storeLocalBlob
} from './storage';

export const BACKUP_ARCHIVE_FORMAT = 'openai-studio-backup';
export const BACKUP_ARCHIVE_VERSION = 3;
export const MAX_BACKUP_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BACKUP_ARCHIVE_ENTRIES = 100_000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MANIFEST_PATH = 'manifest.json';

export type BackupReason = 'scheduled' | 'manual' | 'pre-restore' | 'pre-merge';

export interface BackupArchiveEntry {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface BackupArchiveCounts {
  sessions: number;
  messages: number;
  attachments: number;
  generatedFiles: number;
  cachedGeneratedFiles: number;
  projects: number;
  projectSources: number;
}

export interface BackupArchiveManifest {
  format: typeof BACKUP_ARCHIVE_FORMAT;
  version: typeof BACKUP_ARCHIVE_VERSION;
  backupId: string;
  reason: BackupReason;
  appVersion: string;
  createdAt: number;
  workspaceRevision: number;
  counts: BackupArchiveCounts;
  uncachedGeneratedFileCount: number;
  entries: BackupArchiveEntry[];
}

export interface BackupArchiveProgress {
  phase: 'preparing' | 'validating';
  completedEntries: number;
  totalEntries: number;
  completedBytes: number;
  totalBytes: number;
}

export interface BackupArchivePreview {
  backupId: string;
  reason: BackupReason;
  appVersion: string;
  createdAt: number;
  workspaceRevision: number;
  counts: BackupArchiveCounts;
  uncachedGeneratedFileCount: number;
  archiveBytes: number;
  uncompressedBytes: number;
  sha256: string;
}

export interface ValidatedWorkspaceArchive {
  manifest: BackupArchiveManifest;
  preview: BackupArchivePreview;
  replacement: WorkspaceReplacement;
}

export class BackupArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupArchiveError';
  }
}

export class UnsupportedLegacyBackupError extends BackupArchiveError {
  constructor() {
    super(
      'Legacy JSON backups are not supported. Select an OpenAI Studio ZIP backup.'
    );
    this.name = 'UnsupportedLegacyBackupError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const assertOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void => {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new BackupArchiveError(`${path}.${unknown} is not supported.`);
};

const parseInteger = (value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new BackupArchiveError(`${path} is invalid.`);
  }
  return value as number;
};

const parseCounts = (value: unknown): BackupArchiveCounts => {
  if (!isRecord(value)) throw new BackupArchiveError('manifest.counts must be an object.');
  assertOnlyKeys(
    value,
    [
      'sessions',
      'messages',
      'attachments',
      'generatedFiles',
      'cachedGeneratedFiles',
      'projects',
      'projectSources'
    ],
    'manifest.counts'
  );
  return {
    sessions: parseInteger(value.sessions, 'manifest.counts.sessions'),
    messages: parseInteger(value.messages, 'manifest.counts.messages'),
    attachments: parseInteger(value.attachments, 'manifest.counts.attachments'),
    generatedFiles: parseInteger(value.generatedFiles, 'manifest.counts.generatedFiles'),
    cachedGeneratedFiles: parseInteger(
      value.cachedGeneratedFiles,
      'manifest.counts.cachedGeneratedFiles'
    ),
    projects: parseInteger(value.projects, 'manifest.counts.projects'),
    projectSources: parseInteger(
      value.projectSources,
      'manifest.counts.projectSources'
    )
  };
};

const assertCanonicalArchivePath = (path: string): void => {
  if (
    !path ||
    path.length > 1024 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new BackupArchiveError(`Archive entry path "${path}" is unsafe.`);
  }
};

export const parseBackupArchiveManifest = (
  value: unknown
): BackupArchiveManifest => {
  if (!isRecord(value)) throw new BackupArchiveError('manifest must be an object.');
  assertOnlyKeys(
    value,
    [
      'format',
      'version',
      'backupId',
      'reason',
      'appVersion',
      'createdAt',
      'workspaceRevision',
      'counts',
      'uncachedGeneratedFileCount',
      'entries'
    ],
    'manifest'
  );
  if (value.format !== BACKUP_ARCHIVE_FORMAT) {
    throw new BackupArchiveError('This ZIP is not an OpenAI Studio backup.');
  }
  if (value.version !== BACKUP_ARCHIVE_VERSION) {
    throw new BackupArchiveError(
      `Backup format version ${String(value.version)} is unsupported.`
    );
  }
  if (
    typeof value.backupId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value.backupId)
  ) {
    throw new BackupArchiveError('manifest.backupId is invalid.');
  }
  if (
    value.reason !== 'scheduled' &&
    value.reason !== 'manual' &&
    value.reason !== 'pre-restore' &&
    value.reason !== 'pre-merge'
  ) {
    throw new BackupArchiveError('manifest.reason is invalid.');
  }
  if (typeof value.appVersion !== 'string' || value.appVersion.length > 128) {
    throw new BackupArchiveError('manifest.appVersion is invalid.');
  }
  if (!Array.isArray(value.entries)) {
    throw new BackupArchiveError('manifest.entries must be an array.');
  }
  if (value.entries.length > MAX_BACKUP_ARCHIVE_ENTRIES - 1) {
    throw new BackupArchiveError('The backup declares too many entries.');
  }

  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  let totalBytes = 0;
  const entries = value.entries.map((entryValue, index): BackupArchiveEntry => {
    const path = `manifest.entries[${index}]`;
    if (!isRecord(entryValue)) throw new BackupArchiveError(`${path} must be an object.`);
    assertOnlyKeys(entryValue, ['path', 'byteLength', 'sha256'], path);
    if (typeof entryValue.path !== 'string') {
      throw new BackupArchiveError(`${path}.path is invalid.`);
    }
    assertCanonicalArchivePath(entryValue.path);
    if (entryValue.path === MANIFEST_PATH) {
      throw new BackupArchiveError('manifest.json cannot declare itself.');
    }
    const folded = entryValue.path.toLocaleLowerCase('en-US');
    if (paths.has(entryValue.path) || foldedPaths.has(folded)) {
      throw new BackupArchiveError(`${path}.path is duplicated or case-colliding.`);
    }
    paths.add(entryValue.path);
    foldedPaths.add(folded);
    if (
      typeof entryValue.sha256 !== 'string' ||
      !SHA256_PATTERN.test(entryValue.sha256)
    ) {
      throw new BackupArchiveError(`${path}.sha256 is invalid.`);
    }
    const byteLength = parseInteger(
      entryValue.byteLength,
      `${path}.byteLength`,
      MAX_BACKUP_ARCHIVE_BYTES
    );
    totalBytes += byteLength;
    if (totalBytes > MAX_BACKUP_ARCHIVE_BYTES) {
      throw new BackupArchiveError('The backup exceeds the uncompressed size limit.');
    }
    return {
      path: entryValue.path,
      byteLength,
      sha256: entryValue.sha256
    };
  });

  return {
    format: BACKUP_ARCHIVE_FORMAT,
    version: value.version,
    backupId: value.backupId,
    reason: value.reason,
    appVersion: value.appVersion,
    createdAt: parseInteger(value.createdAt, 'manifest.createdAt'),
    workspaceRevision: parseInteger(
      value.workspaceRevision,
      'manifest.workspaceRevision'
    ),
    counts: parseCounts(value.counts),
    uncachedGeneratedFileCount: parseInteger(
      value.uncachedGeneratedFileCount,
      'manifest.uncachedGeneratedFileCount'
    ),
    entries
  };
};

const getCounts = (sessions: Session[], projects: Project[] = []): {
  counts: BackupArchiveCounts;
  uncachedGeneratedFileCount: number;
} => {
  const counts: BackupArchiveCounts = {
    sessions: sessions.length,
    messages: 0,
    attachments: 0,
    generatedFiles: 0,
    cachedGeneratedFiles: 0,
    projects: projects.length,
    projectSources: projects.reduce((sum, project) => sum + project.sources.length, 0)
  };
  let uncachedGeneratedFileCount = 0;

  sessions.forEach(session => {
    counts.messages += session.messages.length;
    session.messages.forEach(message => {
      counts.attachments += message.attachments?.length || 0;
      counts.generatedFiles += message.generatedFiles?.length || 0;
      message.generatedFiles?.forEach(file => {
        if (file.localBlob) counts.cachedGeneratedFiles += 1;
        else uncachedGeneratedFileCount += 1;
      });
    });
  });
  return { counts, uncachedGeneratedFileCount };
};

const getBlobReferences = (
  sessions: Session[],
  projects: Project[] = []
): Map<string, LocalBlobReference> => {
  const references = new Map<string, LocalBlobReference>();
  sessions.forEach(session => {
    session.messages.forEach(message => {
      message.attachments?.forEach(attachment => {
        if (attachment.localBlob) {
          references.set(attachment.localBlob.sha256, attachment.localBlob);
        }
      });
      message.generatedFiles?.forEach(file => {
        if (file.localBlob) references.set(file.localBlob.sha256, file.localBlob);
      });
    });
  });
  projects.forEach(project => {
    project.sources.forEach(source => {
      references.set(source.localBlob.sha256, source.localBlob);
    });
  });
  return references;
};

const createJsonEntry = (
  path: string,
  value: unknown
): { descriptor: BackupArchiveEntry; text: string } => {
  const text = JSON.stringify(value);
  return {
    descriptor: {
      path,
      byteLength: encodeUtf8(text).byteLength,
      sha256: sha256Text(text)
    },
    text
  };
};

const shouldStoreWithoutCompression = (mimeType = ''): boolean => (
  /^(image\/(gif|jpeg|png|webp)|audio\/|video\/|application\/(pdf|zip|gzip))/.test(
    mimeType.toLowerCase()
  )
);

const createWorkspaceArchiveFromSnapshot = async (
  snapshot: WorkspaceSnapshot,
  options: {
    reason: BackupReason;
    signal?: AbortSignal;
    onProgress?: (progress: BackupArchiveProgress) => void;
  }
): Promise<Blob> => {
  const settings: BackupSettings = {
    theme: snapshot.settings.theme,
    ...(snapshot.settings.lastActiveSessionId
      ? { lastActiveSessionId: snapshot.settings.lastActiveSessionId }
      : {})
  };
  const sessionEntries = snapshot.sessions.map(session => (
    createJsonEntry(`workspace/sessions/${session.id}.json`, session)
  ));
  const settingsEntry = createJsonEntry('workspace/settings.json', settings);
  const instructionsEntry = createJsonEntry(
    'workspace/system_instructions.json',
    snapshot.instructions
  );
  const projects = snapshot.projects || [];
  const projectsEntry = createJsonEntry('workspace/projects.json', projects);
  const blobReferences = getBlobReferences(snapshot.sessions, projects);
  const blobEntries = [...blobReferences.values()]
    .sort((left, right) => left.sha256.localeCompare(right.sha256))
    .map(reference => ({
      descriptor: {
        path: `blobs/${reference.sha256}`,
        byteLength: reference.byteSize,
        sha256: reference.sha256
      },
      reference
    }));
  const entries = [
    settingsEntry.descriptor,
    instructionsEntry.descriptor,
    projectsEntry.descriptor,
    ...sessionEntries.map(entry => entry.descriptor),
    ...blobEntries.map(entry => entry.descriptor)
  ];
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (entries.length + 1 > MAX_BACKUP_ARCHIVE_ENTRIES) {
    throw new BackupArchiveError('The workspace contains too many backup entries.');
  }
  if (totalBytes > MAX_BACKUP_ARCHIVE_BYTES) {
    throw new BackupArchiveError('The workspace exceeds the backup size limit.');
  }
  const { counts, uncachedGeneratedFileCount } = getCounts(
    snapshot.sessions,
    projects
  );
  const manifest: BackupArchiveManifest = {
    format: BACKUP_ARCHIVE_FORMAT,
    version: BACKUP_ARCHIVE_VERSION,
    backupId: crypto.randomUUID(),
    reason: options.reason,
    appVersion: APP_VERSION,
    createdAt: Date.now(),
    workspaceRevision: snapshot.revision,
    counts,
    uncachedGeneratedFileCount,
    entries
  };
  const manifestText = JSON.stringify(manifest);
  const manifestByteLength = encodeUtf8(manifestText).byteLength;
  if (manifestByteLength > MAX_MANIFEST_BYTES) {
    throw new BackupArchiveError('The backup manifest is too large.');
  }
  if (totalBytes + manifestByteLength > MAX_BACKUP_ARCHIVE_BYTES) {
    throw new BackupArchiveError('The workspace exceeds the backup size limit.');
  }

  const writer = new ZipWriter(new BlobWriter('application/zip'));
  let completedEntries = 0;
  let completedBytes = 0;
  const report = () => options.onProgress?.({
    phase: 'preparing',
    completedEntries,
    totalEntries: entries.length + 1,
    completedBytes,
    totalBytes
  });
  const addText = async (path: string, text: string, byteLength: number) => {
    options.signal?.throwIfAborted();
    await writer.add(path, new TextReader(text), {
      level: 6,
      signal: options.signal
    });
    completedEntries += 1;
    completedBytes += byteLength;
    report();
  };

  try {
    await addText(MANIFEST_PATH, manifestText, 0);
    await addText(
      settingsEntry.descriptor.path,
      settingsEntry.text,
      settingsEntry.descriptor.byteLength
    );
    await addText(
      instructionsEntry.descriptor.path,
      instructionsEntry.text,
      instructionsEntry.descriptor.byteLength
    );
    await addText(
      projectsEntry.descriptor.path,
      projectsEntry.text,
      projectsEntry.descriptor.byteLength
    );
    for (const entry of sessionEntries) {
      await addText(entry.descriptor.path, entry.text, entry.descriptor.byteLength);
    }
    for (const entry of blobEntries) {
      options.signal?.throwIfAborted();
      const blob = await snapshot.readBlob(entry.reference);
      await writer.add(entry.descriptor.path, new BlobReader(blob), {
        level: shouldStoreWithoutCompression(entry.reference.mimeType) ? 0 : 6,
        signal: options.signal
      });
      completedEntries += 1;
      completedBytes += entry.descriptor.byteLength;
      report();
    }
    const archive = await writer.close();
    if (archive.size > MAX_BACKUP_ARCHIVE_BYTES) {
      throw new BackupArchiveError('The compressed backup exceeds the size limit.');
    }
    return archive;
  } catch (error) {
    try {
      await writer.close();
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
};

export const createWorkspaceArchive = async (
  snapshot: WorkspaceSnapshot,
  options: {
    reason: BackupReason;
    signal?: AbortSignal;
    onProgress?: (progress: BackupArchiveProgress) => void;
  }
): Promise<Blob> => {
  try {
    return await createWorkspaceArchiveFromSnapshot(snapshot, options);
  } finally {
    snapshot.release?.();
  }
};

const readEntryText = async (entry: Entry, maximum: number): Promise<string> => {
  if (entry.directory) throw new BackupArchiveError(`${entry.filename} is a directory.`);
  if (entry.uncompressedSize > maximum) {
    throw new BackupArchiveError(`${entry.filename} exceeds its size limit.`);
  }
  return entry.getData(new TextWriter(), {
    checkOverlappingEntry: true,
    checkAmbiguity: true
  });
};

const verifyEntryBlob = async (
  entry: Entry,
  descriptor: BackupArchiveEntry,
  signal?: AbortSignal
): Promise<Blob> => {
  if (entry.directory) throw new BackupArchiveError(`${entry.filename} is a directory.`);
  signal?.throwIfAborted();
  const blob = await entry.getData(new BlobWriter(), {
    signal,
    checkOverlappingEntry: true,
    checkAmbiguity: true
  });
  if (blob.size !== descriptor.byteLength) {
    throw new BackupArchiveError(`${entry.filename} has an unexpected byte length.`);
  }
  if (await sha256Blob(blob) !== descriptor.sha256) {
    throw new BackupArchiveError(`${entry.filename} failed its SHA-256 check.`);
  }
  return blob;
};

const verifyCounts = (
  manifest: BackupArchiveManifest,
  sessions: Session[],
  projects: Project[]
): void => {
  const actual = getCounts(sessions, projects);
  const countKeys: Array<keyof BackupArchiveCounts> = [
    'sessions',
    'messages',
    'attachments',
    'generatedFiles',
    'cachedGeneratedFiles',
    'projects',
    'projectSources'
  ];
  if (
    countKeys.some(key => (
      actual.counts[key] !== manifest.counts[key]
    )) ||
    actual.uncachedGeneratedFileCount !== manifest.uncachedGeneratedFileCount
  ) {
    throw new BackupArchiveError('The backup counts do not match its contents.');
  }
};

export const inspectWorkspaceArchive = async (
  archive: Blob,
  options: {
    filename?: string;
    signal?: AbortSignal;
    onProgress?: (progress: BackupArchiveProgress) => void;
    retainBlobs?: boolean;
  } = {}
): Promise<ValidatedWorkspaceArchive> => {
  if (
    options.filename?.toLowerCase().endsWith('.json') ||
    archive.type === 'application/json'
  ) {
    throw new UnsupportedLegacyBackupError();
  }
  if (archive.size > MAX_BACKUP_ARCHIVE_BYTES) {
    throw new BackupArchiveError('The compressed backup exceeds the size limit.');
  }

  const reader = new ZipReader(new BlobReader(archive), {
    strictness: 'strict'
  });
  try {
    const entries = await reader.getEntries({ strictness: 'strict' });
    if (entries.length === 0 || entries.length > MAX_BACKUP_ARCHIVE_ENTRIES) {
      throw new BackupArchiveError('The ZIP entry count is invalid.');
    }
    const byPath = new Map<string, Entry>();
    const foldedPaths = new Set<string>();
    let uncompressedBytes = 0;
    let compressedBytes = 0;
    for (const entry of entries) {
      assertCanonicalArchivePath(entry.filename);
      const folded = entry.filename.toLocaleLowerCase('en-US');
      if (byPath.has(entry.filename) || foldedPaths.has(folded)) {
        throw new BackupArchiveError(
          `Archive entry ${entry.filename} is duplicated or case-colliding.`
        );
      }
      if (entry.directory || entry.encrypted) {
        throw new BackupArchiveError(
          `Archive entry ${entry.filename} has unsupported attributes.`
        );
      }
      byPath.set(entry.filename, entry);
      foldedPaths.add(folded);
      uncompressedBytes += entry.uncompressedSize;
      compressedBytes += entry.compressedSize;
      if (
        uncompressedBytes > MAX_BACKUP_ARCHIVE_BYTES ||
        compressedBytes > MAX_BACKUP_ARCHIVE_BYTES
      ) {
        throw new BackupArchiveError('The backup exceeds the archive size limit.');
      }
    }
    const manifestEntry = byPath.get(MANIFEST_PATH);
    if (!manifestEntry) throw new BackupArchiveError('manifest.json is missing.');
    const manifestText = await readEntryText(manifestEntry, MAX_MANIFEST_BYTES);
    const manifest = parseBackupArchiveManifest(JSON.parse(manifestText));
    const expectedPaths = new Set([
      MANIFEST_PATH,
      ...manifest.entries.map(entry => entry.path)
    ]);
    const extraPath = [...byPath.keys()].find(path => !expectedPaths.has(path));
    const missingPath = [...expectedPaths].find(path => !byPath.has(path));
    if (extraPath) throw new BackupArchiveError(`Undeclared entry ${extraPath} is not allowed.`);
    if (missingPath) throw new BackupArchiveError(`Declared entry ${missingPath} is missing.`);

    const sessionValues: Session[] = [];
    let settings: BackupSettings | null = null;
    let instructions: SystemInstruction[] | null = null;
    let projects: Project[] | null = null;
    const blobs = new Map<string, Blob>();
    const blobSizes = new Map<string, number>();
    let completedEntries = 0;
    let completedBytes = 0;
    const totalBytes = manifest.entries.reduce(
      (sum, descriptor) => sum + descriptor.byteLength,
      0
    );

    for (const descriptor of manifest.entries) {
      options.signal?.throwIfAborted();
      const entry = byPath.get(descriptor.path)!;
      if (entry.uncompressedSize !== descriptor.byteLength) {
        throw new BackupArchiveError(
          `${descriptor.path} metadata does not match the manifest.`
        );
      }
      const blob = await verifyEntryBlob(entry, descriptor, options.signal);
      if (descriptor.path === 'workspace/settings.json') {
        const value = JSON.parse(await blob.text());
        settings = parseAppSettings(value, { backup: true }) as BackupSettings;
        if (settings.apiKey !== undefined) {
          throw new BackupArchiveError('A portable backup cannot contain an API key.');
        }
      } else if (descriptor.path === 'workspace/system_instructions.json') {
        instructions = parseSystemInstructions(JSON.parse(await blob.text()));
      } else if (descriptor.path === 'workspace/projects.json') {
        projects = parseProjects(JSON.parse(await blob.text()));
      } else if (descriptor.path.startsWith('workspace/sessions/')) {
        const parsed = parseStoredSessions([JSON.parse(await blob.text())]);
        sessionValues.push(parsed[0]);
      } else if (descriptor.path.startsWith('blobs/')) {
        const hash = descriptor.path.slice('blobs/'.length);
        if (hash !== descriptor.sha256 || !SHA256_PATTERN.test(hash)) {
          throw new BackupArchiveError(`${descriptor.path} is not content-addressed.`);
        }
        blobSizes.set(hash, blob.size);
        if (options.retainBlobs !== false) blobs.set(hash, blob);
      } else {
        throw new BackupArchiveError(`Entry ${descriptor.path} has an unsupported path.`);
      }
      completedEntries += 1;
      completedBytes += descriptor.byteLength;
      options.onProgress?.({
        phase: 'validating',
        completedEntries,
        totalEntries: manifest.entries.length,
        completedBytes,
        totalBytes
      });
    }
    if (!settings || !instructions || !projects) {
      throw new BackupArchiveError('Workspace settings, instructions, or projects are missing.');
    }
    const orderedSessions = manifest.entries
      .filter(entry => entry.path.startsWith('workspace/sessions/'))
      .map(entry => {
        const sessionId = entry.path.slice(
          'workspace/sessions/'.length,
          -'.json'.length
        );
        const session = sessionValues.find(value => value.id === sessionId);
        if (!session) {
          throw new BackupArchiveError(
            `${entry.path} does not match its embedded session ID.`
          );
        }
        return session;
      });
    parseStoredSessions(orderedSessions);
    validateWorkspaceReferences({
      sessions: orderedSessions,
      settings,
      instructions,
      projects
    });
    orderedSessions.forEach(session => {
      session.messages.forEach(message => {
        message.attachments?.forEach(attachment => {
          if (!attachment.localBlob) {
            if (
              attachment.size !== undefined &&
              attachment.size > MAX_ATTACHMENT_BYTES
            ) {
              throw new BackupArchiveError(
                `Attachment "${attachment.name}" exceeds the attachment size limit.`
              );
            }
            return;
          }
          if (!blobSizes.has(attachment.localBlob.sha256)) {
            throw new BackupArchiveError(
              `Attachment "${attachment.name}" is missing verified bytes.`
            );
          }
          if (attachment.localBlob.byteSize > MAX_ATTACHMENT_BYTES) {
            throw new BackupArchiveError(
              `Attachment "${attachment.name}" exceeds the attachment size limit.`
            );
          }
          if (
            blobSizes.get(attachment.localBlob.sha256)! !==
            attachment.localBlob.byteSize
          ) {
            throw new BackupArchiveError(
              `Attachment "${attachment.name}" byte metadata is inconsistent.`
            );
          }
        });
        message.generatedFiles?.forEach(file => {
          if (file.localBlob && !blobSizes.has(file.localBlob.sha256)) {
            throw new BackupArchiveError(
              `Generated file "${file.filename}" is missing verified bytes.`
            );
          }
          if (
            file.localBlob &&
            blobSizes.get(file.localBlob.sha256)! !== file.localBlob.byteSize
          ) {
            throw new BackupArchiveError(
              `Generated file "${file.filename}" byte metadata is inconsistent.`
            );
          }
        });
      });
    });
    projects.forEach(project => {
      project.sources.forEach(source => {
        if (!blobSizes.has(source.localBlob.sha256)) {
          throw new BackupArchiveError(
            `Project source "${source.name}" is missing verified bytes.`
          );
        }
        if (blobSizes.get(source.localBlob.sha256) !== source.localBlob.byteSize) {
          throw new BackupArchiveError(
            `Project source "${source.name}" byte metadata is inconsistent.`
          );
        }
      });
    });
    const referencedBlobHashes = getBlobReferences(orderedSessions, projects);
    if (
      blobSizes.size !== referencedBlobHashes.size ||
      [...blobSizes.keys()].some(hash => !referencedBlobHashes.has(hash))
    ) {
      throw new BackupArchiveError(
        'The backup contains blob entries that are not referenced by the workspace.'
      );
    }
    verifyCounts(manifest, orderedSessions, projects);
    const archiveHash = await sha256Blob(archive);
    return {
      manifest,
      replacement: {
        sessions: orderedSessions,
        settings,
        instructions,
        projects,
        blobs
      },
      preview: {
        backupId: manifest.backupId,
        reason: manifest.reason,
        appVersion: manifest.appVersion,
        createdAt: manifest.createdAt,
        workspaceRevision: manifest.workspaceRevision,
        counts: manifest.counts,
        uncachedGeneratedFileCount: manifest.uncachedGeneratedFileCount,
        archiveBytes: archive.size,
        uncompressedBytes,
        sha256: archiveHash
      }
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BackupArchiveError('A JSON entry in the backup is malformed.');
    }
    throw error;
  } finally {
    await reader.close();
  }
};

export const selectWorkspaceArchiveBlobEntries = (
  manifest: BackupArchiveManifest,
  includedHashes?: ReadonlySet<string>
): BackupArchiveEntry[] => manifest.entries.filter(entry => (
    entry.path.startsWith('blobs/') &&
    (
      includedHashes === undefined ||
      includedHashes.has(entry.path.slice('blobs/'.length))
    )
  ));

export const stageWorkspaceArchiveBlobs = async (
  dirHandle: FileSystemDirectoryHandle,
  archive: Blob,
  manifest: BackupArchiveManifest,
  signal?: AbortSignal,
  includedHashes?: ReadonlySet<string>
): Promise<void> => {
  const blobDescriptors = selectWorkspaceArchiveBlobEntries(
    manifest,
    includedHashes
  );
  if (blobDescriptors.length === 0) return;
  const reader = new ZipReader(new BlobReader(archive), {
    strictness: 'strict'
  });
  try {
    const entries = await reader.getEntries({ strictness: 'strict' });
    const byPath = new Map(entries.map(entry => [entry.filename, entry]));
    for (const descriptor of blobDescriptors) {
      signal?.throwIfAborted();
      const entry = byPath.get(descriptor.path);
      if (!entry) {
        throw new BackupArchiveError(`Declared entry ${descriptor.path} is missing.`);
      }
      const blob = await verifyEntryBlob(entry, descriptor, signal);
      const stored = await storeLocalBlob(dirHandle, blob, blob.type);
      if (
        stored.sha256 !== descriptor.sha256 ||
        stored.byteSize !== descriptor.byteLength
      ) {
        throw new BackupArchiveError(
          `${descriptor.path} could not be staged with verified integrity.`
        );
      }
    }
  } finally {
    await reader.close();
  }
};
