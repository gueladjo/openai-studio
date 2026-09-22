import {
  AppSettings,
  parseAppSettings,
  parseJsonText,
  parseProjectRemoteState,
  parseProjects,
  parseStoredSessions,
  parseSystemInstructions,
  validateWorkspaceReferences
} from './workspaceSchema';
import {
  LocalBlobReference,
  Project,
  ProjectRemoteState,
  Session,
  SystemInstruction
} from '../types';
import {
  encodeUtf8,
  serializeCanonicalJson,
  sha256Blob,
  sha256Bytes,
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
import { iterateWorkspaceBlobReferences } from './workspaceBlobs';

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
  projects: Project[];
  projectRemoteState: ProjectRemoteState;
}

export interface ValidWorkspaceGeneration extends WorkspaceGenerationData {
  manifest: WorkspaceGenerationManifest;
  slot: WorkspaceManifestSlot;
}

const pinnedObjectHashes = new Map<string, number>();
const pinnedBlobHashes = new Map<string, number>();
const stagedBlobHashes = new Map<string, number>();
const STAGED_BLOB_RETENTION_MS = 60 * 60 * 1000;

// Generations are content-addressed, so a manifest whose bytes have not changed
// since it was last fully validated still describes verified content. Caching
// by manifest text keeps startup and cross-tab updates fully verified while a
// routine save no longer re-hashes every blob in the workspace several times.
const validatedGenerations = new Map<
  WorkspaceManifestSlot,
  { text: string; generation: ValidWorkspaceGeneration }
>();

export const clearValidatedWorkspaceGenerations = (): void => {
  validatedGenerations.clear();
};

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

const createObjectReference = (text: string): ContentObjectReference => ({
  sha256: sha256Text(text),
  byteLength: encodeUtf8(text).byteLength
});

const collectLocalBlobReferences = (
  sessions: Session[],
  projects: Project[]
): Map<string, LocalBlobReference> => {
  const references = new Map<string, LocalBlobReference>();
  for (const reference of iterateWorkspaceBlobReferences(sessions, projects)) {
    const existing = references.get(reference.sha256);
    if (existing && existing.byteSize !== reference.byteSize) {
      throw new WorkspaceGenerationError(
        `Blob ${reference.sha256} has inconsistent byte metadata.`
      );
    }
    references.set(reference.sha256, reference);
  }

  return references;
};

