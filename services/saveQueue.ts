export interface SaveQueueFailure<Key extends string> {
  error: Error;
  failedKeys: Key[];
  automaticRetryAttempt: number;
  nextRetryDelayMs: number | null;
}

interface VersionedSaveQueueOptions<Key extends string> {
  keys: readonly Key[];
  persist: (key: Key, version: number) => Promise<void>;
  getDelayMs: (key: Key, dirtyForMs: number, immediate: boolean) => number;
  retryDelaysMs: readonly number[];
  onFailure: (failure: SaveQueueFailure<Key>) => void;
  onRecovered: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const toError = (error: unknown): Error => (
  error instanceof Error ? error : new Error(String(error))
);

export class VersionedSaveQueue<Key extends string> {
  private readonly keys: readonly Key[];
  private readonly persist: VersionedSaveQueueOptions<Key>['persist'];
  private readonly getDelayMs: VersionedSaveQueueOptions<Key>['getDelayMs'];
  private readonly retryDelaysMs: readonly number[];
  private readonly onFailure: VersionedSaveQueueOptions<Key>['onFailure'];
  private readonly onRecovered: VersionedSaveQueueOptions<Key>['onRecovered'];
  private readonly now: () => number;
  private readonly setTimer: NonNullable<VersionedSaveQueueOptions<Key>['setTimer']>;
  private readonly clearTimer: NonNullable<VersionedSaveQueueOptions<Key>['clearTimer']>;
  private readonly versions = new Map<Key, number>();
  private readonly savedVersions = new Map<Key, number>();
  private readonly immediateVersions = new Map<Key, number>();
  private readonly dirtySince = new Map<Key, number>();
  private readonly debounceTimers = new Map<Key, ReturnType<typeof setTimeout>>();
  private readonly queuedKeys = new Set<Key>();
  private readonly failedKeys = new Set<Key>();
  private drainPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private hasReportedFailure = false;
  private disposed = false;

  constructor(options: VersionedSaveQueueOptions<Key>) {
    this.keys = options.keys;
    this.persist = options.persist;
    this.getDelayMs = options.getDelayMs;
    this.retryDelaysMs = options.retryDelaysMs;
    this.onFailure = options.onFailure;
    this.onRecovered = options.onRecovered;
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimer || globalThis.clearTimeout.bind(globalThis);

    this.keys.forEach(key => {
      this.versions.set(key, 0);
      this.savedVersions.set(key, 0);
      this.immediateVersions.set(key, 0);
    });
  }

  markDirty(key: Key, immediate = false): void {
    if (this.disposed) return;

    const version = this.getVersion(key) + 1;
    this.versions.set(key, version);
    if (immediate) this.immediateVersions.set(key, version);

    const now = this.now();
    if (!this.dirtySince.has(key)) this.dirtySince.set(key, now);
    this.clearDebounceTimer(key);

    const dirtyForMs = now - (this.dirtySince.get(key) || now);
    this.scheduleKey(
      key,
      this.getDelayMs(key, dirtyForMs, immediate)
    );
  }

  async flush(keys: readonly Key[] = this.keys): Promise<void> {
    if (this.disposed) return;

    const targetVersions = new Map<Key, number>();
    keys.forEach(key => {
      targetVersions.set(key, this.getVersion(key));
      this.clearDebounceTimer(key);
      if (this.getSavedVersion(key) < this.getVersion(key)) {
        this.queuedKeys.add(key);
      }
    });

    while (true) {
      if (this.drainPromise || this.queuedKeys.size > 0) {
        await this.drain();
      }

      const outstanding = keys.filter(key => (
        this.getSavedVersion(key) < (targetVersions.get(key) || 0)
      ));
      if (outstanding.length === 0) return;
      outstanding.forEach(key => this.queuedKeys.add(key));
    }
  }

  async retryNow(): Promise<void> {
    if (this.disposed) return;

    this.cancelRetryTimer();
    this.retryAttempt = 0;
    await this.flush(this.keys);
  }

