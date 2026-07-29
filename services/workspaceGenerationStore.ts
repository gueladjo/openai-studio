import {
  AppSettings,
  parseAppSettings,
  parseJsonText,
  parseStoredSessions,
  parseSystemInstructions,
  validateWorkspaceReferences
} from './workspaceSchema';
import { LocalBlobReference, Session, SystemInstruction } from '../types';
import {
  encodeUtf8,
  sha256Blob,
  sha256Text
} from './contentAddressing';
import {
  collectManifestBlobHashes,
  collectManifestObjectHashes,
  ContentObjectReference,
  getBlobPath,
  getObjectPath,
  LOCAL_WORKSPACE_SCHEMA_VERSION,
  parseWorkspaceGenerationManifest,
  SessionObjectReference,
  WorkspaceGenerationError,
  WorkspaceGenerationManifest,
  WORKSPACE_BLOB_PREFIX,
  WORKSPACE_MANIFEST_SLOTS,
  WORKSPACE_OBJECT_PREFIX,
  WorkspaceManifestSlot
} from './workspaceGeneration';

export interface WorkspaceGenerationAdapter {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  readBlob(path: string): Promise<Blob | null>;
  writeBlob(path: string, blob: Blob): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface WorkspaceGenerationData {
  sessions: Session[];
  settings: AppSettings;
  instructions: SystemInstruction[];
}

export interface ValidWorkspaceGeneration extends WorkspaceGenerationData {
  manifest: WorkspaceGenerationManifest;
  slot: WorkspaceManifestSlot;
}

const pinnedObjectHashes = new Map<string, number>();
const pinnedBlobHashes = new Map<string, number>();
const stagedBlobHashes = new Map<string, number>();
const STAGED_BLOB_RETENTION_MS = 60 * 60 * 1000;

const addPins = (target: Map<string, number>, hashes: Iterable<string>): void => {
  for (const hash of hashes) target.set(hash, (target.get(hash) || 0) + 1);
};

const removePins = (target: Map<string, number>, hashes: Iterable<string>): void => {
  for (const hash of hashes) {
    const next = (target.get(hash) || 0) - 1;
    if (next > 0) target.set(hash, next);
    else target.delete(hash);
  }
};

const serializeJson = (value: unknown): string => JSON.stringify(
  value,
  (_key, nestedValue) => {
    if (
      typeof nestedValue !== 'object' ||
      nestedValue === null ||
      Array.isArray(nestedValue)
    ) {
      return nestedValue;
    }
    return Object.fromEntries(
      Object.entries(nestedValue as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
    );
  }
);

const createObjectReference = (text: string): ContentObjectReference => ({
  sha256: sha256Text(text),
  byteLength: encodeUtf8(text).byteLength
});

const collectLocalBlobReferences = (
  sessions: Session[]
): Map<string, LocalBlobReference> => {
  const references = new Map<string, LocalBlobReference>();
  const addReference = (reference: LocalBlobReference): void => {
    const existing = references.get(reference.sha256);
    if (existing && existing.byteSize !== reference.byteSize) {
      throw new WorkspaceGenerationError(
        `Blob ${reference.sha256} has inconsistent byte metadata.`
      );
    }
    references.set(reference.sha256, reference);
  };

  sessions.forEach(session => {
    session.messages.forEach(message => {
      message.attachments?.forEach(attachment => {
        if (attachment.localBlob) addReference(attachment.localBlob);
      });
      message.generatedFiles?.forEach(file => {
        if (file.localBlob) addReference(file.localBlob);
      });
    });
  });

  return references;
};

const verifyText = (
  path: string,
  text: string,
  reference: ContentObjectReference
): void => {
  if (encodeUtf8(text).byteLength !== reference.byteLength) {
    throw new WorkspaceGenerationError(`${path} has an unexpected byte length.`);
  }
  if (sha256Text(text) !== reference.sha256) {
    throw new WorkspaceGenerationError(`${path} failed its SHA-256 check.`);
  }
};

export class WorkspaceGenerationStore {
  constructor(private readonly adapter: WorkspaceGenerationAdapter) {}

  async hasManifestRecords(): Promise<boolean> {
    const records = await Promise.all(
      WORKSPACE_MANIFEST_SLOTS.map(slot => this.adapter.readText(slot))
    );
    return records.some(text => text !== null);
  }

  async readValidGenerations(): Promise<ValidWorkspaceGeneration[]> {
    const results = await Promise.all(WORKSPACE_MANIFEST_SLOTS.map(async slot => {
      const text = await this.adapter.readText(slot);
      if (text === null) return null;

      try {
        const manifest = parseWorkspaceGenerationManifest(text, slot);
        return await this.validateGeneration(slot, manifest);
      } catch (error) {
        console.warn(`Ignored incomplete workspace generation ${slot}.`, error);
        return null;
      }
    }));

    return results
      .filter((result): result is ValidWorkspaceGeneration => result !== null)
      .sort((left, right) => right.manifest.revision - left.manifest.revision);
  }

  async readCurrent(): Promise<ValidWorkspaceGeneration | null> {
    return (await this.readValidGenerations())[0] || null;
  }

  pin(manifest: WorkspaceGenerationManifest): () => void {
    const objects = collectManifestObjectHashes(manifest);
    const blobs = collectManifestBlobHashes(manifest);
    addPins(pinnedObjectHashes, objects);
    addPins(pinnedBlobHashes, blobs);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      removePins(pinnedObjectHashes, objects);
      removePins(pinnedBlobHashes, blobs);
    };
  }

  async commit(
    expectedRevision: number | null,
    data: WorkspaceGenerationData,
    options: { revision?: number; createdAt?: number } = {}
  ): Promise<ValidWorkspaceGeneration> {
    parseStoredSessions(data.sessions);
    parseAppSettings(data.settings);
    parseSystemInstructions(data.instructions);
    validateWorkspaceReferences(data);

    const current = await this.readCurrent();
    const actualRevision = current?.manifest.revision ?? null;
    if (actualRevision !== expectedRevision) {
      throw new WorkspaceGenerationError(
        `Workspace revision changed (expected ${String(expectedRevision)}, found ${String(actualRevision)}).`
      );
    }

    const sessionEntries: Array<{
      reference: SessionObjectReference;
      text: string;
    }> = data.sessions.map(session => {
      const text = serializeJson(session);
      return {
        reference: {
          id: session.id,
          ...createObjectReference(text)
        },
        text
      };
    });
    const settingsText = serializeJson(data.settings);
    const instructionsText = serializeJson(data.instructions);
    const settings = createObjectReference(settingsText);
    const instructions = createObjectReference(instructionsText);
    const blobReferences = [...collectLocalBlobReferences(data.sessions).values()]
      .sort((left, right) => left.sha256.localeCompare(right.sha256))
      .map(reference => ({
        sha256: reference.sha256,
        byteLength: reference.byteSize
      }));

    await Promise.all([
      ...sessionEntries.map(entry => this.writeObject(entry.reference, entry.text)),
      this.writeObject(settings, settingsText),
      this.writeObject(instructions, instructionsText)
    ]);

    for (const reference of blobReferences) {
      const path = getBlobPath(reference);
      const blob = await this.adapter.readBlob(path);
      if (!blob) {
        throw new WorkspaceGenerationError(`Referenced blob ${reference.sha256} is missing.`);
      }
      if (blob.size !== reference.byteLength) {
        throw new WorkspaceGenerationError(
          `Referenced blob ${reference.sha256} has an unexpected byte length.`
        );
      }
      if (await sha256Blob(blob) !== reference.sha256) {
        throw new WorkspaceGenerationError(
          `Referenced blob ${reference.sha256} failed its SHA-256 check.`
        );
      }
    }

    const nextRevision = options.revision ?? ((actualRevision ?? -1) + 1);
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) {
      throw new WorkspaceGenerationError('The next workspace revision is invalid.');
    }
    const manifest: WorkspaceGenerationManifest = {
      schemaVersion: LOCAL_WORKSPACE_SCHEMA_VERSION,
      revision: nextRevision,
      createdAt: options.createdAt ?? Date.now(),
      sessions: sessionEntries.map(entry => entry.reference),
      settings,
      instructions,
      blobs: blobReferences
    };
    const nextSlot = current?.slot === WORKSPACE_MANIFEST_SLOTS[0]
      ? WORKSPACE_MANIFEST_SLOTS[1]
      : WORKSPACE_MANIFEST_SLOTS[0];
    await this.adapter.writeText(nextSlot, serializeJson(manifest));

    const verified = await this.validateGeneration(nextSlot, manifest);
    manifest.blobs.forEach(reference => {
      stagedBlobHashes.delete(reference.sha256);
    });
    await this.garbageCollect();
    return verified;
  }

