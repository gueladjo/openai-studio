// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type Project, type Session } from '../types';
import { Sidebar } from './Sidebar';

describe('Sidebar workspace merge controls', () => {
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
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  const renderSidebar = async ({
    onMergeData = vi.fn(),
    mergeDisabled = false,
    undoWorkspaceAction = null,
    sessions = [],
    projects = [],
    onApiKeySave,
    onNewSession = vi.fn()
  }: {
    onMergeData?: (file: File) => void;
    mergeDisabled?: boolean;
    undoWorkspaceAction?: 'merge' | 'restore' | null;
    sessions?: Session[];
    projects?: Project[];
    onApiKeySave?: (key: string) => void | Promise<void>;
    onNewSession?: (projectId?: string) => void;
  } = {}) => {
    await act(async () => {
      root.render(
        <Sidebar
          sessions={sessions}
          projects={projects}
          currentSessionId={null}
          onSelectSession={() => undefined}
          onNewSession={onNewSession}
          onDeleteSession={() => undefined}
          isDarkMode={false}
          toggleTheme={() => undefined}
          apiKey=""
          onApiKeyChange={() => undefined}
          onApiKeySave={onApiKeySave}
          onExportData={() => undefined}
          onImportData={() => undefined}
          onMergeData={onMergeData}
          mergeDisabled={mergeDisabled}
          backupState={{
            supported: false,
            enabled: false,
            destinationStatus: 'unavailable',
            running: false,
            backups: []
          }}
          onToggleAutomaticBackups={() => undefined}
          onChooseBackupFolder={() => undefined}
          onReconnectBackupFolder={() => undefined}
          onBackUpNow={() => undefined}
          onRestoreManagedBackup={() => undefined}
          onExportManagedBackup={() => undefined}
          onDeleteManagedBackup={() => undefined}
          undoWorkspaceAction={undoWorkspaceAction}
          onUndoWorkspaceMutation={() => undefined}
        />
      );
    });
    const settingsLabel = Array.from(container.querySelectorAll('span'))
      .find(element => element.textContent === 'Settings');
    await act(async () => {
      settingsLabel?.parentElement?.parentElement?.parentElement?.click();
    });
  };

  it('shows a settings title and icon without the former user label', async () => {
    await renderSidebar();

    expect(container.textContent).not.toContain('OpenAI User');
    expect(container.querySelector('.lucide-settings')).not.toBeNull();
    const settingsLabel = Array.from(container.querySelectorAll('span'))
      .find(element => element.textContent === 'Settings');
    expect(settingsLabel?.classList).toContain('text-base');
  });

  it('uses a separate ZIP input and forwards the selected file immediately', async () => {
    const onMergeData = vi.fn();
    await renderSidebar({ onMergeData });
    const inputs = container.querySelectorAll<HTMLInputElement>(
      'input[type="file"]'
    );
    expect(inputs).toHaveLength(2);
    const mergeFile = new File(['merge bytes'], 'merge.zip', {
      type: 'application/zip'
    });
    Object.defineProperty(inputs[1], 'files', {
      configurable: true,
      value: [mergeFile]
    });

    await act(async () => {
      inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onMergeData).toHaveBeenCalledWith(mergeFile);
    expect(inputs[1].value).toBe('');
  });

  it('disables merge independently and labels the latest undo action', async () => {
    await renderSidebar({
      mergeDisabled: true,
      undoWorkspaceAction: 'merge'
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const merge = buttons.find(button => button.textContent?.trim() === 'Merge');
    const undo = buttons.find(button => (
      button.textContent?.includes('Undo last merge')
    ));

    expect(merge?.disabled).toBe(true);
    expect(merge?.title).toContain('response is active');
    expect(undo).toBeDefined();
  });

  it('orders restore before merge and keeps the backup direction icons visible', async () => {
    await renderSidebar();
    const actionButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => ['Backup', 'Restore', 'Merge'].includes(
        button.textContent?.trim() || ''
      ));

    expect(actionButtons.map(button => button.textContent?.trim())).toEqual([
      'Backup',
      'Restore',
      'Merge'
    ]);
    expect(actionButtons[0].querySelector('.lucide-download')).not.toBeNull();
    expect(actionButtons[1].querySelector('.lucide-upload')).not.toBeNull();
    expect(actionButtons[0].querySelector('svg')?.classList).toContain('shrink-0');
    expect(actionButtons[1].querySelector('svg')?.classList).toContain('shrink-0');
  });

  it('shows project chat paths in global search and stages API-key changes', async () => {
    const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
    const project: Project = {
      id: 'project-1',
      name: 'Client Alpha',
      icon: 'briefcase',
      instructions: '',
      defaultConfig,
      sources: [],
      createdAt: 1,
      updatedAt: 1
    };
    const session: Session = {
      id: 'chat-1',
      title: 'Quarterly plan',
      projectId: project.id,
      messages: [],
      config: DEFAULT_CONFIG,
      lastModified: 1
    };
    const onApiKeySave = vi.fn();
    await renderSidebar({ sessions: [session], projects: [project], onApiKeySave });

    expect(container.querySelector('.lucide-briefcase-business')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('h3')).map(heading => (
      heading.textContent?.trim()
    ))).toEqual(['Projects', 'Chats']);
    expect(container.textContent).not.toContain('General chats');
    const projectButton = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.includes('Client Alpha')
    );
    expect(projectButton?.textContent?.trim()).toBe('Client Alpha');

    const search = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search projects and chats..."]'
    )!;
    const searchSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      searchSetter?.call(search, 'quarterly');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('Quarterly plan');
    expect(container.textContent).toContain('/ Client Alpha');

    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      searchSetter?.call(keyInput, 'sk-staged');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onApiKeySave).not.toHaveBeenCalled();
    const save = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Save API key'
    )!;
    await act(async () => save.click());
    expect(onApiKeySave).toHaveBeenCalledWith('sk-staged');
  });

  it('starts chats from project rows and the standalone Chats section', async () => {
    const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
    const project: Project = {
      id: 'project-1',
      name: 'Client Alpha',
      icon: 'briefcase',
      instructions: '',
      defaultConfig,
      sources: [],
      createdAt: 1,
      updatedAt: 1
    };
    const onNewSession = vi.fn();
    await renderSidebar({ projects: [project], onNewSession });

    const projectShortcut = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New chat in Client Alpha"]'
    )!;
    const standaloneShortcut = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New standalone chat"]'
    )!;

    await act(async () => projectShortcut.click());
    await act(async () => standaloneShortcut.click());

    expect(onNewSession).toHaveBeenNthCalledWith(1, 'project-1');
    expect(onNewSession).toHaveBeenNthCalledWith(2);
  });
});
