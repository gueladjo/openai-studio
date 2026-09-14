// @vitest-environment happy-dom

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Session } from '../types';
import { projectFixture, sessionFixture } from '../test/fixtures';
import { changeValue, findButton, useReactView } from '../test/reactView';
import { Sidebar } from './Sidebar';

describe('Sidebar workspace merge controls', () => {
  const view = useReactView();
  let container: HTMLDivElement;

  const renderSidebar = async ({
    onMergeData = vi.fn(),
    mergeDisabled = false,
    undoWorkspaceAction = null,
    sessions = [],
    projects = [],
    onApiKeySave,
    onNewSession = vi.fn(),
    onRefreshManagedBackups = vi.fn(),
    automaticBackupsSupported = false
  }: {
    onMergeData?: (file: File) => void;
    mergeDisabled?: boolean;
    undoWorkspaceAction?: 'merge' | 'restore' | null;
    sessions?: Session[];
    projects?: Project[];
    onApiKeySave?: (key: string) => void | Promise<void>;
    onNewSession?: (projectId?: string) => void;
    onRefreshManagedBackups?: () => void;
    automaticBackupsSupported?: boolean;
  } = {}) => {
    container = await view.render(
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
          supported: automaticBackupsSupported,
          enabled: false,
          destinationStatus: 'unavailable',
          running: false,
          backups: []
        }}
        onToggleAutomaticBackups={() => undefined}
        onChooseBackupFolder={() => undefined}
        onReconnectBackupFolder={() => undefined}
        onRefreshManagedBackups={onRefreshManagedBackups}
        onBackUpNow={() => undefined}
        onRestoreManagedBackup={() => undefined}
        onExportManagedBackup={() => undefined}
        onDeleteManagedBackup={() => undefined}
        undoWorkspaceAction={undoWorkspaceAction}
        onUndoWorkspaceMutation={() => undefined}
      />
    );
    await act(async () => {
      findButton(container, 'Settings')?.click();
    });
  };

  it('refreshes managed backup validation when backup details open', async () => {
    const onRefreshManagedBackups = vi.fn();
    await renderSidebar({
      automaticBackupsSupported: true,
      onRefreshManagedBackups
    });
    const details = findButton(container, 'Automatic daily backups');

    await act(async () => details?.click());

    expect(onRefreshManagedBackups).toHaveBeenCalledTimes(1);
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
    const project = projectFixture({ name: 'Client Alpha', icon: 'briefcase' });
    const session = sessionFixture({
      id: 'chat-1',
      title: 'Quarterly plan',
      projectId: project.id
    });
    const onApiKeySave = vi.fn();
    await renderSidebar({ sessions: [session], projects: [project], onApiKeySave });

    expect(container.querySelector('.lucide-briefcase-business')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('nav h3')).map(heading => (
      heading.textContent?.trim()
    ))).toEqual(['Projects', 'Chats']);
    expect(container.textContent).not.toContain('General chats');
    expect(findButton(container, 'Client Alpha')?.textContent?.trim()).toBe('Client Alpha');

    const search = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search projects and chats..."]'
    )!;
    await changeValue(search, 'quarterly');
    expect(container.textContent).toContain('Quarterly plan');
    expect(container.textContent).toContain('/ Client Alpha');

    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await changeValue(keyInput, 'sk-staged');
    expect(onApiKeySave).not.toHaveBeenCalled();
    await act(async () => findButton(container, 'Save API key')?.click());
    expect(onApiKeySave).toHaveBeenCalledWith('sk-staged');
  });

  it('starts chats from project rows and the standalone Chats section', async () => {
    const project = projectFixture({ name: 'Client Alpha', icon: 'briefcase' });
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

  it('uses the shared breakpoint to keep shortcuts visible on mobile', async () => {
    const project = projectFixture({ name: 'Client Alpha', icon: 'briefcase' });
    await renderSidebar({ projects: [project] });

    const shortcuts = [
      container.querySelector<HTMLButtonElement>('button[aria-label="New chat in Client Alpha"]')!,
      container.querySelector<HTMLButtonElement>('button[aria-label="New standalone chat"]')!
    ];
    shortcuts.forEach(shortcut => {
      expect(shortcut.classList).toContain('opacity-100');
      expect(shortcut.classList).toContain('md:opacity-0');
      expect(shortcut.classList).toContain('md:group-hover:opacity-100');
      expect(shortcut.classList).toContain('md:focus:opacity-100');
      expect(shortcut.parentElement?.classList).toContain('group');
    });
  });
});
