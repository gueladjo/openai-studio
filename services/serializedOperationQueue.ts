export interface SerializedOperationOptions {
  blocksInteractions?: boolean;
}

export class SerializedOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private blockingCount = 0;

  constructor(
    private readonly onBlockingChange: (isBlocking: boolean) => void = () => undefined
  ) {}

  get isPending(): boolean {
    return this.pendingCount > 0;
  }

  get isBlocking(): boolean {
    return this.blockingCount > 0;
  }

  enqueue<T>(
    operation: () => Promise<T>,
    { blocksInteractions = true }: SerializedOperationOptions = {}
  ): Promise<T> {
    this.pendingCount += 1;
    if (blocksInteractions) {
      this.blockingCount += 1;
      if (this.blockingCount === 1) {
        this.onBlockingChange(true);
      }
    }

    const run = this.tail.then(operation);
    const trackedRun = run.finally(() => {
      this.pendingCount -= 1;
      if (blocksInteractions) {
        this.blockingCount -= 1;
        if (this.blockingCount === 0) {
          this.onBlockingChange(false);
        }
      }
    });

    this.tail = trackedRun.then(
      () => undefined,
      () => undefined
    );
    return trackedRun;
  }
}
