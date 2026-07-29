import {
  getWorkspaceRevision,
  readInternalRecoveryArchive,
  readWorkspaceSnapshot,
  replaceWorkspaceSnapshot,
  writeInternalRecoveryArchive
} from './storage';
import {
  BackupArchiveProgress,
  BackupArchivePreview,
  createWorkspaceArchive,
  inspectWorkspaceArchive,
  stageWorkspaceArchiveBlobs
} from './workspaceArchive';

export interface RestoreWorkspaceResult {
  restored: BackupArchivePreview;
  recovery: BackupArchivePreview;
  revision: number;
}

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

  const recoveryArchive = await createWorkspaceArchive(current, {
    reason: 'pre-restore',
    signal: options.signal,
    onProgress: options.onProgress
  });
  const recovery = await inspectWorkspaceArchive(recoveryArchive, {
    signal: options.signal,
    onProgress: options.onProgress,
    retainBlobs: false
  });
  const recoveryFilename = (
    `openai-studio-recovery-${new Date(recovery.manifest.createdAt).toISOString()
      .replace(/[:.]/g, '-')}.zip`
  );
  if (options.onRecoveryArchive) {
    await options.onRecoveryArchive(recoveryArchive, recoveryFilename);
  } else {
    await writeInternalRecoveryArchive(dirHandle, recoveryArchive);
    const stored = await readInternalRecoveryArchive(dirHandle);
    if (!stored) throw new Error('The pre-restore recovery point is missing.');
    const verifiedStored = await inspectWorkspaceArchive(stored, {
      retainBlobs: false
    });
    if (verifiedStored.preview.sha256 !== recovery.preview.sha256) {
      throw new Error('The pre-restore recovery point failed read-back verification.');
    }
  }

  await stageWorkspaceArchiveBlobs(
    dirHandle,
    archive,
    target.manifest,
    options.signal
  );
  const revision = await replaceWorkspaceSnapshot(
    dirHandle,
    target.replacement
  );
  return {
    restored: target.preview,
    recovery: recovery.preview,
    revision
  };
};

export const undoLastWorkspaceRestore = async (
  dirHandle: FileSystemDirectoryHandle
): Promise<BackupArchivePreview> => {
  const recoveryArchive = await readInternalRecoveryArchive(dirHandle);
  if (!recoveryArchive) {
    throw new Error('No verified pre-restore recovery point is available.');
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
  return recovery.preview;
};
