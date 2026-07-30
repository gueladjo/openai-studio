import { describe, expect, it, vi } from 'vitest';
import { SerializedOperationQueue } from './serializedOperationQueue';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('SerializedOperationQueue', () => {
  it('runs destructive operations one at a time in enqueue order', async () => {
    const pendingChanges = vi.fn();
    const queue = new SerializedOperationQueue(pendingChanges);
    const firstGate = deferred<void>();
    const order: string[] = [];

    const first = queue.enqueue(async () => {
      order.push('first-start');
      await firstGate.promise;
      order.push('first-end');
    });
    const second = queue.enqueue(async () => {
      order.push('second-start');
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    expect(queue.isPending).toBe(true);
    expect(pendingChanges).toHaveBeenCalledWith(true);

    firstGate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(queue.isPending).toBe(false);
    expect(pendingChanges.mock.calls).toEqual([[true], [false]]);
  });

  it('continues with the next operation after a failure', async () => {
    const queue = new SerializedOperationQueue();
    const failure = queue.enqueue(async () => {
      throw new Error('delete failed');
    });
    const next = queue.enqueue(async () => 'import completed');

    await expect(failure).rejects.toThrow('delete failed');
    await expect(next).resolves.toBe('import completed');
  });

  it('serializes non-blocking operations without reporting an interaction lock', async () => {
    const blockingChanges = vi.fn();
    const queue = new SerializedOperationQueue(blockingChanges);
    const saveGate = deferred<void>();
    const order: string[] = [];

    const save = queue.enqueue(async () => {
      order.push('save-start');
      await saveGate.promise;
      order.push('save-end');
    }, { blocksInteractions: false });
    const workspaceMutation = queue.enqueue(async () => {
      order.push('mutation');
    });

    await Promise.resolve();
    expect(order).toEqual(['save-start']);
    expect(queue.isPending).toBe(true);
    expect(queue.isBlocking).toBe(true);
    expect(blockingChanges.mock.calls).toEqual([[true]]);

    saveGate.resolve();
    await Promise.all([save, workspaceMutation]);

    expect(order).toEqual(['save-start', 'save-end', 'mutation']);
    expect(queue.isPending).toBe(false);
    expect(queue.isBlocking).toBe(false);
    expect(blockingChanges.mock.calls).toEqual([[true], [false]]);
  });

  it('does not report an interaction lock for only non-blocking work', async () => {
    const blockingChanges = vi.fn();
    const queue = new SerializedOperationQueue(blockingChanges);
    const saveGate = deferred<void>();
    const save = queue.enqueue(
      () => saveGate.promise,
      { blocksInteractions: false }
    );

    await Promise.resolve();
    expect(queue.isPending).toBe(true);
    expect(queue.isBlocking).toBe(false);
    expect(blockingChanges).not.toHaveBeenCalled();

    saveGate.resolve();
    await save;

    expect(queue.isPending).toBe(false);
    expect(queue.isBlocking).toBe(false);
    expect(blockingChanges).not.toHaveBeenCalled();
  });
});
