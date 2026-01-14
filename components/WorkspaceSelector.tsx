import React from 'react';
import { FolderOpen, HardDrive, AlertCircle } from 'lucide-react';

interface WorkspaceSelectorProps {
  existingHandle: FileSystemDirectoryHandle | null;
  onConnect: () => void;
  onSelectNew: () => void;
  isLoading: boolean;
}

export const WorkspaceSelector: React.FC<WorkspaceSelectorProps> = ({ 
  existingHandle, 
  onConnect, 
  onSelectNew,
  isLoading
}) => {
  return (
    <div className="flex h-screen w-full bg-gray-50 dark:bg-[#0d1117] items-center justify-center p-4 transition-colors">
      <div className="max-w-md w-full bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-800 rounded-2xl shadow-xl p-8 text-center space-y-6">
        <div className="mx-auto w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center text-blue-600 dark:text-blue-400">
          <HardDrive size={32} />
        </div>
        
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Select Workspace</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
            OpenAI Studio saves all your chats and settings directly to a folder on your computer. 
            Select a folder to load your data or start fresh.
          </p>
        </div>

        <div className="space-y-3 pt-2">
          {existingHandle && (
            <button
              onClick={onConnect}
              disabled={isLoading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-500/20 disabled:opacity-70"
            >
              <FolderOpen size={18} />
              <span>Resume "{existingHandle.name}"</span>
            </button>
          )}

          <button
            onClick={onSelectNew}
            disabled={isLoading}
            className={`w-full bg-white dark:bg-[#1f2937] hover:bg-gray-50 dark:hover:bg-[#2d3748] text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all ${!existingHandle ? 'shadow-sm' : ''}`}
          >
            {existingHandle ? 'Switch Folder' : 'Select Folder'}
          </button>
        </div>

        <div className="flex items-start gap-2 text-xs text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-[#0d1117]/50 p-3 rounded-lg text-left">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <p>
            Your data is stored locally in <span className="font-mono">sessions.json</span> and <span className="font-mono">settings.json</span>. 
            You can move this folder to another computer to transfer your history.
          </p>
        </div>
      </div>
    </div>
  );
};