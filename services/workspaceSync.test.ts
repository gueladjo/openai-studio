import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceCoordinator } from './workspaceSync';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeWindow extends EventTarget {
  electronAPI = undefined;
  localStorage = new MemoryStorage();
  setTimeout = windowlessSetTimeout;
  clearTimeout = windowlessClearTimeout;
  setInterval = windowlessSetInterval;
  clearInterval = windowlessClearInterval;
}

class FakeBroadcastChannel {
  private static channels = new Set<FakeBroadcastChannel>();
  private listeners = new Set<(event: MessageEvent) => void>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.add(this);
  }

  addEventListener(_type: string, listener: EventListener): void {
    this.listeners.add(listener as (event: MessageEvent) => void);
  }

  postMessage(data: unknown): void {
    FakeBroadcastChannel.channels.forEach(channel => {
      if (channel === this || channel.name !== this.name) return;
      queueMicrotask(() => {
        channel.listeners.forEach(listener => listener({ data } as MessageEvent));
      });
    });
  }

  close(): void {
    FakeBroadcastChannel.channels.delete(this);
    this.listeners.clear();
  }

  static reset(): void {
    FakeBroadcastChannel.channels.clear();
  }
}

class FakeLockManager {
  private held = false;

  request<T>(
    name: string,
    _options: LockOptions,
    callback: LockGrantedCallback<T>
  ): Promise<T> {
    if (this.held) return Promise.resolve(callback(null));

    this.held = true;
    const lock = { name, mode: 'exclusive' as const } as Lock;
    return Promise.resolve(callback(lock)).finally(() => {
      this.held = false;
    });
  }
}

const windowlessSetTimeout = globalThis.setTimeout.bind(globalThis) as unknown as typeof window.setTimeout;
const windowlessClearTimeout = globalThis.clearTimeout.bind(globalThis) as unknown as typeof window.clearTimeout;
const windowlessSetInterval = globalThis.setInterval.bind(globalThis) as unknown as typeof window.setInterval;
const windowlessClearInterval = globalThis.clearInterval.bind(globalThis) as unknown as typeof window.clearInterval;

describe('WorkspaceCoordinator', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new FakeWindow());
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('navigator', { locks: new FakeLockManager() });
  });

  afterEach(() => {
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  it('allows only one writer and promotes a reader after release', async () => {
    const first = await WorkspaceCoordinator.create();
    const second = await WorkspaceCoordinator.create();

    expect(first.currentRole).toBe('writer');
    expect(second.currentRole).toBe('reader');

    first.dispose();

    await vi.waitFor(() => {
      expect(second.currentRole).toBe('writer');
    });
    second.dispose();
  });

  it('broadcasts committed revisions to reader tabs', async () => {
    const writer = await WorkspaceCoordinator.create();
    const reader = await WorkspaceCoordinator.create();
    const onUpdate = vi.fn();
    reader.subscribeToUpdates(onUpdate);

    writer.publishUpdate(7);

    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(7);
    });

    writer.dispose();
    reader.dispose();
  });
});