  async storeBlob(blob: Blob, mimeType = blob.type): Promise<LocalBlobReference> {
    const reference: LocalBlobReference = {
      sha256: await sha256Blob(blob),
      byteSize: blob.size,
      ...(mimeType ? { mimeType } : {})
    };
    const path = getBlobPath(reference);
    const existing = await this.adapter.readBlob(path);

    if (existing) {
      if (
        existing.size !== reference.byteSize ||
        await sha256Blob(existing) !== reference.sha256
      ) {
        throw new WorkspaceGenerationError(
          `Content-addressed blob ${reference.sha256} is corrupt.`
        );
      }
      stagedBlobHashes.set(reference.sha256, Date.now());
      return reference;
    }

    await this.adapter.writeBlob(path, blob);
    const stored = await this.adapter.readBlob(path);
    if (
      !stored ||
      stored.size !== reference.byteSize ||
      await sha256Blob(stored) !== reference.sha256
    ) {
      throw new WorkspaceGenerationError(
        `Content-addressed blob ${reference.sha256} could not be verified.`
      );
    }
    stagedBlobHashes.set(reference.sha256, Date.now());
    return reference;
  }

  async readBlob(reference: LocalBlobReference): Promise<Blob | null> {
    const blob = await this.adapter.readBlob(getBlobPath(reference));
    if (!blob) return null;
    if (
      blob.size !== reference.byteSize ||
      await sha256Blob(blob) !== reference.sha256
    ) {
      throw new WorkspaceGenerationError(
        `Content-addressed blob ${reference.sha256} failed verification.`
      );
    }
    return reference.mimeType && blob.type !== reference.mimeType
      ? blob.slice(0, blob.size, reference.mimeType)
      : blob;
  }

