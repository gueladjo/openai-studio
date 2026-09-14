import React, { useState } from 'react';
import { Project, Session } from '../types';
import { APP_VERSION } from '../constants';
import {
  ChevronRight,
  FolderPlus,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X
} from 'lucide-react';
import { BackupSchedulerState } from '../services/backupScheduler';
import { ProjectIconGlyph } from './ProjectIcon';
import { SettingsDialog } from './SettingsDialog';
import { BrandMark, Button, IconButton, Spinner, cx } from './ui';

interface SidebarProps {
  sessions: Session[];
  projects?: Project[];
  currentSessionId: string | null;
  selectedProjectId?: string | null;
  onSelectSession: (id: string) => void;
  onSelectProject?: (id: string) => void;
  onNewProject?: () => void;
  onNewSession: (projectId?: string) => void;
  onDeleteSession: (e: React.MouseEvent, id: string) => void;
  onClose?: () => void;
  onCollapse?: () => void;
  isDarkMode: boolean;
  toggleTheme: () => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onApiKeySave?: (key: string) => void | Promise<void>;
  pendingRemoteCleanupCount?: number;
  remoteCleanupError?: string | null;
  onRetryRemoteCleanup?: () => void;
  onExportData: () => void;
  onImportData: (file: File) => void;
  onMergeData: (file: File) => void;
  mergeDisabled?: boolean;
  backupState: BackupSchedulerState;
  backupActionError?: string | null;
  onToggleAutomaticBackups: (enabled: boolean) => void;
  onChooseBackupFolder: () => void;
  onReconnectBackupFolder: () => void;
  onRefreshManagedBackups: () => void;
  onBackUpNow: () => void;
  onRestoreManagedBackup: (filename: string) => void;
  onExportManagedBackup: (filename: string) => void;
  onDeleteManagedBackup: (filename: string) => void;
  undoWorkspaceAction?: 'merge' | 'restore' | null;
  onUndoWorkspaceMutation: () => void;
  processingSessionIds?: Set<string>;
  readOnly?: boolean;
}

// Shortcuts stay visible on touch layouts and reveal on hover/focus on desktop.
const HOVER_REVEAL_CLASS =
  'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 md:group-hover:disabled:opacity-50';

