import React, { useState, useEffect } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';

interface TitleBarProps {
  isDarkMode: boolean;
}

export function TitleBar({ isDarkMode }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.isMaximized().then(setIsMaximized);
      window.electronAPI.onMaximizedChange(setIsMaximized);
    }
  }, []);

  const handleMinimize = () => window.electronAPI?.minimize();
  const handleMaximize = () => window.electronAPI?.maximize();
  const handleClose = () => window.electronAPI?.close();

  return (
    <div
      className={`titlebar-drag flex items-center justify-between h-8 w-full select-none shrink-0 ${
        isDarkMode ? 'bg-[#0d1117]' : 'bg-gray-100'
      }`}
    >
      {/* Left side - App title */}
      <div className="flex items-center gap-2 px-3">
        <span className={`text-xs font-medium ${
          isDarkMode ? 'text-gray-400' : 'text-gray-600'
        }`}>
          OpenAI Studio
        </span>
      </div>

      {/* Right side - Window controls */}
      <div className="flex h-full">
        {/* Minimize */}
        <button
          onClick={handleMinimize}
          className={`titlebar-no-drag flex items-center justify-center w-11 h-full transition-colors ${
            isDarkMode
              ? 'hover:bg-gray-700/50 text-gray-400 hover:text-gray-200'
              : 'hover:bg-gray-200 text-gray-600 hover:text-gray-800'
          }`}
          aria-label="Minimize"
        >
          <Minus size={14} strokeWidth={1.5} />
        </button>

        {/* Maximize/Restore */}
        <button
          onClick={handleMaximize}
          className={`titlebar-no-drag flex items-center justify-center w-11 h-full transition-colors ${
            isDarkMode
              ? 'hover:bg-gray-700/50 text-gray-400 hover:text-gray-200'
              : 'hover:bg-gray-200 text-gray-600 hover:text-gray-800'
          }`}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <Copy size={12} strokeWidth={1.5} className="rotate-180" />
          ) : (
            <Square size={11} strokeWidth={1.5} />
          )}
        </button>

        {/* Close */}
        <button
          onClick={handleClose}
          className={`titlebar-no-drag flex items-center justify-center w-11 h-full transition-colors ${
            isDarkMode
              ? 'hover:bg-red-600 text-gray-400 hover:text-white'
              : 'hover:bg-red-500 text-gray-600 hover:text-white'
          }`}
          aria-label="Close"
        >
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
