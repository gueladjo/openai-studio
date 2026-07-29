import React, { useState, useRef } from 'react';
import { Session } from '../types';
import { APP_VERSION } from '../constants';
import {
  Plus,
  MessageSquare,
  Trash2,
  Search,
  Sun,
  Moon,
  Key,
  ChevronUp,
  ChevronDown,
  Download,
  Upload,
  Database,
  Loader2,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  GitMerge
} from 'lucide-react';
import { BackupSchedulerState } from '../services/backupScheduler';

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (e: React.MouseEvent, id: string) => void;
  isDarkMode: boolean;
  toggleTheme: () => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onExportData: () => void;
  onImportData: (file: File) => void;
  onMergeData: (file: File) => void;
  mergeDisabled?: boolean;
  backupState: BackupSchedulerState;
  backupActionError?: string | null;
  onToggleAutomaticBackups: (enabled: boolean) => void;
  onChooseBackupFolder: () => void;
  onReconnectBackupFolder: () => void;
  onBackUpNow: () => void;
  onRestoreManagedBackup: (filename: string) => void;
  onExportManagedBackup: (filename: string) => void;
  onDeleteManagedBackup: (filename: string) => void;
  undoWorkspaceAction?: 'merge' | 'restore' | null;
  onUndoWorkspaceMutation: () => void;
  processingSessionIds?: Set<string>;
  isMobile?: boolean;
  readOnly?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  isDarkMode,
  toggleTheme,
  apiKey,
  onApiKeyChange,
  onExportData,
  onImportData,
  onMergeData,
  mergeDisabled = false,
  backupState,
  backupActionError,
  onToggleAutomaticBackups,
  onChooseBackupFolder,
  onReconnectBackupFolder,
  onBackUpNow,
  onRestoreManagedBackup,
  onExportManagedBackup,
  onDeleteManagedBackup,
  undoWorkspaceAction = null,
  onUndoWorkspaceMutation,
  processingSessionIds,
  isMobile = false,
  readOnly = false
}) => {
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mergeFileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onImportData(e.target.files[0]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleMergeFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onMergeData(e.target.files[0]);
    }
    if (mergeFileInputRef.current) mergeFileInputRef.current.value = '';
  };

  const filteredSessions = sessions
    .filter(session => (session.title || 'Untitled Chat').toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => b.lastModified - a.lastModified);

  return (
    <div className={`${isMobile ? 'flex-1' : 'w-64 border-r border-gray-200 dark:border-gray-800 flex-shrink-0'} bg-gray-50 dark:bg-[#0d1117] flex flex-col h-full transition-colors duration-200`}>
      {/* Top section */}
      <div className="p-4">
        <button
          onClick={onNewSession}
          disabled={readOnly}
          title={readOnly ? 'Another tab is editing this workspace' : undefined}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 px-4 flex items-center justify-center gap-2 transition-colors font-medium text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={16} />
          <span>New Chat</span>
        </button>
      </div>

      <div className="px-4 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={14} />
          <input 
            type="text" 
            placeholder="Search chats..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-800 rounded-md py-1.5 pl-9 pr-3 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-1 py-2">
        <h3 className="px-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Recent</h3>
        {sessions.length === 0 ? (
          <div className="text-center text-gray-500 text-sm mt-10">No history yet</div>
        ) : filteredSessions.length === 0 ? (
          <div className="text-center text-gray-500 text-sm mt-10">No chats found</div>
        ) : (
          filteredSessions.map((session) => (
            <div
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              className={`group flex items-center justify-between p-2 rounded-md cursor-pointer transition-colors text-sm ${
                currentSessionId === session.id
                  ? 'bg-gray-200 dark:bg-[#1f2937] text-gray-900 dark:text-white font-medium'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#161b22] hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              <div className="flex items-center gap-2 overflow-hidden flex-1">
                {processingSessionIds?.has(session.id) ? (
                  <Loader2 size={14} className="text-blue-500 animate-spin flex-shrink-0" />
                ) : (
                  <MessageSquare size={14} className={`flex-shrink-0 ${currentSessionId === session.id ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-600'}`} />
                )}
                <span className="truncate">{session.title || 'Untitled Chat'}</span>
              </div>
              <button
                type="button"
                onClick={(e) => onDeleteSession(e, session.id)}
                disabled={readOnly}
                className={`p-1 hover:bg-red-100 dark:hover:bg-red-900/50 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded transition-all ${
                  readOnly
                    ? 'hidden'
                    : isMobile || currentSessionId === session.id
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                }`}
                aria-label={`Delete ${session.title || 'Untitled Chat'}`}
                title="Delete chat"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
      
      <div className="border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[#0d1117] transition-colors">
         <div 
            className="p-4 flex items-center justify-between cursor-pointer hover:bg-gray-100 dark:hover:bg-[#161b22] transition-colors"
            onClick={() => setShowSettings(!showSettings)}
         >
             <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-green-400 to-blue-500"></div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200">OpenAI User</span>
                  <span className="text-xs text-gray-500">Settings</span>
                </div>
             </div>
             {showSettings ? <ChevronDown size={16} className="text-gray-500" /> : <ChevronUp size={16} className="text-gray-500" />}
         </div>

         {showSettings && (
            <div className="max-h-[70vh] overflow-y-auto px-4 pb-4 space-y-4 animate-in slide-in-from-bottom-2 duration-200">
                {/* Theme Toggle */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                        {isDarkMode ? <Moon size={16} /> : <Sun size={16} />}
                        <span>Theme</span>
                    </div>
                    <button 
                        onClick={toggleTheme}
                        disabled={readOnly}
                        className="relative inline-flex h-6 w-11 items-center rounded-full bg-gray-300 dark:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <span 
                            className={`${isDarkMode ? 'translate-x-6' : 'translate-x-1'} inline-block h-4 w-4 transform rounded-full bg-white transition`}
                        />
                    </button>
                </div>

                {/* API Key Input */}
                <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        <Key size={12} />
                        <span>API Key</span>
                    </label>
                    <input 
                        type="password" 
                        value={apiKey}
                        onChange={(e) => onApiKeyChange(e.target.value)}
                        disabled={readOnly}
                        placeholder="sk-..."
                        className="w-full bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 focus:border-blue-500 focus:outline-none placeholder-gray-400 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <div className="text-[10px] text-gray-500 leading-tight">
                        Overrides .env key. Saved locally.
                    </div>
                </div>

                <div className="h-px bg-gray-200 dark:bg-gray-800 my-2" />

                {/* Data Management */}
                <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        <Database size={12} />
                        <span>Data Management</span>
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        <button 
                            onClick={onExportData}
                            className="flex items-center justify-center gap-2 px-3 py-1.5 bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-[#1f2937] text-xs font-medium text-gray-700 dark:text-gray-300 rounded transition-colors"
                        >
                            <Download size={12} />
                            Backup
                        </button>
                        <button
                            onClick={() => mergeFileInputRef.current?.click()}
                            disabled={mergeDisabled}
                            title={mergeDisabled ? 'Merge is unavailable while the workspace or a response is active' : undefined}
                            className="flex items-center justify-center gap-1 px-2 py-1.5 bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-[#1f2937] text-xs font-medium text-gray-700 dark:text-gray-300 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <GitMerge size={12} />
                            Merge
                        </button>
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            disabled={readOnly}
                            className="flex items-center justify-center gap-2 px-3 py-1.5 bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-[#1f2937] text-xs font-medium text-gray-700 dark:text-gray-300 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Upload size={12} />
                            Restore
                        </button>
                        <input 
                            type="file" 
                            accept=".zip,application/zip"
                            ref={fileInputRef} 
                            onChange={handleFileSelect} 
                            disabled={readOnly}
                            className="hidden" 
                        />
                        <input
                            type="file"
                            accept=".zip,application/zip"
                            ref={mergeFileInputRef}
                            onChange={handleMergeFileSelect}
                            disabled={mergeDisabled}
                            className="hidden"
                        />
                    </div>
                    {undoWorkspaceAction && (
                      <button
                        type="button"
                        onClick={onUndoWorkspaceMutation}
                        disabled={readOnly}
                        className="flex w-full items-center justify-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                      >
                        <RefreshCw size={12} />
                        Undo last {undoWorkspaceAction}
                      </button>
                    )}
                    {backupState.supported ? (
                      <div className="space-y-2 rounded-md border border-gray-200 p-2 dark:border-gray-700">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-gray-600 dark:text-gray-300">
                            Automatic daily backups
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={backupState.enabled}
                            onClick={() => onToggleAutomaticBackups(!backupState.enabled)}
                            disabled={readOnly || backupState.running}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                              backupState.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'
                            }`}
                          >
                            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                              backupState.enabled ? 'translate-x-5' : 'translate-x-1'
                            }`} />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={onChooseBackupFolder}
                            disabled={backupState.running}
                            className="flex items-center justify-center gap-1 rounded border border-gray-200 px-2 py-1.5 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                          >
                            <FolderOpen size={11} />
                            {backupState.destinationStatus === 'unavailable' ? 'Choose folder' : 'Change folder'}
                          </button>
                          {backupState.destinationStatus === 'permission-required' ? (
                            <button
                              type="button"
                              onClick={onReconnectBackupFolder}
                              className="flex items-center justify-center gap-1 rounded border border-gray-200 px-2 py-1.5 text-[11px] text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                            >
                              <RefreshCw size={11} />
                              Reconnect
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={onBackUpNow}
                              disabled={readOnly || backupState.running || backupState.destinationStatus !== 'connected'}
                              className="flex items-center justify-center gap-1 rounded border border-gray-200 px-2 py-1.5 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                            >
                              {backupState.running ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />}
                              Back up now
                            </button>
                          )}
                        </div>
                        <div className="text-[10px] leading-4 text-gray-500">
                          {backupState.lastSuccessAt
                            ? `Last successful: ${new Date(backupState.lastSuccessAt).toLocaleString()}`
                            : 'No successful managed backup yet.'}
                          {backupState.nextDueAt
                            ? ` Next due: ${new Date(backupState.nextDueAt).toLocaleString()}.`
                            : ''}
                        </div>
                        {backupState.backups.slice(0, 3).map(backup => (
                          <div
                            key={backup.filename}
                            className="rounded border border-gray-200 p-2 text-[10px] dark:border-gray-700"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-gray-700 dark:text-gray-200">
                                {backup.preview
                                  ? new Date(backup.preview.createdAt).toLocaleString()
                                  : backup.filename}
                              </span>
                              <span className={backup.integrity === 'valid' ? 'text-green-600' : 'text-red-500'}>
                                {backup.integrity}
                              </span>
                            </div>
                            <div className="mt-1 text-gray-500">
                              {(backup.size / (1024 * 1024)).toFixed(1)} MB
                            </div>
                            {backup.integrity === 'valid' && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                <button disabled={readOnly} onClick={() => onRestoreManagedBackup(backup.filename)} className="rounded bg-blue-600 px-2 py-1 text-white disabled:opacity-50">Restore</button>
                                <button onClick={() => onExportManagedBackup(backup.filename)} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600">Export</button>
                                <button disabled={readOnly} onClick={() => onDeleteManagedBackup(backup.filename)} className="rounded border border-red-300 px-2 py-1 text-red-600 disabled:opacity-50 dark:border-red-800">Delete</button>
                              </div>
                            )}
                          </div>
                        ))}
                        {(backupActionError || backupState.error) && (
                          <div className="rounded bg-red-50 p-2 text-[10px] text-red-700 dark:bg-red-950/30 dark:text-red-300">
                            {backupActionError || backupState.error}
                          </div>
                        )}
                        {backupState.warning && (
                          <div className="text-[10px] text-amber-700 dark:text-amber-300">
                            {backupState.warning}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-[10px] leading-4 text-gray-500">
                        Automatic folders are unavailable in this browser. Use Backup, Merge, and Restore.
                      </p>
                    )}
                </div>

                <div className="space-y-1">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        Release Version
                    </label>
                    <div className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#161b22] px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                        v{APP_VERSION}
                    </div>
                </div>
            </div>
         )}
      </div>
    </div>
  );
};
