// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, Project } from '../types';
import { ProjectHome } from './ProjectHome';

const createProject = (): Project => {
  const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
  return {
    id: 'project-home',
    name: 'Research',
    icon: 'research',
    instructions: 'Use project evidence.',
    defaultConfig,
    sources: [{
      id: 'source-search',
      name: 'evidence.txt',
      mimeType: 'text/plain',
      byteSize: 100,
      localBlob: { sha256: 'a'.repeat(64), byteSize: 100, mimeType: 'text/plain' },
      capability: 'file_search',
      addedAt: 1
    }, {
      id: 'source-analysis',
      name: 'metrics.csv',
      mimeType: 'text/csv',
      byteSize: 200,
      localBlob: { sha256: 'b'.repeat(64), byteSize: 200, mimeType: 'text/csv' },
      capability: 'code_interpreter',
      addedAt: 2
    }, {
      id: 'source-direct',
      name: 'diagram.png',
      mimeType: 'image/png',
      byteSize: 300,
      localBlob: { sha256: 'c'.repeat(64), byteSize: 300, mimeType: 'image/png' },
      capability: 'direct_attachment',
      addedAt: 3
    }],
    createdAt: 1,
    updatedAt: 3
  };
};

describe('ProjectHome', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.electronAPI = {
      restoreFocusAfterDialog: vi.fn().mockResolvedValue(undefined)
    } as unknown as Window['electronAPI'];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.electronAPI;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it('restores Electron focus when the project source picker closes', async () => {
    const onAddSources = vi.fn();
    await act(async () => {
      root.render(<ProjectHome
        project={createProject()}
        sessions={[]}
        totalIndexedUsageBytes={0}
        onUpdate={() => undefined}
        onNewChat={() => undefined}
        onAddSources={onAddSources}
        onDeleteSource={() => undefined}
        onRetrySource={() => undefined}
        onDownloadSource={() => undefined}
        onDeleteProject={() => undefined}
      />);
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const source = new File(['project source'], 'source.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [source]
    });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(window.electronAPI?.restoreFocusAfterDialog).toHaveBeenCalledTimes(1);
    expect(onAddSources).toHaveBeenCalledWith([source]);

    vi.mocked(window.electronAPI!.restoreFocusAfterDialog!).mockClear();
    await act(async () => {
      input.dispatchEvent(new Event('cancel'));
    });
    expect(window.electronAPI?.restoreFocusAfterDialog).toHaveBeenCalledTimes(1);
  });

  it('shows source capabilities, durable statuses, usage, and project errors', async () => {
    await act(async () => {
      root.render(<ProjectHome
        project={createProject()}
        sessions={[]}
        remoteIndex={{
          projectId: 'project-home',
          apiKeyFingerprint: 'd'.repeat(64),
          vectorStoreId: 'vector-1',
          status: 'failed',
          usageBytes: 1024,
          files: {
            'source-search': {
              projectSourceId: 'source-search',
              status: 'failed',
              lastError: 'Indexing failed.'
            },
            'source-analysis': {
              projectSourceId: 'source-analysis',
              openaiFileId: 'file-analysis',
              status: 'ready'
            }
          }
        }}
        totalIndexedUsageBytes={1024}
        error="Project deletion pending."
        onUpdate={() => undefined}
        onNewChat={() => undefined}
        onAddSources={() => undefined}
        onDeleteSource={() => undefined}
        onRetrySource={() => undefined}
        onDownloadSource={() => undefined}
        onDeleteProject={() => undefined}
      />);
    });

    expect(container.textContent).toContain('Searchable');
    expect(container.textContent).toContain('Analysis');
    expect(container.textContent).toContain('Attach when needed');
    expect(container.textContent).toContain('Indexing failed.');
    expect(container.textContent).toContain('Not automatically injected');
    expect(container.textContent).toContain('1.0 KiB / 900 MiB');
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Project deletion pending.');
    expect(container.querySelector(
      'button[aria-label="Retry indexing evidence.txt"][title="Retry indexing evidence.txt"]'
    )).not.toBeNull();
    expect(container.querySelector(
      'button[aria-label="Download evidence.txt"][title="Download evidence.txt"]'
    )).not.toBeNull();
    expect(container.querySelector(
      'button[aria-label="Delete evidence.txt"][title="Delete evidence.txt"]'
    )).not.toBeNull();
    expect(container.querySelector('option[value="health"]')?.textContent)
      .toBe('Health');
    const deleteButton = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.includes('Delete permanently')
    );
    expect(deleteButton?.className).not.toContain('red');
    expect(deleteButton?.closest('section')?.className).not.toContain('red');
  });

  it('commits a nonblank trimmed name on blur and exposes destructive actions', async () => {
    const onUpdate = vi.fn();
    const onDeleteProject = vi.fn();
    const onNewChat = vi.fn();
    await act(async () => {
      root.render(<ProjectHome
        project={createProject()}
        sessions={[]}
        totalIndexedUsageBytes={0}
        onUpdate={onUpdate}
        onNewChat={onNewChat}
        onAddSources={() => undefined}
        onDeleteSource={() => undefined}
        onRetrySource={() => undefined}
        onDownloadSource={() => undefined}
        onDeleteProject={onDeleteProject}
      />);
    });
    const name = container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      setter?.call(name, '  Client work  ');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      name.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Client work'
    }));
    const buttons = Array.from(container.querySelectorAll('button'));
    await act(async () => {
      buttons.find(button => button.textContent?.trim() === 'New chat')?.click();
      buttons.find(button => button.textContent?.includes('Delete permanently'))?.click();
    });
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onDeleteProject).toHaveBeenCalledTimes(1);
  });
});
