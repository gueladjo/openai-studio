export type ProjectOperationKind =
  | 'source-add'
  | 'source-index'
  | 'source-delete'
  | 'project-delete'
  | 'reconcile'
  | 'remote-cleanup'
  | 'api-key-switch';

export interface ProjectOperation {
  readonly id: number;
  readonly kind: ProjectOperationKind;
  readonly sourceIds: readonly string[];
  readonly workspaceEpoch: number;
  readonly controller: AbortController;
}

export interface ProjectOperationStatus {
  readonly isBusy: boolean;
  readonly busySourceIds: ReadonlySet<string>;
}

interface ProjectOperationOptions {
  kind: ProjectOperationKind;
  sourceIds?: readonly string[];
}

interface OwnedProjectOperation extends ProjectOperation {
  readonly dedupeKey?: string;
}

const createAbortError = (): Error => {
  const error = new Error('Project operation is no longer current.');
  error.name = 'AbortError';
  return error;
};

export class ProjectOperationOwner {
  private workspaceEpoch = 0;
  private nextId = 1;
  private tail: Promise<void> = Promise.resolve();
  private readonly operations = new Map<number, OwnedProjectOperation>();
  private readonly completedDedupeKeys = new Set<string>();

  constructor(
    private readonly onStatusChange: (
      status: ProjectOperationStatus
    ) => void = () => undefined
  ) {}

  get isBusy(): boolean {
    return this.operations.size > 0;
  }

  enqueue<T>(
    options: ProjectOperationOptions & { dedupeKey: string },
    task: (operation: ProjectOperation) => Promise<T>
  ): Promise<T> | null;
  enqueue<T>(
    options: ProjectOperationOptions,
    task: (operation: ProjectOperation) => Promise<T>
  ): Promise<T>;
  enqueue<T>(
    {
      kind,
      sourceIds = [],
      dedupeKey
    }: ProjectOperationOptions & { dedupeKey?: string },
    task: (operation: ProjectOperation) => Promise<T>
  ): Promise<T> | null {
    if (
      dedupeKey &&
      (
        this.completedDedupeKeys.has(dedupeKey) ||
        [...this.operations.values()].some(operation => (
          operation.dedupeKey === dedupeKey
        ))
      )
    ) {
      return null;
    }

    const operation: OwnedProjectOperation = {
      id: this.nextId,
      kind,
      sourceIds: [...new Set(sourceIds)],
      workspaceEpoch: this.workspaceEpoch,
      controller: new AbortController(),
      ...(dedupeKey ? { dedupeKey } : {})
    };
    this.nextId += 1;
    this.operations.set(operation.id, operation);
    this.emitStatus();

    const run = this.tail
      .then(async () => {
        this.assertCurrent(operation);
        const result = await task(operation);
        this.assertCurrent(operation);
        if (operation.dedupeKey) {
          this.completedDedupeKeys.add(operation.dedupeKey);
        }
        return result;
      });
    const tracked = run.finally(() => {
      if (this.operations.get(operation.id) === operation) {
        this.operations.delete(operation.id);
        this.emitStatus();
      }
    });
    this.tail = tracked.then(
      () => undefined,
      () => undefined
    );
    return tracked;
  }

  isCurrent(operation: ProjectOperation): boolean {
    return (
      this.operations.get(operation.id) === operation &&
      operation.workspaceEpoch === this.workspaceEpoch &&
      !operation.controller.signal.aborted
    );
  }

  assertCurrent(operation: ProjectOperation): void {
    if (!this.isCurrent(operation)) throw createAbortError();
  }

  invalidateWorkspace(): void {
    this.workspaceEpoch += 1;
    this.completedDedupeKeys.clear();
    this.operations.forEach(operation => operation.controller.abort());
    this.operations.clear();
    this.emitStatus();
  }

  private emitStatus(): void {
    this.onStatusChange({
      isBusy: this.isBusy,
      busySourceIds: new Set(
        [...this.operations.values()].flatMap(operation => operation.sourceIds)
      )
    });
  }
}
