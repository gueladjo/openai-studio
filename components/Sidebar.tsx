import React, { useState, useRef } from 'react';
import { Session } from '../types';
import { Plus, MessageSquare, Trash2, Search, Sun, Moon, Key, ChevronUp, ChevronDown, Download, Upload, Database, Loader2 } from 'lucide-react';

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
  processingSessionIds?: Set<string>;
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
  processingSessionIds
}) => {
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onImportData(e.target.files[0]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const filteredSessions = sessions
    .filter(session => (session.title || 'Untitled Chat').toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => b.lastModified - a.lastModified);

  return (
    <div className="w-64 bg-gray-50 dark:bg-[#0d1117] border-r border-gray-200 dark:border-gray-800 flex flex-col h-full flex-shrink-0 transition-colors duration-200">
      {/* Top section */}
      <div className="p-4">
        <button
          onClick={onNewSession}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 px-4 flex items-center justify-center gap-2 transition-colors font-medium text-sm shadow-sm"
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
                onClick={(e) => onDeleteSession(e, session.id)}
                className={`opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 dark:hover:bg-red-900/50 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded transition-all ${
                  currentSessionId === session.id ? 'opacity-100' : ''
                }`}
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
            <div className="px-4 pb-4 space-y-4 animate-in slide-in-from-bottom-2 duration-200">
                {/* Theme Toggle */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                        {isDarkMode ? <Moon size={16} /> : <Sun size={16} />}
                        <span>Theme</span>
                    </div>
                    <button 
                        onClick={toggleTheme}
                        className="relative inline-flex h-6 w-11 items-center rounded-full bg-gray-300 dark:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
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
                        placeholder="sk-..."
                        className="w-full bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 focus:border-blue-500 focus:outline-none placeholder-gray-400"
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
                    <div className="grid grid-cols-2 gap-2">
                        <button 
                            onClick={onExportData}
                            className="flex items-center justify-center gap-2 px-3 py-1.5 bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-[#1f2937] text-xs font-medium text-gray-700 dark:text-gray-300 rounded transition-colors"
                        >
                            <Download size={12} />
                            Export
                        </button>
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            className="flex items-center justify-center gap-2 px-3 py-1.5 bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-[#1f2937] text-xs font-medium text-gray-700 dark:text-gray-300 rounded transition-colors"
                        >
                            <Upload size={12} />
                            Import
                        </button>
                        <input 
                            type="file" 
                            accept=".json" 
                            ref={fileInputRef} 
                            onChange={handleFileSelect} 
                            className="hidden" 
                        />
                    </div>
                </div>
            </div>
         )}
      </div>
    </div>
  );
};