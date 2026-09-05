import { describe, expect, it, vi } from 'vitest';
import {
  ProjectOperationOwner,
  ProjectOperationStatus
} from './projectOperationOwner';

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('ProjectOperationOwner', () => {
  it('pauses new work and drains all queued tasks before close can proceed', async () => {
    const owner = new ProjectOperationOwner();
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const firstRun = owner.enqueue({ kind: 'source-add' }, () => first.promise);
    const secondRun = owner.enqueue({ kind: 'source-delete' }, () => second.promise);
    const drained = vi.fn();
    const close = owner.pauseAndDrain().then(drained);
    await expect(owner.enqueue({ kind: 'reconcile' }, async () => undefined))
      .rejects.toThrow('paused while closing');
    first.resolve();
    await firstRun;
    expect(drained).not.toHaveBeenCalled();
    second.resolve();
    await Promise.all([secondRun, close]);
    expect(drained).toHaveBeenCalledOnce();
    owner.resume();
    await expect(owner.enqueue({ kind: 'reconcile' }, async () => 'resumed'))
      .resolves.toBe('resumed');
  });

  it('waits for every task after a failure and remembers it until close is cancelled', async () => {
    const owner = new ProjectOperationOwner();
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const failed = owner.enqueue({ kind: 'source-index' }, () => first.promise)
      .catch(() => undefined);
    const queued = owner.enqueue({ kind: 'remote-cleanup' }, () => second.promise);
    const onFailure = vi.fn();
    const close = owner.pauseAndDrain().catch(onFailure);
    first.reject(new Error('Remote ID could not be saved.'));
    await failed;
    expect(onFailure).not.toHaveBeenCalled();
    second.resolve();
    await Promise.all([queued, close]);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Remote ID could not be saved.'
    }));
    await expect(owner.pauseAndDrain()).rejects.toThrow('Remote ID could not be saved.');
    owner.resume();
    await expect(owner.pauseAndDrain()).resolves.toBeUndefined();
  });

  it('drains invalidated work until its asynchronous task actually settles', async () => {
    const owner = new ProjectOperationOwner();
    const task = createDeferred<void>();
    const pending = owner.enqueue({ kind: 'source-index' }, () => task.promise)
      .catch(() => undefined);
    await Promise.resolve();
    owner.invalidateWorkspace();
    const settled = vi.fn();
    const close = owner.pauseAndDrain().catch(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    task.resolve();
    await Promise.all([pending, close]);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
  });

  it('owns queued work immediately and runs project mutations serially', async () => {
    const statuses: ProjectOperationStatus[] = [];
    const owner = new ProjectOperationOwner(status => statuses.push(status));
    const first = createDeferred<void>();
    const order: string[] = [];

    const firstRun = owner.enqueue(
      { kind: 'source-index', sourceIds: ['source-a'] },
      async () => {
        order.push('first-start');
        await first.promise;
        order.push('first-end');
      }
    )!;
    const secondRun = owner.enqueue(
      { kind: 'source-index', sourceIds: ['source-b'] },
      async () => {
        order.push('second');
      }
    )!;

    expect(owner.isBusy).toBe(true);
    expect(statuses.at(-1)?.busySourceIds).toEqual(
      new Set(['source-a', 'source-b'])
    );
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    first.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(statuses.at(-1)).toEqual({
      isBusy: false,
      busySourceIds: new Set()
    });
  });

  it('keeps a duplicated source busy until every unique owner releases it', async () => {
    const statuses: ProjectOperationStatus[] = [];
    const owner = new ProjectOperationOwner(status => statuses.push(status));
    const first = createDeferred<void>();
    const second = createDeferred<void>();

    const firstRun = owner.enqueue(
      { kind: 'source-index', sourceIds: ['shared-source'] },
      async () => first.promise
    )!;
    const secondRun = owner.enqueue(
      { kind: 'source-index', sourceIds: ['shared-source'] },
      async () => second.promise
    )!;

    await Promise.resolve();
    first.resolve();
    await firstRun;
    expect(owner.isBusy).toBe(true);
    expect(statuses.at(-1)?.busySourceIds).toEqual(new Set(['shared-source']));

    second.resolve();
    await secondRun;
    expect(owner.isBusy).toBe(false);
  });

  it('invalidates active and queued publishers across workspace replacement', async () => {
    const owner = new ProjectOperationOwner();
    const first = createDeferred<void>();
    const ranQueuedTask = vi.fn();
    let activeOperation: Parameters<typeof owner.assertCurrent>[0] | undefined;

    const activeRun = owner.enqueue({ kind: 'reconcile' }, async operation => {
      activeOperation = operation;
      await first.promise;
      owner.assertCurrent(operation);
    })!;
    const queuedRun = owner.enqueue({ kind: 'source-index' }, async () => {
      ranQueuedTask();
    })!;
    await Promise.resolve();

    owner.invalidateWorkspace();
    expect(activeOperation?.controller.signal.aborted).toBe(true);
    expect(owner.isBusy).toBe(false);
    first.resolve();

    await expect(activeRun).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queuedRun).rejects.toMatchObject({ name: 'AbortError' });
    expect(ranQueuedTask).not.toHaveBeenCalled();
  });

  it('deduplicates successful reconciliation but permits a failed retry', async () => {
    const owner = new ProjectOperationOwner();
    const failed = owner.enqueue(
      { kind: 'reconcile', dedupeKey: 'project:key' },
      async () => {
        throw new Error('temporary failure');
      }
    )!;
    expect(owner.enqueue(
      { kind: 'reconcile', dedupeKey: 'project:key' },
      async () => undefined
    )).toBeNull();
    await expect(failed).rejects.toThrow('temporary failure');

    const retry = owner.enqueue(
      { kind: 'reconcile', dedupeKey: 'project:key' },
      async () => 'reconciled'
    );
    await expect(retry).resolves.toBe('reconciled');
    expect(owner.enqueue(
      { kind: 'reconcile', dedupeKey: 'project:key' },
      async () => undefined
    )).toBeNull();
  });
});
