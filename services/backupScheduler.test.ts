import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type Session } from '../types';
import type {
  BackupDestination,
  ManagedBackupFile
} from './backupDestination';
import type { WorkspaceSnapshot } from './storage';

const harness = vi.hoisted(() => ({
  revision: 1
}));

const session: Session = {
  id: 'session-1',
  title: 'Scheduler',
  messages: [],
  config: { ...DEFAULT_CONFIG, tools: { ...DEFAULT_CONFIG.tools } },
  lastModified: 1
};

const snapshot = (): WorkspaceSnapshot => ({
  revision: harness.revision,
  createdAt: Date.now(),
  sessions: [session],
  settings: {
    theme: 'dark',
    apiKey: 'local-only',
    lastActiveSessionId: session.id
  },
  instructions: [],
  readBlob: async () => {
    throw new Error('No blobs are referenced.');
  }
});

vi.mock('./storage', () => ({
  getWorkspaceRevision: () => harness.revision,
  readWorkspaceSnapshot: () => Promise.resolve(snapshot())
}));

import {
  BackupScheduler,
  STARTUP_BACKUP_DELAY_MS
} from './backupScheduler';

class MemoryLocalStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) || null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MemoryBackupDestination implements BackupDestination {
  readonly kind = 'file-system-access' as const;
  readonly files = new Map<string, Blob>();
  private modified = 1;
  failWrites = false;
  reads = 0;

  async getStatus() {
    return 'connected' as const;
  }

  async writeAtomic(filename: string, archive: Blob): Promise<void> {
    if (this.failWrites) throw new Error('Destination write failed.');
    this.files.set(filename, archive);
    this.modified += 1;
  }

  async list(): Promise<ManagedBackupFile[]> {
    return [...this.files].map(([filename, blob], index) => ({
      filename,
      size: blob.size,
      lastModified: this.modified + index
    }));
  }

  async read(filename: string): Promise<Blob> {
    this.reads += 1;
    const file = this.files.get(filename);
    if (!file) throw new Error('Missing backup.');
    return file;
  }

  async delete(filename: string): Promise<void> {
    this.files.delete(filename);
  }
}

describe('backup scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T14:00:00'));
    harness.revision = 1;
    vi.stubGlobal('window', {
      localStorage: new MemoryLocalStorage(),
      setTimeout,
      clearTimeout
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('backs up changed revisions at most once per local day', async () => {
    const destination = new MemoryBackupDestination();
    const scheduler = new BackupScheduler({
      dirHandle: {} as FileSystemDirectoryHandle,
      destination,
      supported: true,
      canRun: () => true,
      onStateChange: () => undefined
    });
    await scheduler.initialize();
    expect(destination.files.size).toBe(0);

    await scheduler.setEnabled(true);
    expect(destination.files.size).toBe(0);
    await vi.advanceTimersByTimeAsync(STARTUP_BACKUP_DELAY_MS - 1);
    expect(destination.files.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await scheduler.evaluate();
    expect(destination.files.size).toBe(1);
    await scheduler.evaluate();
    expect(destination.files.size).toBe(1);

    harness.revision = 2;
    await scheduler.evaluate();
    expect(destination.files.size).toBe(1);

    vi.setSystemTime(new Date('2026-07-30T09:00:00'));
    await scheduler.evaluate();
    expect(destination.files.size).toBe(2);
  });

  it('loads managed-file metadata without validating archives during startup', async () => {
    const destination = new MemoryBackupDestination();
    const filename =
      'openai-studio-backup-2026-07-28T09-00-00-000Z-unverified_id.zip';
    destination.files.set(
      filename,
      new Blob(['not inspected yet'], { type: 'application/zip' })
    );
    const scheduler = new BackupScheduler({
      dirHandle: {} as FileSystemDirectoryHandle,
      destination,
      supported: true,
      canRun: () => true,
      onStateChange: () => undefined
    });

    await scheduler.initialize();

    expect(destination.reads).toBe(0);
    expect(scheduler.currentState.backups).toMatchObject([{
      filename,
      integrity: 'unverified'
    }]);

    await scheduler.refresh();
    expect(destination.reads).toBe(1);
    expect(scheduler.currentState.backups[0].integrity).toBe('corrupt');
  });

  it('retains exactly the three newest verified managed backups', async () => {
    const destination = new MemoryBackupDestination();
    const scheduler = new BackupScheduler({
      dirHandle: {} as FileSystemDirectoryHandle,
      destination,
      supported: true,
      canRun: () => true,
      onStateChange: () => undefined
    });

    for (let index = 0; index < 5; index += 1) {
      harness.revision += 1;
      vi.setSystemTime(new Date(`2026-08-0${index + 1}T09:00:00`));
      await scheduler.backUpNow();
    }
    expect(destination.files.size).toBe(3);
    expect(scheduler.currentState.backups).toHaveLength(3);
    expect(scheduler.currentState.backups.every(item => item.integrity === 'valid'))
      .toBe(true);
  });

  it('surfaces a due close-time backup failure to the close handshake', async () => {
    const destination = new MemoryBackupDestination();
    const scheduler = new BackupScheduler({
      dirHandle: {} as FileSystemDirectoryHandle,
      destination,
      supported: true,
      canRun: () => true,
      onStateChange: () => undefined
    });
    await scheduler.setEnabled(true);
    destination.failWrites = true;

    await expect(scheduler.runDueForClose()).rejects.toThrow(
      'Destination write failed'
    );
    expect(scheduler.currentState.error).toContain('Destination write failed');
  });

  it('does not reread a newly verified destination backup', async () => {
    const destination = new MemoryBackupDestination();
    const scheduler = new BackupScheduler({
      dirHandle: {} as FileSystemDirectoryHandle,
      destination,
      supported: true,
      canRun: () => true,
      onStateChange: () => undefined
    });

    await scheduler.backUpNow();

    expect(destination.reads).toBe(0);
    expect(scheduler.currentState.backups).toHaveLength(1);
    expect(scheduler.currentState.backups[0].integrity).toBe('valid');
  });

  it('does not count a corrupt file and removes it only after a replacement verifies', async () => {
    const destination = new MemoryBackupDestination();
    const corruptFilename =
      'openai-studio-backup-2026-07-28T09-00-00-000Z-corrupt_id.zip';
    destination.files.set(
      corruptFilename,
      new Blob(['corrupt'], { type: 'application/zip' })
    );
    const scheduler = new BackupScheduler({
      dirHandle: {} as FileSystemDirectoryHandle,
      destination,
      supported: true,
      canRun: () => true,
      onStateChange: () => undefined
    });
    await scheduler.refresh();
    expect(scheduler.currentState.backups).toMatchObject([{
      filename: corruptFilename,
      integrity: 'corrupt'
    }]);

    destination.reads = 0;
    await scheduler.backUpNow();
    expect(destination.reads).toBe(1);
    expect(destination.files.has(corruptFilename)).toBe(false);
    expect(scheduler.currentState.backups).toHaveLength(1);
    expect(scheduler.currentState.backups[0].integrity).toBe('valid');
  });
});
