import { useState, useEffect } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';
import { BrandMark, cx } from './ui';

const CONTROL_CLASS =
  'titlebar-no-drag flex h-full w-11 items-center justify-center text-ink-3 transition-colors';

export function TitleBar() {
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
    <div className="titlebar-drag flex h-9 w-full shrink-0 select-none items-center justify-between border-b border-line bg-canvas">
      <div className="flex items-center gap-2 px-3">
        <BrandMark size={16} />
        <span className="text-xs font-medium text-ink-3">OpenAI Studio</span>
      </div>

      <div className="flex h-full">
        <button
          onClick={handleMinimize}
          className={cx(CONTROL_CLASS, 'hover:bg-surface-3 hover:text-ink')}
          aria-label="Minimize"
        >
          <Minus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={handleMaximize}
          className={cx(CONTROL_CLASS, 'hover:bg-surface-3 hover:text-ink')}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <Copy size={12} strokeWidth={1.5} className="rotate-180" />
          ) : (
            <Square size={11} strokeWidth={1.5} />
          )}
        </button>
        <button
          onClick={handleClose}
          className={cx(CONTROL_CLASS, 'hover:bg-danger hover:text-white')}
          aria-label="Close"
        >
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