const verifyText = (
  path: string,
  text: string,
  reference: ContentObjectReference
): void => {
  const bytes = encodeUtf8(text);
  if (bytes.byteLength !== reference.byteLength) {
    throw new WorkspaceGenerationError(`${path} has an unexpected byte length.`);
  }
  if (sha256Bytes(bytes) !== reference.sha256) {
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

  // Parses every manifest slot that is syntactically usable without verifying
  // its referenced content; garbage collection retains from all of them.
  private async readManifests(): Promise<Array<{
    slot: WorkspaceManifestSlot;
    text: string;
    manifest: WorkspaceGenerationManifest;
  }>> {
    const records = await Promise.all(
      WORKSPACE_MANIFEST_SLOTS.map(async slot => ({
        slot,
        text: await this.adapter.readText(slot)
      }))
    );
    const manifests: Array<{
      slot: WorkspaceManifestSlot;
      text: string;
      manifest: WorkspaceGenerationManifest;
    }> = [];
    for (const { slot, text } of records) {
      if (text === null) continue;
      try {
        manifests.push({ slot, text, manifest: parseWorkspaceGenerationManifest(text, slot) });
      } catch (error) {
        console.warn(`Ignored incomplete workspace generation ${slot}.`, error);
      }
    }
    return manifests.sort((left, right) => right.manifest.revision - left.manifest.revision);
  }

  async readCurrent(): Promise<ValidWorkspaceGeneration | null> {
    // Validate the newest generation first and stop at the first complete one.
    for (const { slot, text, manifest } of await this.readManifests()) {
      try {
        return await this.validateGeneration(slot, manifest, text);
      } catch (error) {
        console.warn(`Ignored incomplete workspace generation ${slot}.`, error);
      }
    }
    return null;
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
    parseProjects(data.projects);
    parseProjectRemoteState(data.projectRemoteState, data.projects);
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
      const text = serializeCanonicalJson(session);
      return {
        reference: {
          id: session.id,
          ...createObjectReference(text)
        },
        text
      };
    });
    const settingsText = serializeCanonicalJson(data.settings);
    const instructionsText = serializeCanonicalJson(data.instructions);
    const projectsText = serializeCanonicalJson(data.projects);
    const projectRemoteStateText = serializeCanonicalJson(data.projectRemoteState);
    const settings = createObjectReference(settingsText);
    const instructions = createObjectReference(instructionsText);
    const projects = createObjectReference(projectsText);
    const projectRemoteState = createObjectReference(projectRemoteStateText);
    const blobReferences = [...collectLocalBlobReferences(data.sessions, data.projects).values()]
      .sort((left, right) => left.sha256.localeCompare(right.sha256))
      .map(reference => ({
        sha256: reference.sha256,
        byteLength: reference.byteSize
      }));

    await Promise.all([
      ...sessionEntries.map(entry => this.writeObject(entry.reference, entry.text)),
      this.writeObject(settings, settingsText),
      this.writeObject(instructions, instructionsText),
      this.writeObject(projects, projectsText),
      this.writeObject(projectRemoteState, projectRemoteStateText)
    ]);

    // Blobs the validated current generation already references were verified
    // with it; only newly referenced blobs need their bytes hashed now.
    const verifiedBlobs = new Set(
      current?.manifest.blobs.map(reference => `${reference.sha256}:${reference.byteLength}`)
    );
    for (const reference of blobReferences) {
      if (verifiedBlobs.has(`${reference.sha256}:${reference.byteLength}`)) continue;
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
      projects,
      projectRemoteState,
      blobs: blobReferences
    };
    const nextSlot = current?.slot === WORKSPACE_MANIFEST_SLOTS[0]
      ? WORKSPACE_MANIFEST_SLOTS[1]
      : WORKSPACE_MANIFEST_SLOTS[0];
    const manifestText = serializeCanonicalJson(manifest);
    await this.adapter.writeText(nextSlot, manifestText);
    const storedManifestText = await this.adapter.readText(nextSlot);
    if (storedManifestText !== manifestText) {
      throw new WorkspaceGenerationError('The workspace manifest failed read-back verification.');
    }

    const verified = await this.validateGeneration(
      nextSlot,
      parseWorkspaceGenerationManifest(storedManifestText, nextSlot),
      storedManifestText,
      new Set(blobReferences.map(reference => reference.sha256))
    );
    manifest.blobs.forEach(reference => {
      stagedBlobHashes.delete(reference.sha256);
    });
    try {
      await this.garbageCollect();
    } catch (error) {
      // Publication already succeeded; maintenance must not invalidate its revision.
      console.warn(
        'Workspace saved, but garbage collection failed; cleanup will retry on a later save.',
        error
      );
    }
    return verified;
  }

  async storeBlob(blob: Blob, mimeType = blob.type): Promise<LocalBlobReference> {
    const reference: LocalBlobReference = {
      sha256: await sha256Blob(blob),
      byteSize: blob.size,
      ...(mimeType ? { mimeType } : {})
    };
    const path = getBlobPath(reference);
    // Registered before any bytes land so a concurrent save's garbage
    // collection cannot delete the blob between its write and its read-back.
    stagedBlobHashes.set(reference.sha256, Date.now());
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

  // Read without re-verifying the content hash; only for callers whose data
  // was already covered by a generation validation in the same load.
  async readBlobData(reference: LocalBlobReference): Promise<Blob | null> {
    const blob = await this.adapter.readBlob(getBlobPath(reference));
    if (!blob) return null;
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
    manifest: WorkspaceGenerationManifest,
    manifestText: string,
    verifiedBlobHashes: ReadonlySet<string> = new Set()
  ): Promise<ValidWorkspaceGeneration> {
    const cached = validatedGenerations.get(slot);
    if (cached && cached.text === manifestText) return cached.generation;
    validatedGenerations.delete(slot);
    const generation = await this.validateGenerationContent(
      slot,
      manifest,
      verifiedBlobHashes
    );
    validatedGenerations.set(slot, { text: manifestText, generation });
    return generation;
  }

  private async validateGenerationContent(
    slot: WorkspaceManifestSlot,
    manifest: WorkspaceGenerationManifest,
    verifiedBlobHashes: ReadonlySet<string>
  ): Promise<ValidWorkspaceGeneration> {
    const settingsPath = getObjectPath(manifest.settings);
    const instructionsPath = getObjectPath(manifest.instructions);
    const projectsPath = getObjectPath(manifest.projects);
    const projectRemoteStatePath = getObjectPath(manifest.projectRemoteState);
    const [
      sessions,
      settingsText,
      instructionsText,
      projectsText,
      projectRemoteStateText
    ] = await Promise.all([
      Promise.all(manifest.sessions.map(async reference => {
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
        return parsed;
      })),
      this.adapter.readText(settingsPath),
      this.adapter.readText(instructionsPath),
      this.adapter.readText(projectsPath),
      this.adapter.readText(projectRemoteStatePath)
    ]);

    if (settingsText === null) {
      throw new WorkspaceGenerationError('The settings object is missing.');
    }
    verifyText(settingsPath, settingsText, manifest.settings);
    const settings = parseJsonText(
      settingsPath,
      settingsText,
      value => parseAppSettings(value) as AppSettings
    );

    if (instructionsText === null) {
      throw new WorkspaceGenerationError('The instructions object is missing.');
    }
    verifyText(instructionsPath, instructionsText, manifest.instructions);
    const instructions = parseJsonText(
      instructionsPath,
      instructionsText,
      parseSystemInstructions
    );

    if (projectsText === null || projectRemoteStateText === null) {
      throw new WorkspaceGenerationError('The project workspace objects are missing.');
    }
    verifyText(projectsPath, projectsText, manifest.projects);
    const projects = parseJsonText(projectsPath, projectsText, parseProjects);
    verifyText(
      projectRemoteStatePath,
      projectRemoteStateText,
      manifest.projectRemoteState
    );
    const projectRemoteState = parseJsonText(
      projectRemoteStatePath,
      projectRemoteStateText,
      value => parseProjectRemoteState(value, projects)
    );

    validateWorkspaceReferences({ sessions, settings, instructions, projects });
    const declaredBlobs = new Map(
      manifest.blobs.map(reference => [reference.sha256, reference])
    );
    const referencedBlobs = collectLocalBlobReferences(sessions, projects);
    if (declaredBlobs.size !== referencedBlobs.size) {
      throw new WorkspaceGenerationError(
        'The workspace manifest blob list does not match workspace references.'
      );
    }
    await Promise.all([...referencedBlobs].map(async ([hash, localReference]) => {
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
      if (blob.size !== declared.byteLength) {
        throw new WorkspaceGenerationError(`Referenced blob ${hash} is corrupt.`);
      }
      if (verifiedBlobHashes.has(hash)) return;
      if (await sha256Blob(blob) !== hash) {
        throw new WorkspaceGenerationError(`Referenced blob ${hash} is corrupt.`);
      }
    }));

    return {
      manifest,
      slot,
      sessions,
      settings,
      instructions,
      projects,
      projectRemoteState
    };
  }

  private async garbageCollect(): Promise<void> {
    // Listed first: a blob is staged before its bytes are written, so any
    // blob that can appear here is already staged, pinned, or published when
    // the retained set is computed afterwards. Computing it first let a blob
    // stored during the listing be deleted after its store had verified it.
    const [objectPaths, blobPaths] = await Promise.all([
      this.adapter.list(WORKSPACE_OBJECT_PREFIX),
      this.adapter.list(WORKSPACE_BLOB_PREFIX)
    ]);
    // Every parseable manifest keeps its content, verified or not, so cleanup
    // never needs to re-read objects or re-hash blobs.
    const manifests = await this.readManifests();
    const retainedObjects = new Set<string>();
    const retainedBlobs = new Set<string>();
    manifests.forEach(({ manifest }) => {
      collectManifestObjectHashes(manifest).forEach(hash => {
        retainedObjects.add(`${WORKSPACE_OBJECT_PREFIX}${hash}.json`);
      });
      collectManifestBlobHashes(manifest).forEach(hash => {
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