  hasPendingChanges(): boolean {
    return this.keys.some(key => this.getSavedVersion(key) < this.getVersion(key));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  getVersion(key: Key): number {
    return this.versions.get(key) || 0;
  }

  getSavedVersion(key: Key): number {
    return this.savedVersions.get(key) || 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.debounceTimers.forEach(timer => this.clearTimer(timer));
    this.debounceTimers.clear();
    this.cancelRetryTimer();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;

    const run = (async () => {
      while (this.queuedKeys.size > 0) {
        const keys = Array.from(this.queuedKeys);
        let firstError: Error | null = null;

        for (const key of keys) {
          const version = this.getVersion(key);

          try {
            await this.persist(key, version);
            this.handleSuccessfulWrite(key, version);
          } catch (error) {
            const saveError = toError(error);
            this.failedKeys.add(key);
            if (!firstError) firstError = saveError;
          }
        }

        if (firstError) {
          this.scheduleAutomaticRetry(firstError);
          throw firstError;
        }
      }
    })();

    const trackedDrain = run.finally(() => {
      if (this.drainPromise === trackedDrain) this.drainPromise = null;
    });
    this.drainPromise = trackedDrain;
    return trackedDrain;
  }

  private handleSuccessfulWrite(key: Key, version: number): void {
    this.savedVersions.set(
      key,
      Math.max(this.getSavedVersion(key), version)
    );

    if (this.getVersion(key) === version) {
      this.queuedKeys.delete(key);
      this.dirtySince.delete(key);
      if ((this.immediateVersions.get(key) || 0) <= version) {
        this.immediateVersions.set(key, 0);
      }
      this.clearDebounceTimer(key);
      this.failedKeys.delete(key);
      this.reportRecoveryIfComplete();
      return;
    }

    this.clearDebounceTimer(key);
    if ((this.immediateVersions.get(key) || 0) > version) {
      this.queuedKeys.add(key);
      return;
    }

    this.dirtySince.set(key, this.now());
    this.queuedKeys.delete(key);
    this.scheduleKey(key, this.getDelayMs(key, 0, false));
  }

  private scheduleKey(key: Key, delayMs: number): void {
    const timer = this.setTimer(() => {
      this.debounceTimers.delete(key);
      this.queuedKeys.add(key);
      void this.drain().catch(error => {
        console.error(`Failed to persist ${key}`, error);
      });
    }, Math.max(0, delayMs));
    this.debounceTimers.set(key, timer);
  }

  private scheduleAutomaticRetry(error: Error): void {
    if (this.retryTimer !== null) return;

    const delayMs = this.retryDelaysMs[this.retryAttempt] ?? null;
    if (delayMs === null) {
      this.hasReportedFailure = true;
      this.onFailure({
        error,
        failedKeys: Array.from(this.failedKeys),
        automaticRetryAttempt: this.retryAttempt,
        nextRetryDelayMs: null
      });
      return;
    }

    this.retryAttempt += 1;
    this.hasReportedFailure = true;
    this.onFailure({
      error,
      failedKeys: Array.from(this.failedKeys),
      automaticRetryAttempt: this.retryAttempt,
      nextRetryDelayMs: delayMs
    });
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.disposed || this.queuedKeys.size === 0) return;
      void this.drain().catch(retryError => {
        console.error('Automatic workspace save retry failed.', retryError);
      });
    }, delayMs);
  }

  private reportRecoveryIfComplete(): void {
    if (this.failedKeys.size > 0) return;

    const hadFailure = this.hasReportedFailure;
    this.cancelRetryTimer();
    this.retryAttempt = 0;
    this.hasReportedFailure = false;
    if (hadFailure) this.onRecovered();
  }

  private clearDebounceTimer(key: Key): void {
    const timer = this.debounceTimers.get(key);
    if (timer === undefined) return;
    this.clearTimer(timer);
    this.debounceTimers.delete(key);
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer === null) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }
}
