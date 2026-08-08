import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupFileManager } from './backupFiles.js';

const filename =
  'openai-studio-backup-2026-07-29T12-00-00-000Z-backup_id.zip';

describe('Electron managed backup files', () => {
  let root;
  let userData;
  let destination;
  let manager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-studio-backup-test-'));
    userData = path.join(root, 'user-data');
    destination = path.join(root, 'backups');
    await fs.mkdir(userData);
    await fs.mkdir(destination);
    manager = new BackupFileManager();
    await manager.initialize(userData);
    await manager.setDestination(destination);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('streams, fsyncs, verifies, and atomically publishes a managed archive', async () => {
    const bytes = Buffer.from('verified zip bytes');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const id = await manager.startWrite(filename);
    await manager.writeChunk(id, bytes.subarray(0, 7));
    await manager.writeChunk(id, bytes.subarray(7));
    await manager.finishWrite(id, bytes.byteLength, digest);

    expect(await manager.list()).toMatchObject([{
      filename,
      size: bytes.byteLength
    }]);
    expect(Buffer.from(await manager.read(filename)).toString())
      .toBe('verified zip bytes');
    expect((await fs.readdir(destination)).some(name => name.startsWith('.openai-studio-backup-partial-')))
      .toBe(false);
  });

  it('rejects traversal and removes failed partial writes without touching unrelated files', async () => {
    await fs.writeFile(path.join(destination, 'unrelated.txt'), 'keep');
    await fs.writeFile(
      path.join(destination, '.openai-studio-backup-partial-stale'),
      'partial'
    );
    await manager.cleanupStalePartials();
    expect(await fs.readFile(path.join(destination, 'unrelated.txt'), 'utf8'))
      .toBe('keep');

    await expect(manager.startWrite('../outside.zip')).rejects.toThrow(
      'filename is invalid'
    );
    const id = await manager.startWrite(filename);
    await manager.writeChunk(id, Buffer.from('bad'));
    await expect(manager.finishWrite(
      id,
      3,
      '0'.repeat(64)
    )).rejects.toThrow('failed size or SHA-256');
    expect(await fs.readdir(destination)).toEqual(['unrelated.txt']);
  });

  it('can restore destination configuration without blocking on partial cleanup', async () => {
    const partial = '.openai-studio-backup-partial-stale-startup';
    await fs.writeFile(path.join(destination, partial), 'partial');
    const reloaded = new BackupFileManager();

    await reloaded.initialize(userData, { cleanupStalePartials: false });

    expect(reloaded.getStatus()).toBe('connected');
    expect(await fs.readdir(destination)).toContain(partial);

    await reloaded.cleanupStalePartials();
    expect(await fs.readdir(destination)).not.toContain(partial);
  });
});
