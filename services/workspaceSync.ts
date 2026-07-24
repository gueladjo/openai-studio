export type WorkspaceRole = 'writer' | 'reader';

type WorkspaceSyncMessage =
  | {
      type: 'workspace-updated';
      senderId: string;
      revision: number;
    }
  | {
      type: 'writer-released' | 'writer-claimed';
      senderId: string;
    };

const WORKSPACE_LOCK_NAME = 'openai-studio-workspace-writer';
const WORKSPACE_CHANNEL_NAME = 'openai-studio-workspace-sync';
const WORKSPACE_LEASE_KEY = 'openai-studio-workspace-writer-lease';
const LEASE_DURATION_MS = 10_000;
const LEASE_MAINTENANCE_MS = 2_000;
const LEASE_SETTLE_MS = 50;

interface WorkspaceLease {
  ownerId: string;
  expiresAt: number;
}

const isElectronDesktop = (): boolean => Boolean(window.electronAPI);

const getWebLockManager = (): LockManager | null => {
  const browserNavigator = navigator as unknown as { locks?: LockManager };
  return browserNavigator.locks ?? null;
};

const createOwnerId = (): string => {
  if (crypto.randomUUID) return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const parseLease = (value: string | null): WorkspaceLease | null => {
  if (!value) return null;

  try {
    const lease = JSON.parse(value) as Partial<WorkspaceLease>;
    if (typeof lease.ownerId !== 'string' || typeof lease.expiresAt !== 'number') {
      return null;
    }
    return {
      ownerId: lease.ownerId,
      expiresAt: lease.expiresAt
    };
  } catch {
    return null;
  }
};

const delay = (ms: number): Promise<void> => new Promise(resolve => {
  window.setTimeout(resolve, ms);
});

export class WorkspaceCoordinator {
  private readonly ownerId = createOwnerId();
  private readonly roleListeners = new Set<(role: WorkspaceRole) => void>();
  private readonly updateListeners = new Set<(revision: number) => void>();
  private channel: BroadcastChannel | null = null;
  private role: WorkspaceRole = 'reader';
  private disposed = false;
  private acquisitionInFlight = false;
  private usingWebLock = false;
  private releaseWebLock: (() => void) | null = null;
  private maintenanceTimer: number | null = null;

  private constructor() {}

  static async create(): Promise<WorkspaceCoordinator> {
    const coordinator = new WorkspaceCoordinator();
    await coordinator.initialize();
    return coordinator;
  }

  get currentRole(): WorkspaceRole {
    return this.role;
  }

  get canWrite(): boolean {
    return this.role === 'writer';
  }

  subscribeToRole(listener: (role: WorkspaceRole) => void): () => void {
    this.roleListeners.add(listener);
    return () => this.roleListeners.delete(listener);
  }

  subscribeToUpdates(listener: (revision: number) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  publishUpdate(revision: number): void {
    if (!this.canWrite || !Number.isSafeInteger(revision) || revision < 0) return;

    this.postMessage({
      type: 'workspace-updated',
      senderId: this.ownerId,
      revision
    });
  }

  async attemptToBecomeWriter(): Promise<boolean> {
    if (this.disposed || this.canWrite || this.acquisitionInFlight) {
      return this.canWrite;
    }

    if (getWebLockManager()) {
      return this.attemptWebLock();
    }

    return this.attemptLease();
  }

  relinquishWriter(): void {
    if (!this.canWrite) return;

    if (this.usingWebLock) {
      const release = this.releaseWebLock;
      this.releaseWebLock = null;
      this.usingWebLock = false;
      release?.();
    } else {
      this.removeOwnedLease();
    }

    this.setRole('reader');
    this.postMessage({
      type: 'writer-released',
      senderId: this.ownerId
    });
  }

  dispose(): void {
    if (this.disposed) return;

    this.relinquishWriter();
    this.disposed = true;

    if (this.maintenanceTimer !== null) {
      window.clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    window.removeEventListener('storage', this.handleStorage);
    window.removeEventListener('focus', this.handleFocus);
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    this.channel?.close();
    this.channel = null;
    this.roleListeners.clear();
    this.updateListeners.clear();
  }

  private async initialize(): Promise<void> {
    if (isElectronDesktop()) {
      this.setRole('writer');
      return;
    }

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(WORKSPACE_CHANNEL_NAME);
      this.channel.addEventListener('message', this.handleChannelMessage);
    }

    window.addEventListener('storage', this.handleStorage);
    window.addEventListener('focus', this.handleFocus);
    window.addEventListener('beforeunload', this.handleBeforeUnload);

    await this.attemptToBecomeWriter();

    this.maintenanceTimer = window.setInterval(() => {
      if (this.disposed) return;

      if (getWebLockManager()) {
        if (!this.canWrite) void this.attemptToBecomeWriter();
        return;
      }

      if (this.canWrite) {
        this.renewLease();
      } else {
        void this.attemptToBecomeWriter();
      }
    }, LEASE_MAINTENANCE_MS);
  }

  private setRole(role: WorkspaceRole): void {
    if (this.role === role) return;
    this.role = role;
    this.roleListeners.forEach(listener => listener(role));

    if (role === 'writer') {
      this.postMessage({
        type: 'writer-claimed',
        senderId: this.ownerId
      });
    }
  }

  private async attemptWebLock(): Promise<boolean> {
    const lockManager = getWebLockManager();
    if (!lockManager) return false;

    this.acquisitionInFlight = true;
    let settleAcquisition: ((acquired: boolean) => void) | null = null;
    const acquisition = new Promise<boolean>(resolve => {
      settleAcquisition = resolve;
    });

    const requestPromise = lockManager.request(
      WORKSPACE_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      async lock => {
        const acquired = Boolean(lock) && !this.disposed;
        settleAcquisition?.(acquired);
        settleAcquisition = null;

        if (!acquired) return;

        this.usingWebLock = true;
        this.setRole('writer');
        await new Promise<void>(resolve => {
          this.releaseWebLock = resolve;
        });
      }
    );

    void requestPromise.catch(error => {
      console.warn('Workspace Web Lock request failed.', error);
      settleAcquisition?.(false);
      settleAcquisition = null;
    });

    const acquired = await acquisition;
    this.acquisitionInFlight = false;
    return acquired;
  }

  private async attemptLease(): Promise<boolean> {
    this.acquisitionInFlight = true;

    try {
      const now = Date.now();
      const currentLease = this.readLease();
      if (
        currentLease &&
        currentLease.ownerId !== this.ownerId &&
        currentLease.expiresAt > now
      ) {
        return false;
      }

      this.writeLease({
        ownerId: this.ownerId,
        expiresAt: now + LEASE_DURATION_MS
      });
      await delay(LEASE_SETTLE_MS);

      const claimedLease = this.readLease();
      const acquired = claimedLease?.ownerId === this.ownerId;
      if (acquired) this.setRole('writer');
      return acquired;
    } catch (error) {
      console.warn('Workspace writer lease is unavailable.', error);
      return false;
    } finally {
      this.acquisitionInFlight = false;
    }
  }

  private renewLease(): void {
    const lease = this.readLease();
    if (lease?.ownerId !== this.ownerId) {
      this.setRole('reader');
      return;
    }

    this.writeLease({
      ownerId: this.ownerId,
      expiresAt: Date.now() + LEASE_DURATION_MS
    });
  }

  private readLease(): WorkspaceLease | null {
    return parseLease(window.localStorage.getItem(WORKSPACE_LEASE_KEY));
  }

  private writeLease(lease: WorkspaceLease): void {
    window.localStorage.setItem(WORKSPACE_LEASE_KEY, JSON.stringify(lease));
  }

  private removeOwnedLease(): void {
    try {
      if (this.readLease()?.ownerId === this.ownerId) {
        window.localStorage.removeItem(WORKSPACE_LEASE_KEY);
      }
    } catch (error) {
      console.warn('Failed to release workspace writer lease.', error);
    }
  }

  private postMessage(message: WorkspaceSyncMessage): void {
    this.channel?.postMessage(message);
  }

  private handleChannelMessage = (event: MessageEvent<WorkspaceSyncMessage>): void => {
    const message = event.data;
    if (!message || message.senderId === this.ownerId) return;

    if (message.type === 'workspace-updated') {
      if (!Number.isSafeInteger(message.revision) || message.revision < 0) return;

      if (this.canWrite) {
        // This should be impossible with Web Locks. Relinquishing prevents an
        // older or lease-based client from continuing a split-brain write.
        this.relinquishWriter();
      }
      this.updateListeners.forEach(listener => listener(message.revision));
      return;
    }

    if (message.type === 'writer-released') {
      window.setTimeout(() => {
        void this.attemptToBecomeWriter();
      }, 0);
      return;
    }

    if (message.type === 'writer-claimed' && this.canWrite && !getWebLockManager()) {
      const lease = this.readLease();
      if (lease?.ownerId !== this.ownerId) this.setRole('reader');
    }
  };

  private handleStorage = (event: StorageEvent): void => {
    if (event.key !== WORKSPACE_LEASE_KEY || getWebLockManager()) return;

    if (this.canWrite && parseLease(event.newValue)?.ownerId !== this.ownerId) {
      this.setRole('reader');
    } else if (!this.canWrite) {
      void this.attemptToBecomeWriter();
    }
  };

  private handleFocus = (): void => {
    if (!this.canWrite) void this.attemptToBecomeWriter();
  };

  private handleBeforeUnload = (): void => {
    this.relinquishWriter();
  };
}
