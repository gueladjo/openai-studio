export type StorageBackend = 'opfs' | 'indexeddb';

export interface StorageBackendSnapshot {
  backend: StorageBackend;
  available: boolean;
  hasWorkspace: boolean;
  fingerprint: string | null;
  revision: number | null;
  recordCount: number;
}

export interface StorageBackendChoiceRequest {
  kind: 'conflict' | 'migration';
  persistedBackend: StorageBackend | null;
  opfs: StorageBackendSnapshot;
  indexeddb: StorageBackendSnapshot;
}

export type StorageBackendChoice =
  | StorageBackend
  | 'migrate-to-opfs'
  | 'cancel';

export type StorageBackendSelection =
  | {
      kind: 'use';
      backend: StorageBackend;
    }
  | {
      kind: 'prompt';
      request: StorageBackendChoiceRequest;
    }
  | {
      kind: 'error';
      message: string;
    };

interface SelectStorageBackendOptions {
  persistedBackend: StorageBackend | null;
  opfs: StorageBackendSnapshot;
  indexeddb: StorageBackendSnapshot;
  isElectron: boolean;
  readOnly: boolean;
}

const unavailableSelection = (
  backend: StorageBackend,
  isElectron: boolean
): StorageBackendSelection => ({
  kind: 'error',
  message: backend === 'opfs'
    ? (
        isElectron
          ? 'OPFS is unavailable in Electron. Workspace loading stopped instead of opening a fallback store.'
          : 'This workspace is assigned to OPFS, but OPFS is currently unavailable. Workspace loading stopped instead of opening a different store.'
      )
    : 'This workspace is assigned to IndexedDB, but IndexedDB is currently unavailable.'
});

export const selectStorageBackend = ({
  persistedBackend,
  opfs,
  indexeddb,
  isElectron,
  readOnly
}: SelectStorageBackendOptions): StorageBackendSelection => {
  const snapshots = { opfs, indexeddb };

  if (persistedBackend) {
    const persistedSnapshot = snapshots[persistedBackend];
    const otherBackend = persistedBackend === 'opfs' ? 'indexeddb' : 'opfs';
    const otherSnapshot = snapshots[otherBackend];

    if (!persistedSnapshot.available) {
      return unavailableSelection(persistedBackend, isElectron);
    }

    if (!persistedSnapshot.hasWorkspace && otherSnapshot.available && otherSnapshot.hasWorkspace) {
      if (readOnly) {
        return {
          kind: 'error',
          message: 'Storage recovery requires the writer tab to choose which workspace to open.'
        };
      }
      return {
        kind: 'prompt',
        request: {
          kind: 'conflict',
          persistedBackend,
          opfs,
          indexeddb
        }
      };
    }

    if (
      persistedBackend === 'indexeddb' &&
      indexeddb.hasWorkspace &&
      opfs.available &&
      (
        !opfs.hasWorkspace ||
        opfs.fingerprint === indexeddb.fingerprint
      ) &&
      !readOnly
    ) {
      return {
        kind: 'prompt',
        request: {
          kind: 'migration',
          persistedBackend,
          opfs,
          indexeddb
        }
      };
    }

    if (isElectron && persistedBackend === 'indexeddb') {
      return {
        kind: 'error',
        message: 'Electron cannot continue with the IndexedDB fallback. Migrate the workspace to OPFS first.'
      };
    }

    return { kind: 'use', backend: persistedBackend };
  }

  if (opfs.hasWorkspace && indexeddb.hasWorkspace) {
    if (opfs.fingerprint === indexeddb.fingerprint) {
      return { kind: 'use', backend: 'opfs' };
    }

    if (readOnly) {
      return {
        kind: 'error',
        message: 'Both storage backends contain different workspaces. Resolve the conflict in the writer tab.'
      };
    }

    return {
      kind: 'prompt',
      request: {
        kind: 'conflict',
        persistedBackend: null,
        opfs,
        indexeddb
      }
    };
  }

  if (opfs.hasWorkspace) {
    return { kind: 'use', backend: 'opfs' };
  }

  if (indexeddb.hasWorkspace) {
    if (opfs.available && !readOnly) {
      return {
        kind: 'prompt',
        request: {
          kind: 'migration',
          persistedBackend: null,
          opfs,
          indexeddb
        }
      };
    }

    if (isElectron) {
      return {
        kind: 'error',
        message: 'Electron found a workspace in IndexedDB but requires OPFS. Reopen where OPFS is available to migrate it safely.'
      };
    }

    return { kind: 'use', backend: 'indexeddb' };
  }

  if (opfs.available) return { kind: 'use', backend: 'opfs' };
  if (!isElectron && indexeddb.available) return { kind: 'use', backend: 'indexeddb' };

  return unavailableSelection('opfs', isElectron);
};