const SectionHeading: React.FC<{
  title: string;
  action: React.ReactNode;
}> = ({ title, action }) => (
  <div className="group flex h-8 items-center justify-between pl-2 pr-0.5">
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h3>
    {action}
  </div>
);

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  projects = [],
  currentSessionId,
  selectedProjectId = null,
  onSelectSession,
  onSelectProject,
  onNewProject,
  onNewSession,
  onDeleteSession,
  onClose,
  onCollapse,
  isDarkMode,
  toggleTheme,
  apiKey,
  onApiKeyChange,
  onApiKeySave,
  pendingRemoteCleanupCount = 0,
  remoteCleanupError,
  onRetryRemoteCleanup,
  onExportData,
  onImportData,
  onMergeData,
  mergeDisabled = false,
  backupState,
  backupActionError,
  onToggleAutomaticBackups,
  onChooseBackupFolder,
  onReconnectBackupFolder,
  onRefreshManagedBackups,
  onBackUpNow,
  onRestoreManagedBackup,
  onExportManagedBackup,
  onDeleteManagedBackup,
  undoWorkspaceAction = null,
  onUndoWorkspaceMutation,
  processingSessionIds,
  readOnly = false
}) => {
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(projects.map(project => project.id))
  );

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredSessions = sessions
    .filter(session => (session.title || 'Untitled Chat').toLowerCase().includes(normalizedSearch))
    .sort((a, b) => b.lastModified - a.lastModified);
  const standaloneSessions = filteredSessions.filter(session => !session.projectId);
  const matchingProjects = projects.filter(project => (
    !normalizedSearch ||
    project.name.toLowerCase().includes(normalizedSearch) ||
    sessions.some(session => (
      session.projectId === project.id &&
      (session.title || 'Untitled Chat').toLowerCase().includes(normalizedSearch)
    ))
  ));
  const needsAttention = pendingRemoteCleanupCount > 0 || Boolean(remoteCleanupError);

  const toggleProject = (projectId: string) => {
    setExpandedProjectIds(current => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const renderSession = (session: Session, projectName?: string) => {
    const title = session.title || 'Untitled Chat';
    const active = currentSessionId === session.id;
    return (
      <div
        key={session.id}
        role="button"
        tabIndex={0}
        onClick={() => onSelectSession(session.id)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelectSession(session.id);
          }
        }}
        className={cx(
          'group flex h-9 cursor-pointer items-center gap-2 rounded-lg pl-2 pr-1 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          active
            ? 'bg-surface-3 font-medium text-ink'
            : 'text-ink-2 hover:bg-surface-3/70 hover:text-ink'
        )}
      >
        {processingSessionIds?.has(session.id)
          ? <Spinner size={14} className="shrink-0" />
          : <MessageSquare size={14} className="shrink-0 text-ink-3" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">
          {title}
          {normalizedSearch && projectName && (
            <span className="ml-1 text-[10px] font-normal text-ink-3">/ {projectName}</span>
          )}
        </span>
        <button
          type="button"
          onClick={(event) => onDeleteSession(event, session.id)}
          disabled={readOnly}
          className={cx(
            'rounded-md p-1.5 text-ink-3 transition-all hover:bg-danger-soft hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            readOnly ? 'hidden' : active ? 'opacity-100' : HOVER_REVEAL_CLASS
          )}
          aria-label={`Delete ${title}`}
          title="Delete chat"
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas pt-[env(safe-area-inset-top)] md:pt-0">
      <div className="flex h-14 shrink-0 items-center justify-between pl-[max(1rem,env(safe-area-inset-left))] pr-2">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight text-ink">OpenAI Studio</span>
        </div>
        <div className="flex items-center">
          {onCollapse && (
            <IconButton
              label="Hide sidebar"
              icon={PanelLeftClose}
              size="sm"
              className="hidden md:inline-flex"
              onClick={onCollapse}
            />
          )}
          {onClose && (
            <IconButton label="Close menu" icon={X} className="md:hidden" onClick={onClose} />
          )}
        </div>
      </div>

      <div className="space-y-2 px-3 pb-1 pl-[max(0.75rem,env(safe-area-inset-left))]">
        <Button
          variant="primary"
          size="md"
          block
          icon={Plus}
          onClick={() => onNewSession()}
          disabled={readOnly}
          title={readOnly ? 'Another tab is editing this workspace' : 'Start a standalone chat'}
        >
          New chat
        </Button>
        <div className="relative">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            type="search"
            placeholder="Search projects and chats..."
            aria-label="Search projects and chats"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-lg border border-transparent bg-surface-3/70 pl-9 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25"
          />
        </div>
      </div>

      <nav
        aria-label="Projects and chats"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1 pl-[max(0.5rem,env(safe-area-inset-left))]"
      >
        <SectionHeading
          title="Projects"
          action={(
            <IconButton
              label="New project"
              icon={FolderPlus}
              iconSize={15}
              size="sm"
              onClick={onNewProject}
              disabled={readOnly || !onNewProject}
              className={HOVER_REVEAL_CLASS}
            />
          )}
        />
        <div className="space-y-0.5">
          {matchingProjects.map(project => {
            const projectSessions = filteredSessions.filter(session => session.projectId === project.id);
            const expanded = Boolean(normalizedSearch) || expandedProjectIds.has(project.id);
            const selected = selectedProjectId === project.id;
            return (
              <div key={project.id}>
                <div
                  className={cx(
                    'group flex h-9 items-center rounded-lg pr-1 transition-colors',
                    selected ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-3/70 hover:text-ink'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleProject(project.id)}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
                    aria-expanded={expanded}
                    className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <ChevronRight
                      size={14}
                      aria-hidden="true"
                      className={cx('transition-transform duration-150', expanded && 'rotate-90')}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectProject?.(project.id)}
                    aria-current={selected ? 'page' : undefined}
                    className="flex h-9 min-w-0 flex-1 items-center gap-2 pr-1 text-left text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <ProjectIconGlyph icon={project.icon} size={15} className="shrink-0 text-ink-3" />
                    <span className="truncate">{project.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onNewSession(project.id)}
                    disabled={readOnly}
                    className={cx(
                      'rounded-md p-1.5 text-ink-3 transition-all hover:bg-surface hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50',
                      HOVER_REVEAL_CLASS
                    )}
                    aria-label={`New chat in ${project.name}`}
                    title={`New chat in ${project.name}`}
                  >
                    <SquarePen size={15} aria-hidden="true" />
                  </button>
                </div>
                {expanded && projectSessions.length > 0 && (
                  <div className="my-0.5 ml-[1.1rem] space-y-0.5 border-l border-line pl-1.5">
                    {projectSessions.map(session => renderSession(session, project.name))}
                  </div>
                )}
              </div>
            );
          })}
          {projects.length === 0 && !normalizedSearch && (
            <p className="px-2 py-1.5 text-xs leading-relaxed text-ink-3">
              Projects keep instructions and reusable sources together.
            </p>
          )}
        </div>

        <div className="mt-3">
          <SectionHeading
            title="Chats"
            action={(
              <IconButton
                label="New standalone chat"
                icon={SquarePen}
                iconSize={15}
                size="sm"
                onClick={() => onNewSession()}
                disabled={readOnly}
                className={HOVER_REVEAL_CLASS}
              />
            )}
          />
          <div className="space-y-0.5">
            {standaloneSessions.map(session => renderSession(session))}
          </div>
        </div>

        {matchingProjects.length === 0 && standaloneSessions.length === 0 && (
          <div className="mt-10 px-2 text-center text-sm text-ink-3">
            {normalizedSearch ? 'No projects or chats found' : 'No chats yet'}
          </div>
        )}
      </nav>

      <div className="shrink-0 border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))]">
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Settings size={17} aria-hidden="true" className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-left">Settings</span>
          {needsAttention && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-warn"
              role="img"
              aria-label="Project cleanup needs attention"
            />
          )}
          <span className="font-mono text-[10px] text-ink-3">v{APP_VERSION}</span>
        </button>
      </div>

      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        isDarkMode={isDarkMode}
        toggleTheme={toggleTheme}
        apiKey={apiKey}
        onApiKeyChange={onApiKeyChange}
        onApiKeySave={onApiKeySave}
        pendingRemoteCleanupCount={pendingRemoteCleanupCount}
        remoteCleanupError={remoteCleanupError}
        onRetryRemoteCleanup={onRetryRemoteCleanup}
        onExportData={onExportData}
        onImportData={onImportData}
        onMergeData={onMergeData}
        mergeDisabled={mergeDisabled}
        backupState={backupState}
        backupActionError={backupActionError}
        onToggleAutomaticBackups={onToggleAutomaticBackups}
        onChooseBackupFolder={onChooseBackupFolder}
        onReconnectBackupFolder={onReconnectBackupFolder}
        onRefreshManagedBackups={onRefreshManagedBackups}
        onBackUpNow={onBackUpNow}
        onRestoreManagedBackup={onRestoreManagedBackup}
        onExportManagedBackup={onExportManagedBackup}
        onDeleteManagedBackup={onDeleteManagedBackup}
        undoWorkspaceAction={undoWorkspaceAction}
        onUndoWorkspaceMutation={onUndoWorkspaceMutation}
        readOnly={readOnly}
      />
    </div>
  );
};
