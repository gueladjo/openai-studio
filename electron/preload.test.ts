import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronAPI } from './bridge';
import { createElectronBridgeMock } from '../test/electronBridge';
import {
  chooseBackupDestination,
  createManagedBackupFilename,
  loadBackupDestination,
  supportsAutomaticBackupDestination
} from '../services/backupDestination';
import { sha256Blob } from '../services/contentAddressing';

describe('Electron preload bridge contract', () => {
  const ipcRenderer = { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  let bridge: ElectronAPI;
  const filename = createManagedBackupFilename(1, 'bridge-test');

  beforeEach(() => {
    vi.resetAllMocks();
    runInNewContext(readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8'), {
      require: (name: string) => {
        expect(name).toBe('electron');
        return {
          ipcRenderer,
          contextBridge: {
            exposeInMainWorld: (key: string, value: ElectronAPI) => {
              expect(key).toBe('electronAPI');
              bridge = value;
            }
          }
        };
      }
    });
    vi.stubGlobal('window', { electronAPI: bridge });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('exposes the complete typed contract and adapts managed backup operations', async () => {
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(createElectronBridgeMock()).sort());
    const archive = new Blob(['backup bytes']);
    const hash = await sha256Blob(archive);
    const files = [{ filename, size: archive.size, lastModified: 1 }];
    ipcRenderer.invoke.mockImplementation(async (channel: string) => {
      switch (channel) {
        case 'backup-choose-directory': return true;
        case 'backup-destination-status': return 'connected';
        case 'backup-write-start': return 'write-1';
        case 'backup-list': return files;
        case 'backup-read': return archive.arrayBuffer();
      }
    });
    expect(supportsAutomaticBackupDestination()).toBe(true);
    const destination = (await chooseBackupDestination())!;
    expect(destination.kind).toBe('electron');
    await expect(destination.getStatus()).resolves.toBe('connected');
    await destination.writeAtomic(filename, archive, hash);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'backup-write-chunk', 'write-1', new TextEncoder().encode('backup bytes')
    );
    expect(ipcRenderer.invoke.mock.calls.at(-1)).toEqual([
      'backup-write-finish', 'write-1', archive.size, hash
    ]);
    await expect(destination.list()).resolves.toEqual(files);
    expect(await (await destination.read(filename)).text()).toBe('backup bytes');
    await destination.delete(filename);
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('backup-delete', filename);
  });

  it('aborts a failed bridge write and leaves web mode without an Electron destination', async () => {
    const error = new Error('Chunk write failed.');
    ipcRenderer.invoke.mockResolvedValueOnce('write-2')
      .mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const destination = (await loadBackupDestination())!;
    await expect(destination.writeAtomic(filename, new Blob(['bytes']), 'expected-hash'))
      .rejects.toBe(error);
    expect(ipcRenderer.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'backup-write-start', 'backup-write-chunk', 'backup-write-abort'
    ]);
    vi.stubGlobal('window', {});
    expect(supportsAutomaticBackupDestination()).toBe(false);
    await expect(loadBackupDestination()).resolves.toBeNull();
  });
});
