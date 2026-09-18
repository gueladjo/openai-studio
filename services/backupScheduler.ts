import {
  BackupDestination,
  BackupDestinationStatus,
  createManagedBackupFilename,
  ManagedBackupFile
} from './backupDestination';
import { getWorkspaceRevision, readWorkspaceSnapshot } from './storage';
import {
  BackupArchivePreview,
  createWorkspaceArchive,
  inspectWorkspaceArchive,
  UnsupportedArchiveVersionError
} from './workspaceArchive';

const BACKUP_PREFERENCES_KEY = 'openai-studio-backup-scheduler-v1';
export const STARTUP_BACKUP_DELAY_MS = 30_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

interface BackupSchedulerPreferences {
  enabled: boolean;
  lastRevision?: number;
  lastAutomaticLocalDay?: string;
  lastSuccessAt?: number;
}

export interface ManagedBackupStatus extends ManagedBackupFile {
  integrity: 'unverified' | 'valid' | 'corrupt';
  preview?: BackupArchivePreview;
  error?: string;
}

export interface BackupSchedulerState {
  supported: boolean;
  enabled: boolean;
  destinationStatus: BackupDestinationStatus;
  running: boolean;
  lastSuccessAt?: number;
  nextDueAt?: number;
  error?: string;
  warning?: string;
  backups: ManagedBackupStatus[];
}

const describeError = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const getLocalDay = (timestamp: number): string => {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
};

const getNextLocalDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1
  ).getTime();
};

const readPreferences = (): BackupSchedulerPreferences => {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(BACKUP_PREFERENCES_KEY) || '{}'
    ) as Partial<BackupSchedulerPreferences>;
    return {
      enabled: value.enabled === true,
      ...(Number.isSafeInteger(value.lastRevision) && (value.lastRevision as number) >= 0
        ? { lastRevision: value.lastRevision }
        : {}),
      ...(typeof value.lastAutomaticLocalDay === 'string'
        ? { lastAutomaticLocalDay: value.lastAutomaticLocalDay }
        : {}),
      ...(Number.isSafeInteger(value.lastSuccessAt) && (value.lastSuccessAt as number) >= 0
        ? { lastSuccessAt: value.lastSuccessAt }
        : {})
    };
  } catch {
    return { enabled: false };
  }
};

const writePreferences = (preferences: BackupSchedulerPreferences): void => {
  window.localStorage.setItem(
    BACKUP_PREFERENCES_KEY,
    JSON.stringify(preferences)
  );
};

export class BackupScheduler {
  private preferences = readPreferences();
  private destination: BackupDestination | null;
  private retryIndex = 0;
  private retryTimer: number | null = null;
  private startupTimer: number | null = null;
  private readonly startupEligibleAt = Date.now() + STARTUP_BACKUP_DELAY_MS;
  private runningPromise: Promise<BackupArchivePreview | null> | null = null;
  private disposed = false;
  private state: BackupSchedulerState;

  constructor(private readonly options: {
    dirHandle: FileSystemDirectoryHandle;
    destination: BackupDestination | null;
    supported: boolean;
    canRun: () => boolean;
    onStateChange: (state: BackupSchedulerState) => void;
  }) {
    this.destination = options.destination;
    this.state = {
      supported: options.supported,
      enabled: this.preferences.enabled,
      destinationStatus: destinationStatusFor(this.destination),
      running: false,
      lastSuccessAt: this.preferences.lastSuccessAt,
      nextDueAt: this.preferences.lastSuccessAt
        ? getNextLocalDay(this.preferences.lastSuccessAt)
        : undefined,
      backups: []
    };
  }

  get currentState(): BackupSchedulerState {
    return this.state;
  }

  async initialize(): Promise<void> {
    await this.refresh({ validate: false });
    void this.evaluate().catch(() => undefined);
  }

  async setDestination(destination: BackupDestination | null): Promise<void> {
    this.destination = destination;
    await this.refresh();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.preferences = { ...this.preferences, enabled };
    writePreferences(this.preferences);
    this.updateState({ enabled, error: undefined });
    if (enabled) {
      await this.evaluate();
    } else {
      this.clearStartupTimer();
    }
  }

