export class SerializedOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  constructor(
    private readonly onPendingChange: (isPending: boolean) => void = () => undefined
  ) {}

  get isPending(): boolean {
    return this.pendingCount > 0;
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingCount += 1;
    if (this.pendingCount === 1) {
      this.onPendingChange(true);
    }

    const run = this.tail.then(operation);
    const trackedRun = run.finally(() => {
      this.pendingCount -= 1;
      if (this.pendingCount === 0) {
        this.onPendingChange(false);
      }
    });

    this.tail = trackedRun.then(
      () => undefined,
      () => undefined
    );
    return trackedRun;
  }
}
