import { describe, expect, it } from 'vitest';
import { OperationRegistry } from './operationRegistry';

describe('OperationRegistry', () => {
  it('invalidates only operations belonging to a deleted session', () => {
    const registry = new OperationRegistry();
    const deletedSession = registry.begin({
      id: 'send-a',
      kind: 'response',
      sessionId: 'session-a'
    });
    const otherSession = registry.begin({
      id: 'send-b',
      kind: 'response',
      sessionId: 'session-b'
    });

    expect(registry.invalidateSession('session-a')).toEqual([deletedSession]);
    expect(deletedSession.controller.signal.aborted).toBe(true);
    expect(registry.isCurrent(deletedSession)).toBe(false);
    expect(registry.isCurrent(otherSession)).toBe(true);

    const laterOperation = registry.begin({
      id: 'send-a-later',
      kind: 'response',
      sessionId: 'session-a'
    });
    expect(registry.isCurrent(laterOperation)).toBe(true);
  });

  it('invalidates all pre-stream, streaming, and title work on workspace replacement', () => {
    const registry = new OperationRegistry();
    const preparing = registry.begin({
      id: 'preparing',
      kind: 'response',
      sessionId: 'session-a'
    });
    const title = registry.begin({
      id: 'title',
      kind: 'title',
      sessionId: 'session-a'
    });
    const workspaceRead = registry.begin({
      id: 'workspace-read',
      kind: 'import-read'
    });

    expect(registry.invalidateWorkspace()).toEqual([
      preparing,
      title,
      workspaceRead
    ]);
    expect(preparing.controller.signal.aborted).toBe(true);
    expect(title.controller.signal.aborted).toBe(true);
    expect(workspaceRead.controller.signal.aborted).toBe(true);
    expect(registry.isCurrent(preparing)).toBe(false);

    const restoredWorkspaceOperation = registry.begin({
      id: 'restored',
      kind: 'response',
      sessionId: 'session-a'
    });
    expect(registry.isCurrent(restoredWorkspaceOperation)).toBe(true);
  });

  it('does not let a completed operation become current again', () => {
    const registry = new OperationRegistry();
    const operation = registry.begin({
      id: 'complete-me',
      kind: 'title',
      sessionId: 'session-a'
    });

    registry.complete(operation);

    expect(registry.isCurrent(operation)).toBe(false);
  });
});
