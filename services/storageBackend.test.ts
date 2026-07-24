import { describe, expect, it } from 'vitest';
import {
  selectStorageBackend,
  StorageBackendSnapshot
} from './storageBackend';

const snapshot = (
  backend: StorageBackendSnapshot['backend'],
  options: Partial<StorageBackendSnapshot> = {}
): StorageBackendSnapshot => ({
  backend,
  available: true,
  hasWorkspace: false,
  fingerprint: null,
  revision: null,
  recordCount: 0,
  ...options
});

describe('selectStorageBackend', () => {
  it('keeps a persisted backend when both stores contain different data', () => {
    const selection = selectStorageBackend({
      persistedBackend: 'indexeddb',
      opfs: snapshot('opfs', { hasWorkspace: true, fingerprint: 'opfs' }),
      indexeddb: snapshot('indexeddb', { hasWorkspace: true, fingerprint: 'idb' }),
      isElectron: false,
      readOnly: false
    });

    expect(selection).toEqual({ kind: 'use', backend: 'indexeddb' });
  });

  it('requests a conflict decision when both unassigned stores differ', () => {
    const selection = selectStorageBackend({
      persistedBackend: null,
      opfs: snapshot('opfs', { hasWorkspace: true, fingerprint: 'opfs' }),
      indexeddb: snapshot('indexeddb', { hasWorkspace: true, fingerprint: 'idb' }),
      isElectron: false,
      readOnly: false
    });

    expect(selection.kind).toBe('prompt');
    if (selection.kind === 'prompt') {
      expect(selection.request.kind).toBe('conflict');
    }
  });

  it('offers to migrate an IndexedDB workspace when OPFS becomes available', () => {
    const selection = selectStorageBackend({
      persistedBackend: 'indexeddb',
      opfs: snapshot('opfs'),
      indexeddb: snapshot('indexeddb', { hasWorkspace: true, fingerprint: 'idb' }),
      isElectron: false,
      readOnly: false
    });

    expect(selection.kind).toBe('prompt');
    if (selection.kind === 'prompt') {
      expect(selection.request.kind).toBe('migration');
    }
  });

  it('lets a writer finish an identical interrupted migration copy', () => {
    const selection = selectStorageBackend({
      persistedBackend: 'indexeddb',
      opfs: snapshot('opfs', { hasWorkspace: true, fingerprint: 'same' }),
      indexeddb: snapshot('indexeddb', { hasWorkspace: true, fingerprint: 'same' }),
      isElectron: false,
      readOnly: false
    });

    expect(selection.kind).toBe('prompt');
    if (selection.kind === 'prompt') {
      expect(selection.request.kind).toBe('migration');
    }
  });

  it('keeps reader tabs on the persisted source during migration', () => {
    expect(selectStorageBackend({
      persistedBackend: 'indexeddb',
      opfs: snapshot('opfs'),
      indexeddb: snapshot('indexeddb', { hasWorkspace: true, fingerprint: 'idb' }),
      isElectron: false,
      readOnly: true
    })).toEqual({ kind: 'use', backend: 'indexeddb' });
  });

  it('requests recovery when the persisted store is empty but the other has data', () => {
    const selection = selectStorageBackend({
      persistedBackend: 'opfs',
      opfs: snapshot('opfs'),
      indexeddb: snapshot('indexeddb', { hasWorkspace: true, fingerprint: 'idb' }),
      isElectron: false,
      readOnly: false
    });

    expect(selection.kind).toBe('prompt');
    if (selection.kind === 'prompt') {
      expect(selection.request.kind).toBe('conflict');
    }
  });

  it('never falls back when the persisted OPFS backend is unavailable', () => {
    const selection = selectStorageBackend({
      persistedBackend: 'opfs',
      opfs: snapshot('opfs', { available: false }),
      indexeddb: snapshot('indexeddb', { hasWorkspace: true, fingerprint: 'idb' }),
      isElectron: false,
      readOnly: false
    });

    expect(selection.kind).toBe('error');
  });

  it('selects OPFS for a new workspace', () => {
    expect(selectStorageBackend({
      persistedBackend: null,
      opfs: snapshot('opfs'),
      indexeddb: snapshot('indexeddb'),
      isElectron: false,
      readOnly: false
    })).toEqual({ kind: 'use', backend: 'opfs' });
  });
});
