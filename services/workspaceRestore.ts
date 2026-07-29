import {
  clearInternalRecoveryArchive,
  getWorkspaceRevision,
  readInternalRecoveryArchive,
  readWorkspaceSnapshot,
  replaceWorkspaceSnapshot,
  WorkspaceSnapshot,
  writeInternalRecoveryArchive
} from './storage';
import {
  BackupArchiveProgress,
  BackupArchivePreview,
  BackupReason,
  createWorkspaceArchive,
  inspectWorkspaceArchive,
  stageWorkspaceArchiveBlobs
} from './workspaceArchive';

export type WorkspaceRecoveryAction = 'restore' | 'merge';

export interface RestoreWorkspaceResult {
  restored: BackupArchivePreview;
  recovery: BackupArchivePreview;
  revision: number;
}

interface WorkspaceRecoveryOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BackupArchiveProgress) => void;
  onRecoveryArchive?: (archive: Blob, filename: string) => Promise<void>;
}

const getRecoveryReason = (
  action: WorkspaceRecoveryAction
): Extract<BackupReason, 'pre-restore' | 'pre-merge'> => (
  action === 'restore' ? 'pre-restore' : 'pre-merge'
);

const restorePreviousRecovery = async (
  dirHandle: FileSystemDirectoryHandle,
  previousArchive: Blob | null
): Promise<void> => {
  if (previousArchive) {
    await writeInternalRecoveryArchive(dirHandle, previousArchive);
  } else {
    await clearInternalRecoveryArchive(dirHandle);
  }
};

export const runWithVerifiedWorkspaceRecovery = async <T>(
  dirHandle: FileSystemDirectoryHandle,
  current: WorkspaceSnapshot,
  action: WorkspaceRecoveryAction,
  operation: () => Promise<T>,
  options: WorkspaceRecoveryOptions = {}
): Promise<{ result: T; recovery: BackupArchivePreview }> => {
  let previousArchive: Blob | null;
  try {
    previousArchive = await readInternalRecoveryArchive(dirHandle);
  } catch (error) {
    current.release?.();
    throw error;
  }
  let recoveryWriteAttempted = false;

  try {
    const recoveryArchive = await createWorkspaceArchive(current, {
      reason: getRecoveryReason(action),
      signal: options.signal,
      onProgress: options.onProgress
    });
    const recovery = await inspectWorkspaceArchive(recoveryArchive, {
      signal: options.signal,
      onProgress: options.onProgress,
      retainBlobs: false
    });
    const recoveryFilename = (
      `openai-studio-recovery-${action}-${new Date(recovery.manifest.createdAt)
        .toISOString().replace(/[:.]/g, '-')}.zip`
    );

    recoveryWriteAttempted = true;
    await writeInternalRecoveryArchive(dirHandle, recoveryArchive);
    const stored = await readInternalRecoveryArchive(dirHandle);
    if (!stored) throw new Error(`The pre-${action} recovery point is missing.`);
    const verifiedStored = await inspectWorkspaceArchive(stored, {
      signal: options.signal,
      retainBlobs: false
    });
    if (verifiedStored.preview.sha256 !== recovery.preview.sha256) {
      throw new Error(
        `The pre-${action} recovery point failed read-back verification.`
      );
    }
    await options.onRecoveryArchive?.(recoveryArchive, recoveryFilename);

    return {
      result: await operation(),
      recovery: recovery.preview
    };
  } catch (error) {
    if (recoveryWriteAttempted) {
      try {
        await restorePreviousRecovery(dirHandle, previousArchive);
      } catch (rollbackError) {
        console.error(
          'The previous workspace recovery point could not be restored.',
          rollbackError
        );
      }
    } else {
      current.release?.();
    }
    throw error;
  }
};

export const restoreWorkspaceArchive = async (
  dirHandle: FileSystemDirectoryHandle,
  archive: Blob,
  options: {
    filename?: string;
    signal?: AbortSignal;
    onProgress?: (progress: BackupArchiveProgress) => void;
    onRecoveryArchive?: (archive: Blob, filename: string) => Promise<void>;
  } = {}
): Promise<RestoreWorkspaceResult> => {
  const target = await inspectWorkspaceArchive(archive, {
    filename: options.filename,
    signal: options.signal,
    onProgress: options.onProgress,
    retainBlobs: false
  });
  const current = await readWorkspaceSnapshot(dirHandle);
  if (current.revision !== getWorkspaceRevision()) {
    current.release?.();
    throw new Error('The workspace changed while restore validation was running.');
  }

  const recovered = await runWithVerifiedWorkspaceRecovery(
    dirHandle,
    current,
    'restore',
    async () => {
      await stageWorkspaceArchiveBlobs(
        dirHandle,
        archive,
        target.manifest,
        options.signal
      );
      return replaceWorkspaceSnapshot(dirHandle, target.replacement);
    },
    options
  );
  return {
    restored: target.preview,
    recovery: recovered.recovery,
    revision: recovered.result
  };
};

export const undoLastWorkspaceMutation = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<BackupArchivePreview> => {
  const recoveryArchive = await readInternalRecoveryArchive(dirHandle);
  if (!recoveryArchive) {
    throw new Error('No verified workspace recovery point is available.');
  }
  const recovery = await inspectWorkspaceArchive(recoveryArchive, {
    retainBlobs: false
  });
  await stageWorkspaceArchiveBlobs(
    dirHandle,
    recoveryArchive,
    recovery.manifest
  );
  await replaceWorkspaceSnapshot(dirHandle, recovery.replacement);
  await clearInternalRecoveryArchive(dirHandle);
  return recovery.preview;
};

export const getLastWorkspaceRecoveryAction = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<WorkspaceRecoveryAction | null> => {
  const recoveryArchive = await readInternalRecoveryArchive(dirHandle);
  if (!recoveryArchive) return null;
  const recovery = await inspectWorkspaceArchive(recoveryArchive, {
    retainBlobs: false
  });
  if (recovery.manifest.workspaceRevision >= getWorkspaceRevision()) {
    return null;
  }
  if (recovery.manifest.reason === 'pre-merge') return 'merge';
  if (recovery.manifest.reason === 'pre-restore') return 'restore';
  return null;
};

export const undoLastWorkspaceRestore = undoLastWorkspaceMutation;
