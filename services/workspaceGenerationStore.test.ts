import { describe, expect, it } from 'vitest';
import type { WorkspaceGenerationAdapter, WorkspaceGenerationData } from './workspaceGenerationStore';
import { WorkspaceGenerationStore } from './workspaceGenerationStore';

class MemoryAdapter implements WorkspaceGenerationAdapter {
  readonly files = new Map<string, Blob | string>();
  beforeReadBlob: ((path: string) => Promise<void>) | null = null;

  async readText(path: string): Promise<string | null> {
    const value = this.files.get(path);
    return typeof value === 'string' ? value : null;
  }

  async writeText(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }

  async readBlob(path: string): Promise<Blob | null> {
    await this.beforeReadBlob?.(path);
    const value = this.files.get(path);
    return value instanceof Blob ? value : null;
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    this.files.set(path, blob);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter(path => path.startsWith(prefix));
  }
}

const emptyWorkspace = (apiKey: string): WorkspaceGenerationData => ({
  sessions: [],
  settings: { theme: 'dark', apiKey },
  instructions: [],
  projects: [],
  projectRemoteState: { indexes: {}, cleanupTombstones: [] }
});

describe('workspace generation store', () => {
  it('keeps a blob that is still being stored when a concurrent save collects garbage', async () => {
    const adapter = new MemoryAdapter();
    const store = new WorkspaceGenerationStore(adapter);
    await store.commit(null, emptyWorkspace('first'));

    // Block the read-back that follows the blob write and let a save's garbage
    // collection run in that window.
    let interleaved = false;
    adapter.beforeReadBlob = async path => {
      if (interleaved || !adapter.files.has(path)) return;
      interleaved = true;
      adapter.beforeReadBlob = null;
      await store.commit(0, emptyWorkspace('second'));
    };

    const reference = await store.storeBlob(new Blob(['attachment bytes']), 'text/plain');

    expect(interleaved).toBe(true);
    expect(await store.readBlob(reference)).not.toBeNull();
  });
});