  async refresh(options: { validate?: boolean } = {}): Promise<void> {
    if (!this.destination) {
      this.updateState({
        destinationStatus: 'unavailable',
        backups: []
      });
      return;
    }
    const destinationStatus = await this.destination.getStatus();
    this.updateState({
      destinationStatus,
      ...(destinationStatus === 'connected' ? { error: undefined } : {})
    });
    if (destinationStatus !== 'connected') return;

    const files = await this.destination.list();
    if (options.validate === false) {
      this.updateState({
        backups: files.map(file => ({ ...file, integrity: 'unverified' }))
      });
      return;
    }

    const backups: ManagedBackupStatus[] = [];
    for (const file of files) {
      backups.push(await this.inspectManagedFile(file));
    }
    backups.sort((left, right) => (
      (right.preview?.createdAt || right.lastModified) -
      (left.preview?.createdAt || left.lastModified)
    ));
    this.updateState({ backups });
  }

  evaluate(): Promise<BackupArchivePreview | null> {
    if (!this.preferences.enabled || !this.isDue()) {
      return Promise.resolve(null);
    }
    if (Date.now() < this.startupEligibleAt) {
      this.scheduleStartupEvaluation();
      return Promise.resolve(null);
    }
    if (!this.options.canRun()) return Promise.resolve(null);
    return this.run('scheduled');
  }

  backUpNow(): Promise<BackupArchivePreview | null> {
    return this.run('manual');
  }

  async readBackup(filename: string): Promise<Blob> {
    if (!this.destination) throw new Error('No backup destination is configured.');
    return this.destination.read(filename);
  }

  async deleteBackup(filename: string): Promise<void> {
    if (!this.destination) throw new Error('No backup destination is configured.');
    await this.destination.delete(filename);
    await this.refresh();
  }

  async runDueForClose(): Promise<BackupArchivePreview | null> {
    if (this.runningPromise) return this.runningPromise;
    if (!this.preferences.enabled || !this.isDue()) return null;
    return this.run('scheduled', true);
  }

