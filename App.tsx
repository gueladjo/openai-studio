
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Sidebar } from './components/Sidebar';
import { ConfigPanel } from './components/ConfigPanel';
import { ChatArea } from './components/ChatArea';
import { TitleBar } from './components/TitleBar';
import { Session, ChatConfig, Message, DEFAULT_CONFIG, SystemInstruction } from './types';
import { generateResponse, generateChatTitle } from './services/openaiService';
import {
  getStorageHandle,
  readJsonFile,
  writeJsonFile,
  getWorkspaceBackup,
  restoreWorkspaceBackup,
  STORAGE_FILES,
  AppSettings,
  WorkspaceBackup
} from './services/storage';
import { Loader2, Menu, Settings, X } from 'lucide-react';

// Hook for detecting mobile viewport
const useIsMobile = (breakpoint = 768) => {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false
  );

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [breakpoint]);

  return isMobile;
};

// Add global declaration for Electron API
declare global {
  interface Window {
    electronAPI?: {
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      isMaximized: () => Promise<boolean>;
      onMaximizedChange: (callback: (isMaximized: boolean) => void) => void;
    }
  }
}

function App() {
  // Storage State
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);

  // App State
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // Replaced single boolean with a Set to track multiple active sessions
  const [processingSessionIds, setProcessingSessionIds] = useState<Set<string>>(new Set());

  const [isDarkMode, setIsDarkMode] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [systemInstructions, setSystemInstructions] = useState<SystemInstruction[]>([]);

  // Mobile responsive state
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);

  // Close mobile panels when switching to desktop
  useEffect(() => {
    if (!isMobile) {
      setIsSidebarOpen(false);
      setIsConfigOpen(false);
    }
  }, [isMobile]);

  // Close sidebar when selecting a session on mobile
  const handleSelectSession = useCallback((id: string) => {
    setCurrentSessionId(id);
    if (isMobile) setIsSidebarOpen(false);
  }, [isMobile]);

  // Refs for debouncing writes
  const saveTimeoutRef = useRef<{ [key: string]: number }>({});

  // Helper: Load all data from disk
  const loadWorkspaceData = async (handle: FileSystemDirectoryHandle) => {
    try {
      // Parallel load
      const [loadedSessions, loadedSettings, loadedInstructions] = await Promise.all([
        readJsonFile<Session[]>(handle, STORAGE_FILES.SESSIONS),
        readJsonFile<AppSettings>(handle, STORAGE_FILES.SETTINGS),
        readJsonFile<SystemInstruction[]>(handle, STORAGE_FILES.INSTRUCTIONS)
      ]);

      if (loadedSessions) setSessions(loadedSessions);
      if (loadedInstructions) setSystemInstructions(loadedInstructions);
      
      if (loadedSettings) {
        setIsDarkMode(loadedSettings.theme === 'dark');
        setApiKey(loadedSettings.apiKey || '');
        if (loadedSettings.lastActiveSessionId) {
          // Verify ID exists
          if (loadedSessions && loadedSessions.find(s => s.id === loadedSettings.lastActiveSessionId)) {
            setCurrentSessionId(loadedSettings.lastActiveSessionId);
          } else if (loadedSessions && loadedSessions.length > 0) {
            setCurrentSessionId(loadedSessions[0].id);
          }
        }
      }
    } catch (e) {
      console.error("Failed to load workspace data", e);
    }
  };

  // 1. Initial Mount: Automatically access storage
  useEffect(() => {
    const init = async () => {
      try {
        const handle = await getStorageHandle();
        setDirHandle(handle);
        await loadWorkspaceData(handle);
      } catch (e) {
        console.error("Critical: Failed to initialize storage", e);
      } finally {
        // Add a small artificial delay to ensure smooth transition from the HTML loader
        // if the OPFS loads extremely fast.
        setTimeout(() => setIsInitializing(false), 300);
      }
    };
    init();
  }, []);

  // Debounced Save Helper
  const scheduleSave = (key: string, fn: () => Promise<void>) => {
    if (!dirHandle) return;
    
    if (saveTimeoutRef.current[key]) {
      clearTimeout(saveTimeoutRef.current[key]);
    }

    // Save delay: 1s for sessions (chatting), 500ms for settings
    const delay = key === 'sessions' ? 1000 : 500;
    
    saveTimeoutRef.current[key] = window.setTimeout(async () => {
      await fn();
      delete saveTimeoutRef.current[key];
    }, delay);
  };

  // Effect: Persist Sessions
  useEffect(() => {
    scheduleSave('sessions', async () => {
      if (dirHandle) await writeJsonFile(dirHandle, STORAGE_FILES.SESSIONS, sessions);
    });
  }, [sessions, dirHandle]);

  // Effect: Persist Instructions
  useEffect(() => {
    scheduleSave('instructions', async () => {
      if (dirHandle) await writeJsonFile(dirHandle, STORAGE_FILES.INSTRUCTIONS, systemInstructions);
    });
  }, [systemInstructions, dirHandle]);

  // Effect: Persist Settings (Theme, API Key, Active Session)
  useEffect(() => {
    scheduleSave('settings', async () => {
      if (dirHandle) {
        const settings: AppSettings = {
          theme: isDarkMode ? 'dark' : 'light',
          apiKey,
          lastActiveSessionId: currentSessionId || undefined
        };
        await writeJsonFile(dirHandle, STORAGE_FILES.SETTINGS, settings);
      }
    });
  }, [isDarkMode, apiKey, currentSessionId, dirHandle]);


  // --- App Logic ---

  const currentSession = sessions.find(s => s.id === currentSessionId) || null;

  const createNewSession = () => {
    const configToUse = currentSession ? { ...currentSession.config } : { ...DEFAULT_CONFIG };
    
    const newSession: Session = {
      id: uuidv4(),
      title: 'New Chat',
      messages: [],
      config: configToUse,
      lastModified: Date.now(),
    };
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
  };

  const deleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const newSessions = sessions.filter(s => s.id !== id);
    setSessions(newSessions);
    if (currentSessionId === id) {
      setCurrentSessionId(newSessions.length > 0 ? newSessions[0].id : null);
    }
  };

  const updateConfig = (newConfig: ChatConfig) => {
    if (!currentSessionId) return;
    setSessions(prev => prev.map(s => 
      s.id === currentSessionId ? { ...s, config: newConfig } : s
    ));
  };

  const handleCreateSystemInstruction = () => {
     const newId = uuidv4();
     const newInstruction: SystemInstruction = {
         id: newId,
         title: 'Untitled instruction',
         content: ''
     };
     setSystemInstructions(prev => [...prev, newInstruction]);
     if (currentSessionId) {
         updateConfig({ ...currentSession!.config, systemInstructionId: newId });
     }
  };

  const handleUpdateSystemInstruction = (updated: SystemInstruction) => {
      setSystemInstructions(prev => prev.map(si => si.id === updated.id ? updated : si));
  };

  const handleDeleteSystemInstruction = (id: string) => {
      setSystemInstructions(prev => prev.filter(si => si.id !== id));
      if (currentSession && currentSession.config.systemInstructionId === id) {
          updateConfig({ ...currentSession.config, systemInstructionId: undefined });
      }
  };

  const handleSendMessage = async (content: string, attachments: File[]) => {
    if (!currentSessionId) return;

    // Capture the session ID to allow context switching while processing
    const targetSessionId = currentSessionId;

    const processedAttachments = await Promise.all(attachments.map(async (file) => {
        let fileContent: string | undefined = undefined;
        
        // Convert images to Base64 for API usage
        if (file.type.startsWith('image/')) {
            try {
                fileContent = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        if (typeof reader.result === 'string') resolve(reader.result);
                        else reject(new Error('Failed to read file'));
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
            } catch (e) {
                console.error("Failed to read image file", e);
            }
        }

        return {
            name: file.name,
            type: file.type,
            content: fileContent
        };
    }));

    const newUserMessage: Message = {
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: processedAttachments
    };

    const session = sessions.find(s => s.id === targetSessionId);
    
    // Trigger background title generation for new sessions
    if (session && session.messages.length === 0) {
      // Use the content or a placeholder if only attachments exist
      const titlePrompt = content || (attachments.length > 0 ? `File analysis of ${attachments[0].name}` : "New Chat");
      generateChatTitle(titlePrompt, apiKey).then(newTitle => {
        setSessions(prev => prev.map(s => 
          s.id === targetSessionId ? { ...s, title: newTitle } : s
        ));
      });
    }

    // 1. Optimistically update UI with user message
    setSessions(prev => prev.map(s => {
      if (s.id === targetSessionId) {
        return {
          ...s,
          messages: [...s.messages, newUserMessage],
          lastModified: Date.now(),
          title: s.messages.length === 0 ? (content.slice(0, 30) + (content.length > 30 ? '...' : '')) : s.title
        };
      }
      return s;
    }));

    // 2. Mark this session as processing
    setProcessingSessionIds(prev => new Set(prev).add(targetSessionId));

    // 3. Perform API Call Detached from current UI State
    try {
      if (!session) throw new Error("Session lost");
      
      const messagesForApi = [...session.messages, newUserMessage];
      const selectedInstruction = systemInstructions.find(si => si.id === session.config.systemInstructionId);
      const systemInstructionContent = selectedInstruction ? selectedInstruction.content : undefined;

      const { content: responseText, thinking, sources, thinkingDuration } = await generateResponse(messagesForApi, session.config, apiKey, systemInstructionContent);

      const newBotMessage: Message = {
        role: 'assistant',
        content: responseText,
        thinking,
        thinkingDuration,
        sources,
        timestamp: Date.now(),
        model: session.config.model,
        reasoningEffort: session.config.reasoningEffort
      };

      setSessions(prev => prev.map(s => {
        if (s.id === targetSessionId) {
          return {
            ...s,
            messages: [...s.messages, newBotMessage],
            lastModified: Date.now()
          };
        }
        return s;
      }));

    } catch (error) {
      const errorMessage: Message = {
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        timestamp: Date.now()
      };
       setSessions(prev => prev.map(s => {
        if (s.id === targetSessionId) {
          return {
            ...s,
            messages: [...s.messages, errorMessage],
            lastModified: Date.now()
          };
        }
        return s;
      }));
    } finally {
      // 4. Remove session from processing set
      setProcessingSessionIds(prev => {
        const next = new Set(prev);
        next.delete(targetSessionId);
        return next;
      });
    }
  };

  // Data Import/Export Handlers
  const handleExportData = async () => {
    if (!dirHandle) return;
    try {
      const backup = await getWorkspaceBackup(dirHandle);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `openai-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export failed", e);
      alert("Failed to export workspace data.");
    }
  };

  const handleImportData = async (file: File) => {
    if (!dirHandle) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text) as WorkspaceBackup;
      
      // Basic validation
      if (!Array.isArray(backup.sessions)) throw new Error("Invalid backup format");
      
      // Confirm replacement
      if (!window.confirm("This will overwrite your current workspace with the backup data. Continue?")) return;

      await restoreWorkspaceBackup(dirHandle, backup);
      await loadWorkspaceData(dirHandle);
      alert("Workspace restored successfully.");
    } catch (e) {
      console.error("Import failed", e);
      alert("Failed to import data. The file might be corrupted or invalid.");
    }
  };

  // Determine if the CURRENT session is loading
  const isCurrentSessionProcessing = currentSessionId ? processingSessionIds.has(currentSessionId) : false;

  if (isInitializing) {
    return (
      <div className={`flex h-screen w-full items-center justify-center transition-colors duration-200 ${isDarkMode ? 'dark bg-[#0d1117]' : 'bg-white'}`}>
         <div className="flex flex-col items-center gap-4">
             <Loader2 size={40} className="animate-spin text-blue-600 dark:text-blue-500" />
             <div className="text-sm text-gray-500 dark:text-gray-400 font-medium">Loading Workspace...</div>
         </div>
      </div>
    );
  }

  return (
    <div className={isDarkMode ? 'dark' : ''}>
      <div className="flex flex-col h-screen w-full bg-white dark:bg-[#0d1117] text-gray-900 dark:text-gray-200 font-sans overflow-hidden transition-colors duration-200">
        {/* Custom Title Bar - Desktop only */}
        {!isMobile && <TitleBar isDarkMode={isDarkMode} />}

        {/* Mobile Header */}
        {isMobile && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[#0d1117] safe-area-top">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 -ml-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label="Open menu"
            >
              <Menu size={24} />
            </button>
            <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate max-w-[200px]">
              {currentSession?.title || 'OpenAI Studio'}
            </h1>
            <button
              onClick={() => setIsConfigOpen(true)}
              className="p-2 -mr-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label="Open settings"
              disabled={!currentSession}
            >
              <Settings size={24} className={!currentSession ? 'opacity-40' : ''} />
            </button>
          </div>
        )}

        {/* Main App Content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar - Desktop: always visible, Mobile: slide-out drawer */}
          {!isMobile ? (
            <Sidebar
              sessions={sessions}
              currentSessionId={currentSessionId}
              onSelectSession={setCurrentSessionId}
              onNewSession={createNewSession}
              onDeleteSession={deleteSession}
              isDarkMode={isDarkMode}
              toggleTheme={() => setIsDarkMode(!isDarkMode)}
              apiKey={apiKey}
              onApiKeyChange={setApiKey}
              onExportData={handleExportData}
              onImportData={handleImportData}
              processingSessionIds={processingSessionIds}
            />
          ) : (
            <>
              {/* Mobile Sidebar Overlay */}
              {isSidebarOpen && (
                <div
                  className="fixed inset-0 bg-black/50 z-40 animate-in fade-in duration-200"
                  onClick={() => setIsSidebarOpen(false)}
                />
              )}
              {/* Mobile Sidebar Drawer */}
              <div
                className={`fixed inset-y-0 left-0 z-50 w-80 max-w-[85vw] transform transition-transform duration-300 ease-out ${
                  isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
                }`}
              >
                <div className="h-full flex flex-col bg-gray-50 dark:bg-[#0d1117] safe-area-left">
                  <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
                    <span className="font-semibold text-gray-800 dark:text-gray-200">Chats</span>
                    <button
                      onClick={() => setIsSidebarOpen(false)}
                      className="p-2 -mr-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <X size={20} />
                    </button>
                  </div>
                  <Sidebar
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    onSelectSession={handleSelectSession}
                    onNewSession={() => { createNewSession(); setIsSidebarOpen(false); }}
                    onDeleteSession={deleteSession}
                    isDarkMode={isDarkMode}
                    toggleTheme={() => setIsDarkMode(!isDarkMode)}
                    apiKey={apiKey}
                    onApiKeyChange={setApiKey}
                    onExportData={handleExportData}
                    onImportData={handleImportData}
                    processingSessionIds={processingSessionIds}
                    isMobile={true}
                  />
                </div>
              </div>
            </>
          )}

          <main className="flex-1 flex min-w-0">
            <ChatArea
              session={currentSession}
              onSendMessage={handleSendMessage}
              isLoading={isCurrentSessionProcessing}
              isMobile={isMobile}
            />

            {/* ConfigPanel - Desktop: always visible when session selected, Mobile: modal */}
            {!isMobile && currentSession && (
              <ConfigPanel
                config={currentSession.config}
                onChange={updateConfig}
                systemInstructions={systemInstructions}
                onCreateSystemInstruction={handleCreateSystemInstruction}
                onUpdateSystemInstruction={handleUpdateSystemInstruction}
                onDeleteSystemInstruction={handleDeleteSystemInstruction}
              />
            )}
          </main>
        </div>

        {/* Mobile Config Modal */}
        {isMobile && isConfigOpen && currentSession && (
          <>
            <div
              className="fixed inset-0 bg-black/50 z-40 animate-in fade-in duration-200"
              onClick={() => setIsConfigOpen(false)}
            />
            <div className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] bg-gray-50 dark:bg-[#0d1117] rounded-t-2xl animate-in slide-in-from-bottom duration-300 safe-area-bottom overflow-hidden flex flex-col">
              <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
                <span className="font-semibold text-gray-800 dark:text-gray-200">Configuration</span>
                <button
                  onClick={() => setIsConfigOpen(false)}
                  className="p-2 -mr-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <ConfigPanel
                  config={currentSession.config}
                  onChange={updateConfig}
                  systemInstructions={systemInstructions}
                  onCreateSystemInstruction={handleCreateSystemInstruction}
                  onUpdateSystemInstruction={handleUpdateSystemInstruction}
                  onDeleteSystemInstruction={handleDeleteSystemInstruction}
                  isMobile={true}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