  private async writeObject(
    reference: ContentObjectReference,
    text: string
  ): Promise<void> {
    const path = getObjectPath(reference);
    const existing = await this.adapter.readText(path);
    if (existing !== null) {
      verifyText(path, existing, reference);
      return;
    }

    await this.adapter.writeText(path, text);
    const stored = await this.adapter.readText(path);
    if (stored === null) {
      throw new WorkspaceGenerationError(`${path} was not persisted.`);
    }
    verifyText(path, stored, reference);
  }

  private async validateGeneration(
    slot: WorkspaceManifestSlot,
    manifest: WorkspaceGenerationManifest
  ): Promise<ValidWorkspaceGeneration> {
    const sessions: Session[] = [];

    for (const reference of manifest.sessions) {
      const path = getObjectPath(reference);
      const text = await this.adapter.readText(path);
      if (text === null) {
        throw new WorkspaceGenerationError(`${path} is missing.`);
      }
      verifyText(path, text, reference);
      const parsed = parseJsonText(path, text, value => {
        const values = parseStoredSessions([value]);
        return values[0];
      });
      if (parsed.id !== reference.id) {
        throw new WorkspaceGenerationError(
          `${path} does not contain session ${reference.id}.`
        );
      }
      sessions.push(parsed);
    }

    const settingsText = await this.adapter.readText(getObjectPath(manifest.settings));
    if (settingsText === null) {
      throw new WorkspaceGenerationError('The settings object is missing.');
    }
    verifyText(getObjectPath(manifest.settings), settingsText, manifest.settings);
    const settings = parseJsonText(
      getObjectPath(manifest.settings),
      settingsText,
      value => parseAppSettings(value) as AppSettings
    );

    const instructionsText = await this.adapter.readText(
      getObjectPath(manifest.instructions)
    );
    if (instructionsText === null) {
      throw new WorkspaceGenerationError('The instructions object is missing.');
    }
    verifyText(
      getObjectPath(manifest.instructions),
      instructionsText,
      manifest.instructions
    );
    const instructions = parseJsonText(
      getObjectPath(manifest.instructions),
      instructionsText,
      parseSystemInstructions
    );

    validateWorkspaceReferences({ sessions, settings, instructions });
    const declaredBlobs = new Map(
      manifest.blobs.map(reference => [reference.sha256, reference])
    );
    const referencedBlobs = collectLocalBlobReferences(sessions);
    if (declaredBlobs.size !== referencedBlobs.size) {
      throw new WorkspaceGenerationError(
        'The workspace manifest blob list does not match workspace references.'
      );
    }
    for (const [hash, localReference] of referencedBlobs) {
      const declared = declaredBlobs.get(hash);
      if (!declared || declared.byteLength !== localReference.byteSize) {
        throw new WorkspaceGenerationError(
          `The workspace manifest blob reference ${hash} is inconsistent.`
        );
      }
      const blob = await this.adapter.readBlob(getBlobPath(localReference));
      if (!blob) {
        throw new WorkspaceGenerationError(`Referenced blob ${hash} is missing.`);
      }
      if (blob.size !== declared.byteLength || await sha256Blob(blob) !== hash) {
        throw new WorkspaceGenerationError(`Referenced blob ${hash} is corrupt.`);
      }
    }

    return { manifest, slot, sessions, settings, instructions };
  }

