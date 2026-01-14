import { Session, SystemInstruction } from '../types';

export interface AppSettings {
  theme: 'dark' | 'light';
  apiKey: string;
  lastActiveSessionId?: string;
}

export const STORAGE_FILES = {
  SESSIONS: 'sessions.json',
  SETTINGS: 'settings.json',
  INSTRUCTIONS: 'system_instructions.json'
};

// Access the Origin Private File System (OPFS)
// This creates a sandboxed 'data' folder automatically without user prompts.
export const getStorageHandle = async (): Promise<FileSystemDirectoryHandle> => {
  try {
    // Get the root of the OPFS
    const root = await navigator.storage.getDirectory();
    // Create or retrieve the 'data' directory
    const dataDir = await root.getDirectoryHandle('data', { create: true });
    return dataDir;
  } catch (e) {
    console.error("Failed to access OPFS", e);
    throw e;
  }
};

// File Operations
export const writeJsonFile = async (dirHandle: FileSystemDirectoryHandle, filename: string, data: any) => {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    // createWritable is standard on FileSystemFileHandle in modern browsers supporting OPFS
    const writable = await (fileHandle as any).createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  } catch (e) {
    console.error(`Failed to write ${filename}`, e);
  }
};

export const readJsonFile = async <T>(dirHandle: FileSystemDirectoryHandle, filename: string): Promise<T | null> => {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text) as T;
  } catch (e) {
    // If file doesn't exist yet, return null so the app can use defaults
    return null;
  }
};

// Data Management
export interface WorkspaceBackup {
  sessions: Session[];
  settings: AppSettings | null;
  instructions: SystemInstruction[];
  timestamp: number;
}

export const getWorkspaceBackup = async (dirHandle: FileSystemDirectoryHandle): Promise<WorkspaceBackup> => {
  const sessions = await readJsonFile<Session[]>(dirHandle, STORAGE_FILES.SESSIONS) || [];
  const settings = await readJsonFile<AppSettings>(dirHandle, STORAGE_FILES.SETTINGS);
  const instructions = await readJsonFile<SystemInstruction[]>(dirHandle, STORAGE_FILES.INSTRUCTIONS) || [];
  
  return {
    sessions,
    settings,
    instructions,
    timestamp: Date.now()
  };
};

export const restoreWorkspaceBackup = async (dirHandle: FileSystemDirectoryHandle, backup: WorkspaceBackup): Promise<void> => {
  if (backup.sessions) await writeJsonFile(dirHandle, STORAGE_FILES.SESSIONS, backup.sessions);
  if (backup.settings) await writeJsonFile(dirHandle, STORAGE_FILES.SETTINGS, backup.settings);
  if (backup.instructions) await writeJsonFile(dirHandle, STORAGE_FILES.INSTRUCTIONS, backup.instructions);
};