import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveQueueFailure, VersionedSaveQueue } from './saveQueue';

type Key = 'sessions' | 'settings';

const createQueue = (
  persist: (key: Key, version: number) => Promise<void>,
  onFailure = vi.fn<(failure: SaveQueueFailure<Key>) => void>(),
  onRecovered = vi.fn<() => void>()
) => ({
  queue: new VersionedSaveQueue<Key>({
    keys: ['sessions', 'settings'],
    persist,
    getDelayMs: (_key, _dirtyForMs, immediate) => immediate ? 0 : 50,
    retryDelaysMs: [10, 20],
    onFailure,
    onRecovered
  }),
  onFailure,
  onRecovered
});

describe('VersionedSaveQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains a failed version and recovers on an automatic retry', async () => {
    let shouldFail = true;
    const persist = vi.fn(async () => {
      if (shouldFail) throw new Error('disk unavailable');
    });
    const { queue, onFailure, onRecovered } = createQueue(persist);

    queue.markDirty('sessions', true);
    await expect(queue.flush()).rejects.toThrow('disk unavailable');

    expect(queue.hasPendingChanges()).toBe(true);
    expect(onFailure).toHaveBeenLastCalledWith(expect.objectContaining({
      failedKeys: ['sessions'],
      automaticRetryAttempt: 1,
      nextRetryDelayMs: 10
    }));

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.hasPendingChanges()).toBe(false);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(onRecovered).toHaveBeenCalledOnce();
    queue.dispose();
  });

  it('stops automatic retries after the configured backoff sequence', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const persist = vi.fn(async () => {
      throw new Error('still unavailable');
    });
    const { queue, onFailure } = createQueue(persist);

    queue.markDirty('sessions', true);
    await expect(queue.flush()).rejects.toThrow('still unavailable');
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(persist).toHaveBeenCalledTimes(3);
    expect(queue.hasPendingChanges()).toBe(true);
    expect(onFailure).toHaveBeenLastCalledWith(expect.objectContaining({
      automaticRetryAttempt: 2,
      nextRetryDelayMs: null
    }));
    queue.dispose();
    consoleError.mockRestore();
  });

  it('keeps work queued while a rejected drain is in flight', async () => {
    const firstWriteControl: { reject?: (error: Error) => void } = {};
    let firstWrite = true;
    const persist = vi.fn(async (key: Key) => {
      if (key === 'sessions' && firstWrite) {
        firstWrite = false;
        await new Promise<void>((_resolve, reject) => {
          firstWriteControl.reject = reject;
        });
      }
    });
    const { queue } = createQueue(persist);

    queue.markDirty('sessions', true);
    const failedFlush = queue.flush();
    await Promise.resolve();
    queue.markDirty('settings', true);
    firstWriteControl.reject?.(new Error('first write failed'));
    await expect(failedFlush).rejects.toThrow('first write failed');

    await queue.retryNow();

    expect(persist.mock.calls.map(call => call[0])).toEqual([
      'sessions',
      'sessions',
      'settings'
    ]);
    expect(queue.hasPendingChanges()).toBe(false);
    queue.dispose();
  });

  it('does not mark a newer in-flight version as saved by an older write', async () => {
    const firstWriteControl: { finish?: () => void } = {};
    const persist = vi.fn(async () => {
      if (persist.mock.calls.length === 1) {
        await new Promise<void>(resolve => {
          firstWriteControl.finish = resolve;
        });
      }
    });
    const { queue } = createQueue(persist);

    queue.markDirty('sessions', true);
    const firstFlush = queue.flush();
    await Promise.resolve();
    queue.markDirty('sessions');
    firstWriteControl.finish?.();
    await firstFlush;

    expect(queue.getSavedVersion('sessions')).toBe(1);
    expect(queue.getVersion('sessions')).toBe(2);
    expect(queue.hasPendingChanges()).toBe(true);

    await vi.advanceTimersByTimeAsync(50);

    expect(queue.getSavedVersion('sessions')).toBe(2);
    expect(queue.hasPendingChanges()).toBe(false);
    queue.dispose();
  });
});
