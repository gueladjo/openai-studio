import { LocalBlobReference } from '../types';
import { SHA256_PATTERN } from './contentAddressing';

export const LOCAL_WORKSPACE_SCHEMA_VERSION = 3;
export const PREVIOUS_LOCAL_WORKSPACE_SCHEMA_VERSION = 2;
export const WORKSPACE_MANIFEST_SLOTS = [
  'workspace_manifest_a.json',
  'workspace_manifest_b.json'
] as const;
export const WORKSPACE_OBJECT_PREFIX = 'objects/';
export const WORKSPACE_BLOB_PREFIX = 'blobs/';

export type WorkspaceManifestSlot = typeof WORKSPACE_MANIFEST_SLOTS[number];

export interface ContentObjectReference {
  sha256: string;
  byteLength: number;
}

export interface SessionObjectReference extends ContentObjectReference {
  id: string;
}

interface WorkspaceGenerationManifestData {
  revision: number;
  createdAt: number;
  sessions: SessionObjectReference[];
  settings: ContentObjectReference;
  instructions: ContentObjectReference;
  blobs: ContentObjectReference[];
}

export interface WorkspaceGenerationManifest extends WorkspaceGenerationManifestData {
  schemaVersion: typeof LOCAL_WORKSPACE_SCHEMA_VERSION;
}

export interface PreviousWorkspaceGenerationManifest extends WorkspaceGenerationManifestData {
  schemaVersion: typeof PREVIOUS_LOCAL_WORKSPACE_SCHEMA_VERSION;
}

export class WorkspaceGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceGenerationError';
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
  if (unknown) {
    throw new WorkspaceGenerationError(`${path}.${unknown} is not supported.`);
  }
};

const parseNonNegativeInteger = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WorkspaceGenerationError(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
};

const parseContentReference = (
  value: unknown,
  path: string
): ContentObjectReference => {
  if (!isRecord(value)) {
    throw new WorkspaceGenerationError(`${path} must be an object.`);
  }
  assertOnlyKeys(value, ['sha256', 'byteLength'], path);
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new WorkspaceGenerationError(`${path}.sha256 must be a lowercase SHA-256 digest.`);
  }
  return {
    sha256: value.sha256,
    byteLength: parseNonNegativeInteger(value.byteLength, `${path}.byteLength`)
  };
};

const parseWorkspaceGenerationManifestVersion = <TVersion extends number>(
  text: string,
  filename: string,
  expectedVersion: TVersion
): WorkspaceGenerationManifestData & { schemaVersion: TVersion } => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkspaceGenerationError(`${filename} is not valid JSON.`);
  }
  if (!isRecord(value)) {
    throw new WorkspaceGenerationError(`${filename} must be an object.`);
  }
  assertOnlyKeys(
    value,
    ['schemaVersion', 'revision', 'createdAt', 'sessions', 'settings', 'instructions', 'blobs'],
    filename
  );
  if (value.schemaVersion !== expectedVersion) {
    throw new WorkspaceGenerationError(
      `${filename}.schemaVersion must be ${expectedVersion}.`
    );
  }
  const createdAt = parseNonNegativeInteger(value.createdAt, `${filename}.createdAt`);
  if (!Array.isArray(value.sessions)) {
    throw new WorkspaceGenerationError(`${filename}.sessions must be an array.`);
  }
  if (!Array.isArray(value.blobs)) {
    throw new WorkspaceGenerationError(`${filename}.blobs must be an array.`);
  }

  const sessionIds = new Set<string>();
  const sessions = value.sessions.map((entry, index): SessionObjectReference => {
    const path = `${filename}.sessions[${index}]`;
    if (!isRecord(entry)) {
      throw new WorkspaceGenerationError(`${path} must be an object.`);
    }
    assertOnlyKeys(entry, ['id', 'sha256', 'byteLength'], path);
    if (
      typeof entry.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(entry.id)
    ) {
      throw new WorkspaceGenerationError(`${path}.id is invalid.`);
    }
    if (sessionIds.has(entry.id)) {
      throw new WorkspaceGenerationError(`${path}.id is duplicated.`);
    }
    sessionIds.add(entry.id);
    return {
      id: entry.id,
      ...parseContentReference({
        sha256: entry.sha256,
        byteLength: entry.byteLength
      }, path)
    };
  });

  const blobDigests = new Set<string>();
  const blobs = value.blobs.map((entry, index) => {
    const reference = parseContentReference(entry, `${filename}.blobs[${index}]`);
    if (blobDigests.has(reference.sha256)) {
      throw new WorkspaceGenerationError(
        `${filename}.blobs[${index}].sha256 is duplicated.`
      );
    }
    blobDigests.add(reference.sha256);
    return reference;
  });

  return {
    schemaVersion: expectedVersion,
    revision: parseNonNegativeInteger(value.revision, `${filename}.revision`),
    createdAt,
    sessions,
    settings: parseContentReference(value.settings, `${filename}.settings`),
    instructions: parseContentReference(value.instructions, `${filename}.instructions`),
    blobs
  };
};

export const parseWorkspaceGenerationManifest = (
  text: string,
  filename = 'workspace manifest'
): WorkspaceGenerationManifest => parseWorkspaceGenerationManifestVersion(
  text,
  filename,
  LOCAL_WORKSPACE_SCHEMA_VERSION
);

export const parsePreviousWorkspaceGenerationManifest = (
  text: string,
  filename = 'workspace manifest'
): PreviousWorkspaceGenerationManifest => parseWorkspaceGenerationManifestVersion(
  text,
  filename,
  PREVIOUS_LOCAL_WORKSPACE_SCHEMA_VERSION
);

export const getObjectPath = (reference: ContentObjectReference): string => (
  `${WORKSPACE_OBJECT_PREFIX}${reference.sha256}.json`
);

export const getBlobPath = (reference: Pick<LocalBlobReference, 'sha256'>): string => (
  `${WORKSPACE_BLOB_PREFIX}${reference.sha256}`
);

export const collectManifestObjectHashes = (
  manifest: WorkspaceGenerationManifest
): Set<string> => new Set([
  manifest.settings.sha256,
  manifest.instructions.sha256,
  ...manifest.sessions.map(session => session.sha256)
]);

export const collectManifestBlobHashes = (
  manifest: WorkspaceGenerationManifest
): Set<string> => new Set(manifest.blobs.map(blob => blob.sha256));
