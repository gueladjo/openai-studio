import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileSearch,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  Upload
} from 'lucide-react';
import {
  Project,
  ProjectEdit,
  ProjectRemoteIndex,
  ProjectSource,
  Session
} from '../types';
import {
  registerFileDialogFocusRecovery,
  restoreFocusAfterFileDialog
} from '../utils/focusRecovery';
import { MAX_INDEXED_USAGE_BYTES, MAX_PROJECT_SOURCES } from '../utils/projectSources';
import { PROJECT_ICON_OPTIONS, ProjectIconGlyph } from './ProjectIcon';
import {
  Button,
  Callout,
  IconButton,
  Pill,
  SidebarControls,
  ViewHeader,
  cx,
  formatBytes,
  textareaClass
} from './ui';

interface ProjectHomeProps {
  project: Project;
  sessions: Session[];
  remoteIndex?: ProjectRemoteIndex;
  totalIndexedUsageBytes: number;
  busySourceIds?: ReadonlySet<string>;
  sourceWorkBusy?: boolean;
  error?: string | null;
  readOnly?: boolean;
  onUpdate: (projectId: string, changes: ProjectEdit) => void;
  onNewChat: () => void;
  onAddSources: (files: File[]) => void;
  onDeleteSource: (source: ProjectSource) => void;
  onRetrySource: (source: ProjectSource) => void;
  onDownloadSource: (source: ProjectSource) => void;
  onDeleteProject: () => void;
  onOpenSidebar?: () => void;
  onToggleSidebar?: () => void;
  isSidebarCollapsed?: boolean;
}

const getCapabilityLabel = (source: ProjectSource): string => {
  if (source.capability === 'file_search') return 'Searchable';
  if (source.capability === 'code_interpreter') return 'Analysis';
  return 'Attach when needed';
};

const STATUS_TONES: Record<string, 'neutral' | 'accent' | 'danger' | 'warn'> = {
  ready: 'accent',
  failed: 'danger',
  uploading: 'warn',
  indexing: 'warn',
  removing: 'neutral',
  'needs indexing': 'warn'
};

const SourceIcon: React.FC<{ source: ProjectSource }> = ({ source }) => {
  const Icon = source.capability === 'file_search'
    ? FileSearch
    : source.capability === 'code_interpreter'
      ? Table2
      : FileText;
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-2">
      <Icon size={17} aria-hidden="true" />
    </span>
  );
};

const Card: React.FC<{
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, action, children }) => (
  <section className="rounded-2xl border border-line bg-surface shadow-card">
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p>}
      </div>
      {action}
    </div>
    <div className="px-5 pb-5">{children}</div>
  </section>
);

