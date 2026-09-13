export type WorkspaceRole = 'writer' | 'reader';

type WorkspaceSyncMessage =
  | {
      type: 'workspace-updated';
      senderId: string;
      revision: number;
    }
  | {
      type: 'writer-released';
      senderId: string;
    };

const WORKSPACE_LOCK_NAME = 'openai-studio-workspace-writer';
const WORKSPACE_CHANNEL_NAME = 'openai-studio-workspace-sync';
const ACQUISITION_RETRY_MS = 2_000;

const isElectronDesktop = (): boolean => Boolean(window.electronAPI);

const getWebLockManager = (): LockManager | null => {
  const browserNavigator = navigator as unknown as { locks?: LockManager };
  return browserNavigator.locks ?? null;
};

export class WorkspaceCoordinator {
  private readonly ownerId = crypto.randomUUID();
  private readonly roleListeners = new Set<(role: WorkspaceRole) => void>();
  private readonly updateListeners = new Set<(revision: number) => void>();
  private channel: BroadcastChannel | null = null;
  private role: WorkspaceRole = 'reader';
  private disposed = false;
  private acquisitionInFlight = false;
  private releaseWebLock: (() => void) | null = null;
  private retryTimer: number | null = null;

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

  // Requests the exclusive writer lock without waiting. Document destruction
  // releases a held lock, so App can checkpoint on unload while still owning it.
  async attemptToBecomeWriter(): Promise<boolean> {
    if (this.disposed || this.canWrite || this.acquisitionInFlight) {
      return this.canWrite;
    }

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

  relinquishWriter(): void {
    if (!this.canWrite) return;

    const release = this.releaseWebLock;
    this.releaseWebLock = null;
    release?.();

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

    if (this.retryTimer !== null) {
      window.clearInterval(this.retryTimer);
      this.retryTimer = null;
    }

    window.removeEventListener('focus', this.handleFocus);
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

    if (!getWebLockManager()) {
      throw new Error(
        'This browser does not support the Web Locks API, which is required to coordinate workspace writes between tabs.'
      );
    }

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(WORKSPACE_CHANNEL_NAME);
      this.channel.addEventListener('message', this.handleChannelMessage);
    }

    window.addEventListener('focus', this.handleFocus);

    await this.attemptToBecomeWriter();

    this.retryTimer = window.setInterval(() => {
      if (!this.disposed && !this.canWrite) void this.attemptToBecomeWriter();
    }, ACQUISITION_RETRY_MS);
  }

  private setRole(role: WorkspaceRole): void {
    if (this.role === role) return;
    this.role = role;
    this.roleListeners.forEach(listener => listener(role));
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
        // Impossible while the Web Lock is held; relinquishing prevents a
        // split-brain write if another client ever publishes anyway.
        this.relinquishWriter();
      }
      this.updateListeners.forEach(listener => listener(message.revision));
      return;
    }

    if (message.type === 'writer-released') {
      window.setTimeout(() => {
        void this.attemptToBecomeWriter();
      }, 0);
    }
  };

  private handleFocus = (): void => {
    if (!this.canWrite) void this.attemptToBecomeWriter();
  };
}
