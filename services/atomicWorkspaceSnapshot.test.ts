import { describe, expect, it, vi } from 'vitest';
import { commitAtomicWorkspaceSnapshot } from './atomicWorkspaceSnapshot';

const files = [
  {
    filename: 'sessions.stage.json',
    text: '["session"]',
    validate: (text: string) => {
      if (!Array.isArray(JSON.parse(text))) throw new Error('invalid sessions');
    }
  },
  {
    filename: 'settings.stage.json',
    text: '{"theme":"dark"}',
    validate: (text: string) => {
      if (JSON.parse(text).theme !== 'dark') throw new Error('invalid settings');
    }
  }
];

describe('commitAtomicWorkspaceSnapshot', () => {
  it('writes and verifies every staged file before switching the manifest', async () => {
    const stored = new Map<string, string>();
    const events: string[] = [];

    await commitAtomicWorkspaceSnapshot({
      files,
      writeText: async (filename, text) => {
        stored.set(filename, text);
        events.push(`write:${filename}`);
      },
      readText: async filename => {
        events.push(`verify:${filename}`);
        return stored.get(filename) || null;
      },
      deleteFile: vi.fn(),
      switchManifest: async () => {
        events.push('switch');
      }
    });

    expect(events.at(-1)).toBe('switch');
    expect(events.filter(event => event.startsWith('verify:'))).toHaveLength(2);
  });

  it('does not switch and removes staged files when a write fails', async () => {
    const switchManifest = vi.fn();
    const deleteFile = vi.fn().mockResolvedValue(undefined);

    await expect(commitAtomicWorkspaceSnapshot({
      files,
      writeText: async filename => {
        if (filename === 'settings.stage.json') throw new Error('disk full');
      },
      readText: async () => null,
      deleteFile,
      switchManifest
    })).rejects.toThrow('disk full');

    expect(switchManifest).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it('does not switch when staged content fails verification', async () => {
    const switchManifest = vi.fn();

    await expect(commitAtomicWorkspaceSnapshot({
      files,
      writeText: async () => undefined,
      readText: async filename => (
        filename === 'sessions.stage.json' ? '{}' : '{"theme":"dark"}'
      ),
      deleteFile: async () => undefined,
      switchManifest
    })).rejects.toThrow('invalid sessions');

    expect(switchManifest).not.toHaveBeenCalled();
  });

  it('cleans staged files when the revision check fails before switching', async () => {
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const switchManifest = vi.fn();

    await expect(commitAtomicWorkspaceSnapshot({
      files,
      writeText: async () => undefined,
      readText: async filename => (
        files.find(file => file.filename === filename)?.text || null
      ),
      deleteFile,
      beforeSwitch: async () => {
        throw new Error('revision conflict');
      },
      switchManifest
    })).rejects.toThrow('revision conflict');

    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(switchManifest).not.toHaveBeenCalled();
  });

  it('retains verified staged files when the atomic switch reports a failure', async () => {
    const deleteFile = vi.fn();

    await expect(commitAtomicWorkspaceSnapshot({
      files,
      writeText: async () => undefined,
      readText: async filename => (
        files.find(file => file.filename === filename)?.text || null
      ),
      deleteFile,
      switchManifest: async () => {
        throw new Error('manifest write failed');
      }
    })).rejects.toThrow('manifest write failed');

    expect(deleteFile).not.toHaveBeenCalled();
  });
});
