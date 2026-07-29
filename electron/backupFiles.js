import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';

export const MANAGED_BACKUP_PATTERN =
  /^openai-studio-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9_-]{8,128}\.zip$/;
const PARTIAL_PREFIX = '.openai-studio-backup-partial-';
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

const assertManagedFilename = (filename) => {
  if (typeof filename !== 'string' || !MANAGED_BACKUP_PATTERN.test(filename)) {
    throw new Error('Managed backup filename is invalid.');
  }
};

const assertSha256 = (digest) => {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('Expected backup SHA-256 is invalid.');
  }
};

const serializeError = (error) => (
  error instanceof Error ? error.message : String(error)
);

const hashFile = async (filename) => {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
    size += chunk.byteLength;
    if (size > MAX_ARCHIVE_BYTES) {
      throw new Error('Backup exceeds the archive size limit.');
    }
  }
  return { size, sha256: hash.digest('hex') };
};

export class BackupFileManager {
  constructor() {
    this.configurationPath = null;
    this.destinationPath = null;
    this.writes = new Map();
  }

  async initialize(userDataPath) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
      throw new Error('Electron user-data path is invalid.');
    }
    this.configurationPath = path.join(
      userDataPath,
      'backup-destination.json'
    );
    try {
      const value = JSON.parse(await fs.readFile(this.configurationPath, 'utf8'));
      if (typeof value.path === 'string' && path.isAbsolute(value.path)) {
        this.destinationPath = value.path;
        await this.cleanupStalePartials();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }

  getStatus() {
    return this.destinationPath ? 'connected' : 'unavailable';
  }

  async setDestination(destinationPath) {
    if (
      !this.configurationPath ||
      typeof destinationPath !== 'string' ||
      !path.isAbsolute(destinationPath)
    ) {
      throw new Error('Backup destination path is invalid.');
    }
    const stat = await fs.stat(destinationPath);
    if (!stat.isDirectory()) throw new Error('Backup destination is not a directory.');
    this.destinationPath = destinationPath;
    const temporaryConfiguration = `${this.configurationPath}.tmp`;
    await fs.writeFile(
      temporaryConfiguration,
      JSON.stringify({ path: destinationPath }),
      { encoding: 'utf8', mode: 0o600 }
    );
    await fs.rename(temporaryConfiguration, this.configurationPath);
    await this.cleanupStalePartials();
  }

  async startWrite(filename) {
    assertManagedFilename(filename);
    const destination = this.requireDestination();
    const id = randomUUID();
    const partialPath = path.join(destination, `${PARTIAL_PREFIX}${id}`);
    const handle = await fs.open(partialPath, 'wx', 0o600);
    this.writes.set(id, {
      filename,
      partialPath,
      handle,
      size: 0,
      hash: createHash('sha256')
    });
    return id;
  }

  async writeChunk(id, chunkValue) {
    const write = this.writes.get(id);
    if (!write) throw new Error('Backup write session is invalid.');
    const chunk = Buffer.from(chunkValue);
    if (chunk.byteLength === 0) return;
    if (write.size + chunk.byteLength > MAX_ARCHIVE_BYTES) {
      await this.abortWrite(id);
      throw new Error('Backup exceeds the archive size limit.');
    }
    await write.handle.write(chunk);
    write.hash.update(chunk);
    write.size += chunk.byteLength;
  }

  async finishWrite(id, expectedSize, expectedSha256) {
    const write = this.writes.get(id);
    if (!write) throw new Error('Backup write session is invalid.');
    assertSha256(expectedSha256);
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > MAX_ARCHIVE_BYTES
    ) {
      await this.abortWrite(id);
      throw new Error('Expected backup size is invalid.');
    }
    this.writes.delete(id);
    try {
      await write.handle.sync();
      await write.handle.close();
      if (
        write.size !== expectedSize ||
        write.hash.digest('hex') !== expectedSha256
      ) {
        throw new Error('Streamed backup failed size or SHA-256 verification.');
      }
      const destination = this.requireDestination();
      const finalPath = path.join(destination, write.filename);
      await fs.rename(write.partialPath, finalPath);
      const stored = await hashFile(finalPath);
      if (
        stored.size !== expectedSize ||
        stored.sha256 !== expectedSha256
      ) {
        throw new Error('Final backup failed read-back verification.');
      }
    } catch (error) {
      try {
        await write.handle.close();
      } catch {
        // It may already be closed.
      }
      try {
        await fs.unlink(write.partialPath);
      } catch {
        // A renamed partial no longer exists.
      }
      throw error;
    }
  }

  async abortWrite(id) {
    const write = this.writes.get(id);
    if (!write) return;
    this.writes.delete(id);
    try {
      await write.handle.close();
    } finally {
      try {
        await fs.unlink(write.partialPath);
      } catch {
        // Best-effort removal after an interrupted renderer.
      }
    }
  }

  async list() {
    const destination = this.requireDestination();
    const entries = await fs.readdir(destination, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !MANAGED_BACKUP_PATTERN.test(entry.name)) continue;
      const stat = await fs.stat(path.join(destination, entry.name));
      files.push({
        filename: entry.name,
        size: stat.size,
        lastModified: stat.mtimeMs
      });
    }
    return files.sort((left, right) => right.lastModified - left.lastModified);
  }

  async read(filename) {
    assertManagedFilename(filename);
    const data = await fs.readFile(path.join(this.requireDestination(), filename));
    if (data.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error('Backup exceeds the archive size limit.');
    }
    return data;
  }

  async delete(filename) {
    assertManagedFilename(filename);
    await fs.unlink(path.join(this.requireDestination(), filename));
  }

  async cleanupStalePartials() {
    if (!this.destinationPath) return;
    const entries = await fs.readdir(this.destinationPath, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.startsWith(PARTIAL_PREFIX))
      .map(async entry => {
        try {
          await fs.unlink(path.join(this.destinationPath, entry.name));
        } catch (error) {
          console.warn(
            `Failed to remove stale backup partial ${entry.name}: ${serializeError(error)}`
          );
        }
      }));
  }

  requireDestination() {
    if (!this.destinationPath) throw new Error('No backup destination is configured.');
    return this.destinationPath;
  }
}