  dispose(): void {
    this.disposed = true;
    this.clearStartupTimer();
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private isDue(): boolean {
    const currentRevision = readCurrentRevisionSafely();
    return (
      currentRevision !== null &&
      currentRevision !== this.preferences.lastRevision &&
      getLocalDay(Date.now()) !== this.preferences.lastAutomaticLocalDay
    );
  }

  private run(
    reason: 'scheduled' | 'manual',
    closeTime = false
  ): Promise<BackupArchivePreview | null> {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.runInternal(reason, closeTime)
      .finally(() => {
        this.runningPromise = null;
      });
    return this.runningPromise;
  }

  private async runInternal(
    reason: 'scheduled' | 'manual',
    closeTime: boolean
  ): Promise<BackupArchivePreview | null> {
    if (!this.destination) {
      const error = new Error('Choose a backup folder before creating a managed backup.');
      this.updateState({ error: error.message });
      if (closeTime) throw error;
      return null;
    }
    const destinationStatus = await this.destination.getStatus();
    if (destinationStatus !== 'connected') {
      const error = new Error('Backup folder permission must be reconnected.');
      this.updateState({ destinationStatus, error: error.message });
      if (closeTime) throw error;
      return null;
    }
    if (!closeTime && !this.options.canRun()) {
      if (reason === 'scheduled') return null;
      throw new Error(
        'Wait for active workspace operations to finish before backing up.'
      );
    }

    this.updateState({ running: true, error: undefined, warning: undefined });
    try {
      const snapshot = await readWorkspaceSnapshot(this.options.dirHandle);
      const archive = await createWorkspaceArchive(snapshot, { reason });
      const validated = await inspectWorkspaceArchive(archive, {
        retainBlobs: false
      });
      const filename = createManagedBackupFilename(
        validated.manifest.createdAt,
        validated.manifest.backupId
      );
      await this.destination.writeAtomic(
        filename,
        archive,
        validated.preview.sha256
      );

      this.preferences = {
        ...this.preferences,
        lastRevision: snapshot.revision,
        ...(reason === 'scheduled'
          ? { lastAutomaticLocalDay: getLocalDay(Date.now()) }
          : {}),
        lastSuccessAt: Date.now()
      };
      writePreferences(this.preferences);
      this.retryIndex = 0;
      const rotation = await this.rotateAfterVerifiedWrite(
        filename,
        validated.preview
      );
      this.updateState({
        running: false,
        lastSuccessAt: this.preferences.lastSuccessAt,
        nextDueAt: getNextLocalDay(this.preferences.lastSuccessAt!),
        error: undefined,
        warning: rotation.warning,
        backups: rotation.backups
      });
      return validated.preview;
    } catch (error) {
      this.updateState({ running: false, error: describeError(error) });
      if (reason === 'scheduled' && !closeTime) this.scheduleRetry();
      throw error;
    }
  }

  private async rotateAfterVerifiedWrite(
    writtenFilename: string,
    writtenPreview: BackupArchivePreview
  ): Promise<{ backups: ManagedBackupStatus[]; warning?: string }> {
    if (!this.destination) return { backups: [] };
    const files = await this.destination.list();
    let written: ManagedBackupStatus | null = null;
    const otherValid: ManagedBackupStatus[] = [];
    const corrupt: ManagedBackupStatus[] = [];
    const unverified: ManagedBackupStatus[] = [];
    for (const file of files) {
      if (file.filename === writtenFilename) {
        written = { ...file, integrity: 'valid', preview: writtenPreview };
        continue;
      }
      const status = await this.inspectManagedFile(file);
      if (status.integrity === 'valid') otherValid.push(status);
      else if (status.integrity === 'corrupt') corrupt.push(status);
      else unverified.push(status);
    }
    if (!written) {
      throw new Error('The newly written backup is missing from its destination.');
    }
    // The file just written is always retained, even when a clock regression
    // gives it an older manifest timestamp than existing backups.
    otherValid.sort((left, right) => (
      right.preview!.createdAt - left.preview!.createdAt
    ));
    const valid = [written, ...otherValid.slice(0, 2)];
    const removals = [...otherValid.slice(2), ...corrupt];
    const failures: string[] = [];
    const removed = new Set<string>();
    for (const file of removals) {
      try {
        await this.destination.delete(file.filename);
        removed.add(file.filename);
      } catch {
        failures.push(file.filename);
      }
    }
    const backups = [...valid, ...unverified, ...corrupt]
      .filter(file => !removed.has(file.filename))
      .sort((left, right) => (
        (right.preview?.createdAt || right.lastModified) -
        (left.preview?.createdAt || left.lastModified)
      ));
    return {
      backups,
      ...(failures.length > 0
        ? {
            warning: `Could not remove ${failures.length} old backup file(s); cleanup will retry later.`
          }
        : {})
    };
  }

  // Only an archive that fails validation is corrupt. A failed read (lock,
  // placeholder, vanished file) or a newer archive format proves nothing about
  // the bytes, so those files stay listed as unverified and are never deleted.
  private async inspectManagedFile(
    file: ManagedBackupFile
  ): Promise<ManagedBackupStatus> {
    let archive: Blob;
    try {
      archive = await this.destination!.read(file.filename);
    } catch (error) {
      return { ...file, integrity: 'unverified', error: describeError(error) };
    }
    try {
      const inspected = await inspectWorkspaceArchive(archive, {
        filename: file.filename,
        retainBlobs: false
      });
      return { ...file, integrity: 'valid', preview: inspected.preview };
    } catch (error) {
      return {
        ...file,
        integrity: error instanceof UnsupportedArchiveVersionError
          ? 'unverified'
          : 'corrupt',
        error: describeError(error)
      };
    }
  }

  private scheduleStartupEvaluation(): void {
    if (this.disposed || this.startupTimer !== null) return;
    const delay = Math.max(0, this.startupEligibleAt - Date.now());
    this.startupTimer = window.setTimeout(() => {
      this.startupTimer = null;
      void this.evaluate().catch(() => undefined);
    }, delay);
  }

  private clearStartupTimer(): void {
    if (this.startupTimer === null) return;
    window.clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer !== null) return;
    const delay = RETRY_DELAYS_MS[Math.min(
      this.retryIndex,
      RETRY_DELAYS_MS.length - 1
    )];
    this.retryIndex += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.evaluate().catch(() => undefined);
    }, delay);
  }

  private updateState(patch: Partial<BackupSchedulerState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onStateChange(this.state);
  }
}

const destinationStatusFor = (
  destination: BackupDestination | null
): BackupDestinationStatus => destination ? 'permission-required' : 'unavailable';

const readCurrentRevisionSafely = (): number | null => {
  try {
    return getWorkspaceRevision();
  } catch {
    return null;
  }
};