export const ProjectHome: React.FC<ProjectHomeProps> = ({
  project,
  sessions,
  remoteIndex,
  totalIndexedUsageBytes,
  busySourceIds = new Set(),
  sourceWorkBusy = busySourceIds.size > 0,
  error,
  readOnly = false,
  onUpdate,
  onNewChat,
  onAddSources,
  onDeleteSource,
  onRetrySource,
  onDownloadSource,
  onDeleteProject,
  onOpenSidebar,
  onToggleSidebar,
  isSidebarCollapsed
}) => {
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState(project.name);
  useEffect(() => setNameDraft(project.name), [project.id, project.name]);
  const update = (changes: ProjectEdit) => onUpdate(project.id, changes);
  const usagePercent = Math.min(
    100,
    totalIndexedUsageBytes / MAX_INDEXED_USAGE_BYTES * 100
  );
  const chatCountLabel = `${sessions.length} project chat${sessions.length === 1 ? '' : 's'}`;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <ViewHeader>
        <SidebarControls
          onOpenSidebar={onOpenSidebar}
          onToggleSidebar={onToggleSidebar}
          isSidebarCollapsed={isSidebarCollapsed}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <ProjectIconGlyph icon={project.icon} size={16} className="shrink-0 text-ink-3" />
          <span className="truncate text-sm font-semibold text-ink">{project.name}</span>
          <span className="hidden text-xs text-ink-3 sm:inline">· {chatCountLabel}</span>
        </div>
        <Button variant="primary" size="sm" icon={Plus} onClick={onNewChat} disabled={readOnly}>
          New chat
        </Button>
      </ViewHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-6 sm:px-8">
          <section className="space-y-4">
            <div className="flex items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <ProjectIconGlyph icon={project.icon} size={26} />
              </span>
              <input
                value={nameDraft}
                onChange={event => setNameDraft(event.target.value)}
                onBlur={() => {
                  const name = nameDraft.trim();
                  if (name) update({ name });
                  else setNameDraft(project.name);
                }}
                disabled={readOnly}
                aria-label="Project name"
                placeholder="Project name"
                className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight text-ink outline-none transition-colors hover:border-line focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60"
              />
            </div>
            <div
              role="radiogroup"
              aria-label="Project icon"
              className="flex flex-wrap gap-1.5"
            >
              {PROJECT_ICON_OPTIONS.map(item => {
                const selected = project.icon === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${item.label} icon`}
                    title={item.label}
                    disabled={readOnly}
                    onClick={() => update({ icon: item.value })}
                    className={cx(
                      'flex h-9 w-9 items-center justify-center rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50',
                      selected
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line bg-surface text-ink-3 hover:border-line-strong hover:text-ink'
                    )}
                  >
                    <ProjectIconGlyph icon={item.value} size={16} />
                  </button>
                );
              })}
            </div>
          </section>

          {error && (
            <Callout role="alert" tone="danger" icon={AlertTriangle}>{error}</Callout>
          )}

          <Card
            title="Project instructions"
            description={`Applied live to future requests in all ${chatCountLabel}.`}
          >
            <textarea
              value={project.instructions}
              onChange={event => update({ instructions: event.target.value })}
              disabled={readOnly}
              placeholder="Tell the model how to work in this project…"
              className={cx(textareaClass, 'min-h-36 bg-surface-2')}
            />
          </Card>

          <Card
            title="Sources"
            description={`${project.sources.length} of ${MAX_PROJECT_SOURCES} sources. Searchable documents become File Search context, data files feed Code Interpreter, and other files can be attached when needed.`}
            action={(
              <>
                <Button
                  size="sm"
                  icon={Upload}
                  onClick={() => sourceInputRef.current?.click()}
                  disabled={readOnly || sourceWorkBusy || project.sources.length >= MAX_PROJECT_SOURCES}
                >
                  Add sources
                </Button>
                <input
                  ref={input => {
                    sourceInputRef.current = input;
                    registerFileDialogFocusRecovery(input);
                  }}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={event => {
                    const files = Array.from(event.target.files || []);
                    event.target.value = '';
                    restoreFocusAfterFileDialog();
                    if (files.length > 0) onAddSources(files);
                  }}
                />
              </>
            )}
          >
            <div className="space-y-4">
              <div className="rounded-xl bg-surface-2 p-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-ink-2">Indexed storage across projects</span>
                  <span className="font-medium tabular-nums text-ink">
                    {formatBytes(totalIndexedUsageBytes)} / 900 MiB
                  </span>
                </div>
                <div
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
                  role="progressbar"
                  aria-label="Indexed storage usage"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(usagePercent)}
                >
                  <div
                    className={cx('h-full rounded-full transition-[width]', usagePercent > 90 ? 'bg-danger' : 'bg-accent')}
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
              </div>

              {project.sources.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-3">
                  Add reusable documents, data files, or images to this project.
                </div>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {project.sources.map(source => {
                    const remote = remoteIndex?.files[source.id];
                    const busy = busySourceIds.has(source.id);
                    const status = source.capability === 'direct_attachment'
                      ? 'ready'
                      : remote?.status || 'needs indexing';
                    const displayStatus = busy && status === 'needs indexing'
                      ? 'uploading'
                      : status;
                    return (
                      <li key={source.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                        <SourceIcon source={source} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">{source.name}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
                            <span className="truncate">{source.mimeType}</span>
                            <span>{formatBytes(source.byteSize)}</span>
                            <Pill>{getCapabilityLabel(source)}</Pill>
                            <Pill tone={STATUS_TONES[displayStatus] || 'neutral'}>
                              {busy && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
                              {displayStatus}
                            </Pill>
                          </div>
                          {remote?.lastError && (
                            <p className="mt-1 text-[11px] text-danger">{remote.lastError}</p>
                          )}
                          {source.capability === 'direct_attachment' && (
                            <p className="mt-1 text-[11px] text-warn">
                              Not automatically injected; attach it to a message when needed.
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center">
                          {(status === 'failed' || status === 'needs indexing') && source.capability !== 'direct_attachment' && (
                            <IconButton
                              size="sm"
                              iconSize={15}
                              label={`Retry indexing ${source.name}`}
                              icon={busy ? Loader2 : RefreshCw}
                              className={busy ? '[&_svg]:animate-spin' : undefined}
                              onClick={() => onRetrySource(source)}
                              disabled={readOnly || sourceWorkBusy}
                            />
                          )}
                          <IconButton
                            size="sm"
                            iconSize={15}
                            label={`Download ${source.name}`}
                            icon={Download}
                            onClick={() => onDownloadSource(source)}
                          />
                          <IconButton
                            size="sm"
                            iconSize={15}
                            tone="danger"
                            label={`Delete ${source.name}`}
                            icon={Trash2}
                            onClick={() => onDeleteSource(source)}
                            disabled={readOnly || sourceWorkBusy}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>

          <Card
            title="Delete project"
            description="Permanently removes this project, its chats, instructions, and local sources. Existing external backups are not erased."
          >
            <Button
              icon={Trash2}
              onClick={onDeleteProject}
              disabled={readOnly || sourceWorkBusy}
            >
              Delete permanently
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
};
