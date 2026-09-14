import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  GitMerge,
  Key,
  Loader2,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  Undo2,
  Upload
} from 'lucide-react';
import { APP_VERSION } from '../constants';
import { BackupSchedulerState } from '../services/backupScheduler';
import {
  registerFileDialogFocusRecovery,
  restoreFocusAfterFileDialog
} from '../utils/focusRecovery';
import {
  Button,
  Callout,
  Dialog,
  Pill,
  Segmented,
  Switch,
  cx,
  formatBytes,
  inputClass
} from './ui';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
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
  readOnly?: boolean;
}

const SettingsSection: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ title, description, children }) => (
  <section className="space-y-3">
    <div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p>}
    </div>
    {children}
  </section>
);

const INTEGRITY_TONES = {
  valid: 'accent',
  corrupt: 'danger',
  unverified: 'neutral'
} as const;

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onClose,
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
  readOnly = false
}) => {
  const [isAutomaticBackupOpen, setIsAutomaticBackupOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mergeFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setApiKeyDraft(apiKey), [apiKey]);

  const toggleAutomaticBackupDetails = () => {
    const opening = !isAutomaticBackupOpen;
    setIsAutomaticBackupOpen(opening);
    if (opening) onRefreshManagedBackups();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    restoreFocusAfterFileDialog();
    if (e.target.files && e.target.files.length > 0) {
      onImportData(e.target.files[0]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleMergeFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    restoreFocusAfterFileDialog();
    if (e.target.files && e.target.files.length > 0) {
      onMergeData(e.target.files[0]);
    }
    if (mergeFileInputRef.current) mergeFileInputRef.current.value = '';
  };

  const theme = isDarkMode ? 'dark' : 'light';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      titleId="settings-dialog-title"
      size="lg"
      bodyClassName="space-y-8 pt-1"
    >
      <SettingsSection title="Appearance">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3">
          <div className="text-sm text-ink-2">Interface theme</div>
          <Segmented
            label="Theme"
            disabled={readOnly}
            value={theme}
            className="w-full sm:w-auto"
            options={[
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'dark', label: 'Dark', icon: Moon }
            ]}
            onChange={next => {
              if (next !== theme) toggleTheme();
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="API key"
        description="Overrides the local environment key. Stored unencrypted in this workspace and never included in backups."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Key size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              type="password"
              value={onApiKeySave ? apiKeyDraft : apiKey}
              onChange={(e) => {
                if (onApiKeySave) setApiKeyDraft(e.target.value);
                else onApiKeyChange(e.target.value);
              }}
              disabled={readOnly}
              placeholder="sk-…"
              aria-label="OpenAI API key"
              autoComplete="off"
              className={cx(inputClass, 'pl-9 font-mono')}
            />
          </div>
          {onApiKeySave && (
            <Button
              variant="primary"
              onClick={() => onApiKeySave(apiKeyDraft)}
              disabled={readOnly || apiKeyDraft === apiKey}
            >
              Save API key
            </Button>
          )}
        </div>
        {(pendingRemoteCleanupCount > 0 || remoteCleanupError) && (
          <Callout tone="warn" icon={AlertTriangle}>
            <div className="font-medium">
              {pendingRemoteCleanupCount > 0
                ? `Project deletion pending (${pendingRemoteCleanupCount})`
                : 'Project source issue'}
            </div>
            {remoteCleanupError && <div className="mt-1">{remoteCleanupError}</div>}
            {pendingRemoteCleanupCount > 0 && onRetryRemoteCleanup && (
              <Button size="sm" icon={RefreshCw} iconSize={12} onClick={onRetryRemoteCleanup} className="mt-2">
                Retry cleanup
              </Button>
            )}
          </Callout>
        )}
      </SettingsSection>

      <SettingsSection
        title="Workspace data"
        description="Portable ZIP archives hold chats, projects, sources, instructions, and attachments. They are not encrypted."
      >
        <div className="grid grid-cols-3 gap-2">
          <Button icon={Download} onClick={onExportData} title="Save a verified ZIP backup">
            Backup
          </Button>
          <Button
            icon={Upload}
            onClick={() => fileInputRef.current?.click()}
            disabled={readOnly}
            title="Replace this workspace from a ZIP"
          >
            Restore
          </Button>
          <Button
            icon={GitMerge}
            onClick={() => mergeFileInputRef.current?.click()}
            disabled={mergeDisabled}
            title={mergeDisabled
              ? 'Merge is unavailable while the workspace or a response is active'
              : 'Import chats from a ZIP without replacing this workspace'}
          >
            Merge
          </Button>
          <input
            type="file"
            accept=".zip,application/zip"
            ref={input => {
              fileInputRef.current = input;
              registerFileDialogFocusRecovery(input);
            }}
            onChange={handleFileSelect}
            disabled={readOnly}
            className="hidden"
          />
          <input
            type="file"
            accept=".zip,application/zip"
            ref={input => {
              mergeFileInputRef.current = input;
              registerFileDialogFocusRecovery(input);
            }}
            onChange={handleMergeFileSelect}
            disabled={mergeDisabled}
            className="hidden"
          />
        </div>
        {undoWorkspaceAction && (
          <Button
            block
            icon={Undo2}
            onClick={onUndoWorkspaceMutation}
            disabled={readOnly}
            className="border-warn/40 bg-warn-soft text-warn hover:bg-warn-soft"
          >
            Undo last {undoWorkspaceAction}
          </Button>
        )}
      </SettingsSection>

      <SettingsSection title="Automatic backups">
        {backupState.supported ? (
          <div className="rounded-xl border border-line bg-surface-2">
            <button
              type="button"
              onClick={toggleAutomaticBackupDetails}
              aria-expanded={isAutomaticBackupOpen}
              className="flex w-full items-center justify-between gap-2 px-3 py-3 text-left"
            >
              <span className="flex items-center gap-2 text-sm text-ink">
                <ShieldCheck size={15} className="text-ink-3" aria-hidden="true" />
                Automatic daily backups
                <Pill tone={backupState.enabled ? 'accent' : 'neutral'}>
                  {backupState.enabled ? 'On' : 'Off'}
                </Pill>
              </span>
              {isAutomaticBackupOpen
                ? <ChevronUp size={15} className="shrink-0 text-ink-3" aria-hidden="true" />
                : <ChevronDown size={15} className="shrink-0 text-ink-3" aria-hidden="true" />}
            </button>
            {isAutomaticBackupOpen && (
              <div className="space-y-3 border-t border-line px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink-2">Enable automatic backups</span>
                  <Switch
                    label="Enable automatic backups"
                    checked={backupState.enabled}
                    onChange={onToggleAutomaticBackups}
                    disabled={readOnly || backupState.running}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    icon={FolderOpen}
                    iconSize={13}
                    onClick={onChooseBackupFolder}
                    disabled={backupState.running}
                  >
                    {backupState.destinationStatus === 'unavailable' ? 'Choose folder' : 'Change folder'}
                  </Button>
                  {backupState.destinationStatus === 'permission-required' ? (
                    <Button size="sm" icon={RefreshCw} iconSize={13} onClick={onReconnectBackupFolder}>
                      Reconnect
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      icon={backupState.running ? Loader2 : ShieldCheck}
                      iconSize={13}
                      onClick={onBackUpNow}
                      disabled={readOnly || backupState.running || backupState.destinationStatus !== 'connected'}
                      className={backupState.running ? '[&_svg]:animate-spin' : undefined}
                    >
                      Back up now
                    </Button>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-ink-3">
                  {backupState.lastSuccessAt
                    ? `Last successful: ${new Date(backupState.lastSuccessAt).toLocaleString()}.`
                    : 'No successful managed backup yet.'}
                  {backupState.nextDueAt
                    ? ` Next due: ${new Date(backupState.nextDueAt).toLocaleString()}.`
                    : ''}
                </p>
                {backupState.backups.slice(0, 3).map(backup => (
                  <div
                    key={backup.filename}
                    className="rounded-lg border border-line bg-surface p-3 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-ink">
                        {backup.preview
                          ? new Date(backup.preview.createdAt).toLocaleString()
                          : backup.filename}
                      </span>
                      <Pill tone={INTEGRITY_TONES[backup.integrity]}>
                        {backup.integrity === 'unverified' ? 'not verified' : backup.integrity}
                      </Pill>
                    </div>
                    <div className="mt-1 text-ink-3">{formatBytes(backup.size)}</div>
                    {backup.integrity === 'valid' && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button size="sm" variant="primary" disabled={readOnly} onClick={() => onRestoreManagedBackup(backup.filename)}>
                          Restore
                        </Button>
                        <Button size="sm" onClick={() => onExportManagedBackup(backup.filename)}>
                          Export
                        </Button>
                        <Button size="sm" variant="danger" disabled={readOnly} onClick={() => onDeleteManagedBackup(backup.filename)}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
                {(backupActionError || backupState.error) && (
                  <Callout tone="danger" icon={AlertTriangle}>
                    {backupActionError || backupState.error}
                  </Callout>
                )}
                {backupState.warning && (
                  <Callout tone="warn" icon={AlertTriangle}>{backupState.warning}</Callout>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-ink-3">
            Automatic folder backups are unavailable in this browser. Use Backup, Restore, and Merge above.
          </p>
        )}
      </SettingsSection>

      <SettingsSection title="About">
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm">
          <span className="text-ink-2">OpenAI Studio</span>
          <span className="font-mono text-xs text-ink">v{APP_VERSION}</span>
        </div>
      </SettingsSection>
    </Dialog>
  );
};
