import { vi } from 'vitest';
import type { ElectronAPI } from '../electron/bridge';

export const createElectronBridgeMock = (
  overrides: Partial<ElectronAPI> = {}
): ElectronAPI => ({
  minimize: vi.fn(),
  maximize: vi.fn(),
  close: vi.fn(),
  restoreFocusAfterDialog: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  onMaximizedChange: vi.fn(),
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
  onCloseRequested: vi.fn(() => vi.fn()),
  confirmClose: vi.fn(),
  cancelClose: vi.fn(),
  chooseBackupDirectory: vi.fn().mockResolvedValue(false),
  getBackupDestinationStatus: vi.fn().mockResolvedValue('unavailable'),
  writeBackupArchive: vi.fn().mockResolvedValue(undefined),
  listBackupArchives: vi.fn().mockResolvedValue([]),
  readBackupArchive: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  deleteBackupArchive: vi.fn().mockResolvedValue(undefined),
  ...overrides
});