  private async garbageCollect(): Promise<void> {
    const valid = await this.readValidGenerations();
    const retainedObjects = new Set<string>();
    const retainedBlobs = new Set<string>();
    valid.slice(0, 2).forEach(generation => {
      collectManifestObjectHashes(generation.manifest).forEach(hash => {
        retainedObjects.add(`${WORKSPACE_OBJECT_PREFIX}${hash}.json`);
      });
      collectManifestBlobHashes(generation.manifest).forEach(hash => {
        retainedBlobs.add(`${WORKSPACE_BLOB_PREFIX}${hash}`);
      });
    });
    pinnedObjectHashes.forEach((_count, hash) => {
      retainedObjects.add(`${WORKSPACE_OBJECT_PREFIX}${hash}.json`);
    });
    pinnedBlobHashes.forEach((_count, hash) => {
      retainedBlobs.add(`${WORKSPACE_BLOB_PREFIX}${hash}`);
    });
    const stagedCutoff = Date.now() - STAGED_BLOB_RETENTION_MS;
    stagedBlobHashes.forEach((stagedAt, hash) => {
      if (stagedAt >= stagedCutoff) {
        retainedBlobs.add(`${WORKSPACE_BLOB_PREFIX}${hash}`);
      } else {
        stagedBlobHashes.delete(hash);
      }
    });

    const [objectPaths, blobPaths] = await Promise.all([
      this.adapter.list(WORKSPACE_OBJECT_PREFIX),
      this.adapter.list(WORKSPACE_BLOB_PREFIX)
    ]);
    await Promise.all([
      ...objectPaths
        .filter(path => !retainedObjects.has(path))
        .map(path => this.adapter.delete(path)),
      ...blobPaths
        .filter(path => !retainedBlobs.has(path))
        .map(path => this.adapter.delete(path))
    ]);
  }
}
