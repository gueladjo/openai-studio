export interface StagedWorkspaceFile {
  filename: string;
  text: string;
  validate: (text: string) => void;
}

interface AtomicWorkspaceSnapshotOptions {
  files: StagedWorkspaceFile[];
  writeText: (filename: string, text: string) => Promise<void>;
  readText: (filename: string) => Promise<string | null>;
  deleteFile: (filename: string) => Promise<void>;
  beforeSwitch?: () => Promise<void>;
  switchManifest: () => Promise<void>;
}

const settleAll = async <T>(promises: Promise<T>[]): Promise<T[]> => {
  const results = await Promise.allSettled(promises);
  const rejection = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (rejection) throw rejection.reason;
  return results.map(result => (result as PromiseFulfilledResult<T>).value);
};

export const commitAtomicWorkspaceSnapshot = async ({
  files,
  writeText,
  readText,
  deleteFile,
  beforeSwitch,
  switchManifest
}: AtomicWorkspaceSnapshotOptions): Promise<void> => {
  let switched = false;
  let switchStarted = false;

  try {
    await settleAll(files.map(file => writeText(file.filename, file.text)));
    await settleAll(files.map(async file => {
      const stagedText = await readText(file.filename);
      if (stagedText === null) {
        throw new Error(`Staged workspace file ${file.filename} is missing.`);
      }
      file.validate(stagedText);
    }));
    await beforeSwitch?.();
    switchStarted = true;
    await switchManifest();
    switched = true;
  } finally {
    if (!switched && !switchStarted) {
      await Promise.allSettled(files.map(file => deleteFile(file.filename)));
    }
  }
};
