import React, { useEffect, useRef, useState } from 'react';
import {
  Download,
  FileSearch,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react';
import {
  ChatConfig,
  Project,
  ProjectDefaultConfig,
  ProjectIcon,
  ProjectRemoteIndex,
  ProjectSource,
  Session
} from '../types';
import {
  registerFileDialogFocusRecovery,
  restoreFocusAfterFileDialog
} from '../utils/focusRecovery';
import { MAX_INDEXED_USAGE_BYTES } from '../utils/projectSources';
import { ConfigPanel } from './ConfigPanel';
import { PROJECT_ICON_OPTIONS, ProjectIconGlyph } from './ProjectIcon';

interface ProjectHomeProps {
  project: Project;
  sessions: Session[];
  remoteIndex?: ProjectRemoteIndex;
  totalIndexedUsageBytes: number;
  busySourceIds?: ReadonlySet<string>;
  sourceWorkBusy?: boolean;
  error?: string | null;
  readOnly?: boolean;
  onUpdate: (project: Project) => void;
  onNewChat: () => void;
  onAddSources: (files: File[]) => void;
  onDeleteSource: (source: ProjectSource) => void;
  onRetrySource: (source: ProjectSource) => void;
  onDownloadSource: (source: ProjectSource) => void;
  onDeleteProject: () => void;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

const getCapabilityLabel = (source: ProjectSource): string => {
  if (source.capability === 'file_search') return 'Searchable';
  if (source.capability === 'code_interpreter') return 'Analysis';
  return 'Attach when needed';
};

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
  onDeleteProject
}) => {
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState(project.name);
  useEffect(() => setNameDraft(project.name), [project.id, project.name]);
  const update = (changes: Partial<Project>) => onUpdate({
    ...project,
    ...changes,
    updatedAt: Date.now()
  });
  const updateConfig = (config: ChatConfig) => {
    const { systemInstructionId: _systemInstructionId, ...defaultConfig } = config;
    update({ defaultConfig: defaultConfig as ProjectDefaultConfig });
  };
  const usagePercent = Math.min(
    100,
    totalIndexedUsageBytes / MAX_INDEXED_USAGE_BYTES * 100
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-white md:flex-row md:overflow-hidden dark:bg-[#0d1117]">
      <div className="contents md:block md:min-w-0 md:flex-1 md:overflow-y-auto">
      <div className="order-1 min-w-0 px-4 pt-6 sm:px-8 md:pb-0">
        <div className="mx-auto max-w-4xl space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                  <ProjectIconGlyph icon={project.icon} size={22} />
                </div>
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
                  className="min-w-0 flex-1 border-0 bg-transparent text-2xl font-semibold text-gray-900 outline-none dark:text-white"
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <select
                  value={project.icon}
                  onChange={event => update({ icon: event.target.value as ProjectIcon })}
                  disabled={readOnly}
                  aria-label="Project icon"
                  className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-[#161b22]"
                >
                  {PROJECT_ICON_OPTIONS.map(item => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="button"
              onClick={onNewChat}
              disabled={readOnly}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus size={16} />
              New chat
            </button>
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Project instructions</h2>
            <p className="text-xs text-gray-500">Applied live to future requests in all {sessions.length} project chat{sessions.length === 1 ? '' : 's'}.</p>
            <textarea
              value={project.instructions}
              onChange={event => update({ instructions: event.target.value })}
              disabled={readOnly}
              placeholder="Tell the model how to work in this project…"
              className="min-h-36 w-full resize-y rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-[#161b22]"
            />
          </section>

          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Files / Sources</h2>
                <p className="mt-1 text-xs text-gray-500">{project.sources.length} of 40 sources</p>
              </div>
              <button
                type="button"
                onClick={() => sourceInputRef.current?.click()}
                disabled={readOnly || sourceWorkBusy || project.sources.length >= 40}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                <Upload size={14} />
                Add sources
              </button>
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
            </div>

            <div className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-gray-500">App-managed indexed storage</span>
                <span className="font-medium">{formatBytes(totalIndexedUsageBytes)} / 900 MiB</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${usagePercent}%` }} />
              </div>
            </div>

            {project.sources.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-gray-700">
                Add reusable documents, data files, or images to this project.
              </div>
            ) : (
              <div className="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
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
                    <div key={source.id} className="flex min-w-0 items-center gap-3 p-3">
                      {source.capability === 'file_search'
                        ? <FileSearch size={18} className="shrink-0 text-blue-500" />
                        : <FileText size={18} className="shrink-0 text-gray-500" />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{source.name}</div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                          <span>{source.mimeType}</span>
                          <span>{formatBytes(source.byteSize)}</span>
                          <span>{getCapabilityLabel(source)}</span>
                          <span className={status === 'failed' ? 'text-red-500' : ''}>{displayStatus}</span>
                        </div>
                        {remote?.lastError && <p className="mt-1 text-[11px] text-red-500">{remote.lastError}</p>}
                        {source.capability === 'direct_attachment' && (
                          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">Not automatically injected; attach it to a message when needed.</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {(status === 'failed' || status === 'needs indexing') && source.capability !== 'direct_attachment' && (
                          <button type="button" onClick={() => onRetrySource(source)} disabled={readOnly || sourceWorkBusy} aria-label={`Retry indexing ${source.name}`} title={`Retry indexing ${source.name}`} className="rounded p-2 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800">
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                          </button>
                        )}
                        <button type="button" onClick={() => onDownloadSource(source)} aria-label={`Download ${source.name}`} title={`Download ${source.name}`} className="rounded p-2 hover:bg-gray-100 dark:hover:bg-gray-800">
                          <Download size={14} />
                        </button>
                        <button type="button" onClick={() => onDeleteSource(source)} disabled={readOnly || sourceWorkBusy} aria-label={`Delete ${source.name}`} title={`Delete ${source.name}`} className="rounded p-2 text-red-500 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/30">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

        </div>
      </div>
      <div className="order-3 min-w-0 px-4 pb-6 pt-8 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <section className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Delete project</h2>
            <p className="mt-1 text-xs text-gray-500">Permanently removes this project, its chats, instructions, and local sources. Existing external backups are not erased.</p>
            <button type="button" onClick={onDeleteProject} disabled={readOnly || sourceWorkBusy} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-[#161b22] dark:text-gray-200 dark:hover:bg-gray-800">
              <Trash2 size={14} />
              Delete permanently
            </button>
          </section>
        </div>
      </div>
      </div>

      <section className="order-2 mx-4 mt-8 overflow-hidden rounded-xl border border-gray-200 sm:mx-8 md:order-none md:m-0 md:h-full md:rounded-none md:border-0 dark:border-gray-700">
        <ConfigPanel
          config={{ ...project.defaultConfig, systemInstructionId: undefined }}
          onChange={updateConfig}
          systemInstructions={[]}
          onUpdateSystemInstruction={() => undefined}
          onCreateSystemInstruction={() => undefined}
          onDeleteSystemInstruction={() => undefined}
          hideSystemInstructions
          readOnly={readOnly}
        />
      </section>
    </div>
  );
};
