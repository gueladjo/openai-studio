import {
  FileAttachment,
  Message,
  Session,
  SystemInstruction
} from '../types';
import {
  getWorkspaceRevision,
  readWorkspaceSnapshot,
  replaceWorkspaceSnapshot,
  WorkspaceReplacement,
  WorkspaceSnapshot
} from './storage';
import {
  parseStoredSessions,
  parseSystemInstructions,
  validateWorkspaceReferences
} from './workspaceSchema';
import {
  BackupArchiveProgress,
  BackupArchivePreview,
  inspectWorkspaceArchive,
  stageWorkspaceArchiveBlobs
} from './workspaceArchive';
import { runWithVerifiedWorkspaceRecovery } from './workspaceRestore';

export interface WorkspaceMergeCounts {
  imported: number;
  skipped: number;
  divergent: number;
}

export interface WorkspaceMergeResult {
  revision: number;
  recovery: BackupArchivePreview;
  counts: WorkspaceMergeCounts;
}

export interface WorkspaceMergePlan {
  replacement: WorkspaceReplacement;
  importedBlobHashes: ReadonlySet<string>;
  counts: WorkspaceMergeCounts;
}

const serializeCanonical = (value: unknown): string => JSON.stringify(
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
        .filter(([key]) => key !== 'previewUrl')
        .sort(([left], [right]) => left.localeCompare(right))
    );
  }
);

const instructionContentKey = (instruction: SystemInstruction): string => (
  serializeCanonical({
    title: instruction.title,
    content: instruction.content
  })
);

const serializeSessionContent = (session: Session): string => {
  const { systemInstructionId: _instructionId, ...config } = session.config;
  return serializeCanonical({
    ...session,
    config
  });
};

const referencedInstructionsMatch = (
  local: Session,
  imported: Session,
  localById: ReadonlyMap<string, SystemInstruction>,
  importedById: ReadonlyMap<string, SystemInstruction>
): boolean => {
  const localId = local.config.systemInstructionId;
  const importedId = imported.config.systemInstructionId;
  if (localId === undefined || importedId === undefined) {
    return localId === importedId;
  }
  const localInstruction = localById.get(localId);
  const importedInstruction = importedById.get(importedId);
  return Boolean(
    localInstruction &&
    importedInstruction &&
    instructionContentKey(localInstruction) === instructionContentKey(importedInstruction)
  );
};

