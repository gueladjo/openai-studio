export interface OperationRecord {
  readonly id: string;
  readonly kind: string;
  readonly sessionId?: string;
  readonly workspaceEpoch: number;
  readonly sessionEpoch?: number;
  readonly controller: AbortController;
}

interface BeginOperationOptions {
  id: string;
  kind: string;
  sessionId?: string;
  controller?: AbortController;
}

export class OperationRegistry {
  private workspaceEpoch = 0;
  private readonly sessionEpochs = new Map<string, number>();
  private readonly operations = new Map<string, OperationRecord>();

  begin({
    id,
    kind,
    sessionId,
    controller = new AbortController()
  }: BeginOperationOptions): OperationRecord {
    if (this.operations.has(id)) {
      throw new Error(`Operation "${id}" already exists.`);
    }

    const operation: OperationRecord = {
      id,
      kind,
      sessionId,
      workspaceEpoch: this.workspaceEpoch,
      ...(sessionId
        ? { sessionEpoch: this.sessionEpochs.get(sessionId) || 0 }
        : {}),
      controller
    };
    this.operations.set(id, operation);
    return operation;
  }

  isCurrent(operation: OperationRecord): boolean {
    if (
      this.operations.get(operation.id) !== operation ||
      operation.controller.signal.aborted ||
      operation.workspaceEpoch !== this.workspaceEpoch
    ) {
      return false;
    }

    return (
      !operation.sessionId ||
      operation.sessionEpoch === (this.sessionEpochs.get(operation.sessionId) || 0)
    );
  }

  complete(operation: OperationRecord): void {
    if (this.operations.get(operation.id) === operation) {
      this.operations.delete(operation.id);
    }
  }

  invalidateSession(sessionId: string): OperationRecord[] {
    this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) || 0) + 1);
    return this.abortWhere(operation => operation.sessionId === sessionId);
  }

  invalidateWorkspace(): OperationRecord[] {
    this.workspaceEpoch += 1;
    this.sessionEpochs.clear();
    return this.abortWhere(() => true);
  }

  abortWhere(predicate: (operation: OperationRecord) => boolean): OperationRecord[] {
    const aborted: OperationRecord[] = [];

    this.operations.forEach(operation => {
      if (!predicate(operation)) return;
      operation.controller.abort();
      this.operations.delete(operation.id);
      aborted.push(operation);
    });

    return aborted;
  }

  getSessionOperations(sessionId: string): OperationRecord[] {
    return Array.from(this.operations.values()).filter(
      operation => operation.sessionId === sessionId
    );
  }
}
