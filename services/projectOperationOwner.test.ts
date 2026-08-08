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