const createUniqueId = (
  original: string,
  used: Set<string>,
  maximumLength = 256
): string => {
  let sequence = 1;
  while (true) {
    const suffix = sequence === 1 ? '-merged' : `-merged-${sequence}`;
    const prefix = original.slice(0, maximumLength - suffix.length);
    const candidate = `${prefix}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    sequence += 1;
  }
};

const collectIds = (sessions: Session[]) => {
  const sessionIds = new Set<string>();
  const messageIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const requestIds = new Set<string>();

  sessions.forEach(session => {
    sessionIds.add(session.id);
    session.messages.forEach(message => {
      if (message.id) messageIds.add(message.id);
      if (message.requestId) requestIds.add(message.requestId);
      message.attachments?.forEach(attachment => {
        if (attachment.id) attachmentIds.add(attachment.id);
      });
    });
    if (session.pendingRequest) requestIds.add(session.pendingRequest.id);
  });
  return { sessionIds, messageIds, attachmentIds, requestIds };
};

const remapOptionalId = (
  id: string | undefined,
  used: Set<string>,
  mapping: Map<string, string>,
  force: boolean,
  maximumLength = 256
): string | undefined => {
  if (id === undefined) return undefined;
  const existing = mapping.get(id);
  if (existing) return existing;
  const mapped = force || used.has(id)
    ? createUniqueId(id, used, maximumLength)
    : id;
  used.add(mapped);
  mapping.set(id, mapped);
  return mapped;
};

const remapAttachment = (
  attachment: FileAttachment,
  usedIds: Set<string>,
  mapping: Map<string, string>,
  force: boolean
): FileAttachment => {
  const id = remapOptionalId(attachment.id, usedIds, mapping, force, 128);
  return {
    ...attachment,
    ...(id === undefined ? {} : { id })
  };
};

const remapSession = (
  session: Session,
  instructionId: string | undefined,
  usedIds: ReturnType<typeof collectIds>,
  force: boolean
): Session => {
  const sessionId = force || usedIds.sessionIds.has(session.id)
    ? createUniqueId(session.id, usedIds.sessionIds)
    : session.id;
  usedIds.sessionIds.add(sessionId);

  const messageIdMap = new Map<string, string>();
  const attachmentIdMap = new Map<string, string>();
  const requestIdMap = new Map<string, string>();
  const messages = session.messages.map((message): Message => {
    const id = remapOptionalId(
      message.id,
      usedIds.messageIds,
      messageIdMap,
      force
    );
    const requestId = remapOptionalId(
      message.requestId,
      usedIds.requestIds,
      requestIdMap,
      force
    );
    return {
      ...message,
      ...(id === undefined ? {} : { id }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(message.attachments
        ? {
            attachments: message.attachments.map(attachment => (
              remapAttachment(
                attachment,
                usedIds.attachmentIds,
                attachmentIdMap,
                force
              )
            ))
          }
        : {})
    };
  });
  const pendingRequest = session.pendingRequest
    ? {
        ...session.pendingRequest,
        id: remapOptionalId(
          session.pendingRequest.id,
          usedIds.requestIds,
          requestIdMap,
          force
        )!,
        userMessageId: remapOptionalId(
          session.pendingRequest.userMessageId,
          usedIds.messageIds,
          messageIdMap,
          force
        )!,
        ...(session.pendingRequest.assistantMessageId
          ? {
              assistantMessageId: remapOptionalId(
                session.pendingRequest.assistantMessageId,
                usedIds.messageIds,
                messageIdMap,
                force
              )
            }
          : {})
      }
    : undefined;

  return {
    ...session,
    id: sessionId,
    messages,
    config: {
      ...session.config,
      ...(instructionId === undefined
        ? { systemInstructionId: undefined }
        : { systemInstructionId: instructionId })
    },
    ...(pendingRequest ? { pendingRequest } : {})
  };
};

const collectBlobHashes = (sessions: Session[]): Set<string> => {
  const hashes = new Set<string>();
  sessions.forEach(session => {
    session.messages.forEach(message => {
      message.attachments?.forEach(attachment => {
        if (attachment.localBlob) hashes.add(attachment.localBlob.sha256);
      });
      message.generatedFiles?.forEach(file => {
        if (file.localBlob) hashes.add(file.localBlob.sha256);
      });
    });
  });
  return hashes;
};

export const createWorkspaceMergePlan = (
  current: Pick<WorkspaceSnapshot, 'sessions' | 'settings' | 'instructions'>,
  imported: WorkspaceReplacement
): WorkspaceMergePlan => {
  const localSessionsById = new Map(
    current.sessions.map(session => [session.id, session])
  );
  const localInstructionsById = new Map(
    current.instructions.map(instruction => [instruction.id, instruction])
  );
  const importedInstructionsById = new Map(
    imported.instructions.map(instruction => [instruction.id, instruction])
  );
  const accepted = imported.sessions.flatMap(session => {
    const local = localSessionsById.get(session.id);
    const isIdentical = Boolean(
      local &&
      serializeSessionContent(local) === serializeSessionContent(session) &&
      referencedInstructionsMatch(
        local,
        session,
        localInstructionsById,
        importedInstructionsById
      )
    );
    return isIdentical
      ? []
      : [{ session, divergent: Boolean(local) }];
  });

  const instructions = current.instructions.map(instruction => ({ ...instruction }));
  const instructionsByContent = new Map(
    instructions.map(instruction => [instructionContentKey(instruction), instruction])
  );
  const usedInstructionIds = new Set(instructions.map(instruction => instruction.id));
  const instructionIdMap = new Map<string, string>();
  const resolveInstructionId = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    const resolved = instructionIdMap.get(id);
    if (resolved) return resolved;
    const importedInstruction = importedInstructionsById.get(id);
    if (!importedInstruction) {
      throw new Error(`Imported instruction "${id}" is missing.`);
    }
    const identical = instructionsByContent.get(
      instructionContentKey(importedInstruction)
    );
    if (identical) {
      instructionIdMap.set(id, identical.id);
      return identical.id;
    }
    const nextId = usedInstructionIds.has(id)
      ? createUniqueId(id, usedInstructionIds)
      : id;
    usedInstructionIds.add(nextId);
    const nextInstruction = { ...importedInstruction, id: nextId };
    instructions.push(nextInstruction);
    instructionsByContent.set(instructionContentKey(nextInstruction), nextInstruction);
    instructionIdMap.set(id, nextId);
    return nextId;
  };

  const usedIds = collectIds(current.sessions);
  const importedSessions = accepted.map(({ session, divergent }) => (
    remapSession(
      session,
      resolveInstructionId(session.config.systemInstructionId),
      usedIds,
      divergent
    )
  ));
  const currentEntries = current.sessions.map((session, index) => ({
    session,
    source: 0,
    index
  }));
  const importedEntries = importedSessions.map((session, index) => ({
    session,
    source: 1,
    index
  }));
  const sessions = [...currentEntries, ...importedEntries]
    .sort((left, right) => (
      right.session.lastModified - left.session.lastModified ||
      left.source - right.source ||
      left.index - right.index
    ))
    .map(entry => entry.session);

  parseStoredSessions(sessions);
  parseSystemInstructions(instructions);
  validateWorkspaceReferences({
    sessions,
    settings: current.settings,
    instructions
  });

  return {
    replacement: {
      sessions,
      settings: {
        theme: current.settings.theme,
        ...(current.settings.lastActiveSessionId
          ? { lastActiveSessionId: current.settings.lastActiveSessionId }
          : {})
      },
      instructions,
      blobs: new Map()
    },
    importedBlobHashes: collectBlobHashes(importedSessions),
    counts: {
      imported: importedSessions.length,
      skipped: imported.sessions.length - importedSessions.length,
      divergent: accepted.filter(item => item.divergent).length
    }
  };
};

export const mergeWorkspaceArchive = async (
  dirHandle: FileSystemDirectoryHandle,
  archive: Blob,
  options: {
    filename?: string;
    signal?: AbortSignal;
    onProgress?: (progress: BackupArchiveProgress) => void;
    onRecoveryArchive?: (archive: Blob, filename: string) => Promise<void>;
  } = {}
): Promise<WorkspaceMergeResult> => {
  const target = await inspectWorkspaceArchive(archive, {
    filename: options.filename,
    signal: options.signal,
    onProgress: options.onProgress,
    retainBlobs: false
  });
  const current = await readWorkspaceSnapshot(dirHandle);
  if (current.revision !== getWorkspaceRevision()) {
    current.release?.();
    throw new Error('The workspace changed while merge validation was running.');
  }

  let plan: WorkspaceMergePlan;
  try {
    plan = createWorkspaceMergePlan(current, target.replacement);
  } catch (error) {
    current.release?.();
    throw error;
  }

  const recovered = await runWithVerifiedWorkspaceRecovery(
    dirHandle,
    current,
    'merge',
    async () => {
      await stageWorkspaceArchiveBlobs(
        dirHandle,
        archive,
        target.manifest,
        options.signal,
        plan.importedBlobHashes
      );
      return replaceWorkspaceSnapshot(dirHandle, plan.replacement);
    },
    options
  );
  return {
    revision: recovered.result,
    recovery: recovered.recovery,
    counts: plan.counts
  };
};
