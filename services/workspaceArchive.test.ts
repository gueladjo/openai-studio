import { describe, expect, it } from 'vitest';
import {
  BlobWriter,
  TextReader,
  ZipWriter
} from '@zip.js/zip.js';
import {
  DEFAULT_CONFIG,
  type FileAttachment,
  type Project,
  type Session
} from '../types';
import { encodeUtf8, sha256Blob, sha256Text } from './contentAddressing';
import {
  BackupArchiveError,
  createWorkspaceArchive,
  inspectWorkspaceArchive,
  selectWorkspaceArchiveBlobEntries,
  UnsupportedLegacyBackupError
} from './workspaceArchive';
import type { WorkspaceSnapshot } from './storage';

const attachmentBlob = new Blob(['verified attachment'], {
  type: 'text/plain'
});
const attachmentHash = await sha256Blob(attachmentBlob);
const generatedBlob = new Blob(['cached generated output'], {
  type: 'text/plain'
});
const generatedHash = await sha256Blob(generatedBlob);
const projectBlob = new Blob(['project knowledge'], { type: 'text/plain' });
const projectHash = await sha256Blob(projectBlob);

const sessions: Session[] = [{
  id: 'session-1',
  title: 'Archive test',
  config: {
    ...DEFAULT_CONFIG,
    tools: {
      ...DEFAULT_CONFIG.tools,
      webSearchOptions: {
        searchContextSize: 'high',
        userLocation: {
          type: 'approximate',
          city: 'London',
          region: 'England',
          country: 'GB'
        }
      }
    }
  },
  lastModified: 10,
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'Use the attached notes.',
      timestamp: 10,
      attachments: [{
        name: 'notes.txt',
        type: 'text/plain',
        size: attachmentBlob.size,
        localBlob: {
          sha256: attachmentHash,
          byteSize: attachmentBlob.size,
          mimeType: 'text/plain'
        }
      }]
    },
    {
      id: 'message-2',
      role: 'assistant',
      content: 'Done.',
      outputMessages: [{
        content: 'Reading the notes.',
        phase: 'commentary'
      }, {
        content: 'Done.',
        phase: 'final_answer'
      }],
      timestamp: 11,
      modelName: 'GPT-5.6 Sol',
      generatedFiles: [{
        filename: 'remote-only.txt',
        fileId: 'file-1',
        containerId: 'container-1'
      }, {
        filename: 'cached.txt',
        fileId: 'file-2',
        containerId: 'container-1',
        mimeType: 'text/plain',
        localBlob: {
          sha256: generatedHash,
          byteSize: generatedBlob.size,
          mimeType: 'text/plain'
        }
      }]
    }
  ]
}];

const snapshot: WorkspaceSnapshot = {
  revision: 7,
  createdAt: 10,
  sessions,
  settings: {
    theme: 'dark',
    apiKey: 'must-not-leave-device',
    lastActiveSessionId: 'session-1'
  },
  instructions: [{
    id: 'instruction-1',
    title: 'Concise',
    content: 'Be concise.'
  }],
  readBlob: async reference => {
    if (reference.sha256 === attachmentHash) return attachmentBlob;
    if (reference.sha256 === generatedHash) return generatedBlob;
    throw new Error('Unexpected blob.');
  }
};

const appendAttachment = (
  attachment: FileAttachment
): WorkspaceSnapshot => ({
  ...snapshot,
  sessions: snapshot.sessions.map((session, sessionIndex) => (
    sessionIndex === 0
      ? {
          ...session,
          messages: session.messages.map((message, messageIndex) => (
            messageIndex === 0
              ? {
                  ...message,
                  attachments: [...(message.attachments || []), attachment]
                }
              : message
          ))
        }
      : session
  ))
});

const createZip = async (
  entries: Array<{ path: string; text: string }>
): Promise<Blob> => {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const entry of entries) {
    await writer.add(entry.path, new TextReader(entry.text));
  }
  return writer.close();
};

const emptyManifest = (entries: Array<{
  path: string;
  text: string;
  sha256?: string;
}>) => ({
  format: 'openai-studio-backup',
  version: 2,
  backupId: 'backup-test',
  reason: 'manual',
  appVersion: '0.5.0',
  createdAt: 1,
  workspaceRevision: 1,
  counts: {
    sessions: 0,
    messages: 0,
    attachments: 0,
    generatedFiles: 0,
    cachedGeneratedFiles: 0
  },
  uncachedGeneratedFileCount: 0,
  entries: entries.map(entry => ({
    path: entry.path,
    byteLength: encodeUtf8(entry.text).byteLength,
    sha256: entry.sha256 || sha256Text(entry.text)
  }))
});

describe('portable workspace archive', () => {
  it('round-trips verified JSON and binary bytes without exporting the API key', async () => {
    const archive = await createWorkspaceArchive(snapshot, { reason: 'manual' });
    const inspected = await inspectWorkspaceArchive(archive);

    expect(inspected.preview).toMatchObject({
      workspaceRevision: 7,
      counts: {
        sessions: 1,
        messages: 2,
        attachments: 1,
        generatedFiles: 2,
        cachedGeneratedFiles: 1
      },
      uncachedGeneratedFileCount: 1
    });
    expect(inspected.replacement.settings).toEqual({
      theme: 'dark',
      lastActiveSessionId: 'session-1'
    });
    expect(inspected.replacement.sessions[0].config.tools.webSearchOptions)
      .toEqual({
        searchContextSize: 'high',
        userLocation: {
          type: 'approximate',
          city: 'London',
          region: 'England',
          country: 'GB'
        }
      });
    expect(inspected.replacement.sessions[0].messages[1].outputMessages).toEqual([
      { content: 'Reading the notes.', phase: 'commentary' },
      { content: 'Done.', phase: 'final_answer' }
    ]);
    expect(inspected.replacement.blobs.get(attachmentHash)).toBeDefined();
    expect(await inspected.replacement.blobs.get(attachmentHash)!.text())
      .toBe('verified attachment');
    expect(await inspected.replacement.blobs.get(generatedHash)!.text())
      .toBe('cached generated output');
    expect(await archive.text()).not.toContain('must-not-leave-device');
  });

  it('round-trips portable projects and excludes the remote source registry', async () => {
    const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
    const projects: Project[] = [{
      id: 'project-archive',
      name: 'Archive project',
      icon: 'book',
      instructions: 'Use the saved source.',
      defaultConfig,
      sources: [{
        id: 'source-archive',
        name: 'knowledge.txt',
        mimeType: 'text/plain',
        byteSize: projectBlob.size,
        localBlob: {
          sha256: projectHash,
          byteSize: projectBlob.size,
          mimeType: 'text/plain'
        },
        capability: 'file_search',
        addedAt: 2
      }],
      createdAt: 1,
      updatedAt: 2
    }];
    const projectSnapshot: WorkspaceSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map(session => ({
        ...session,
        projectId: projects[0].id
      })),
      projects,
      projectRemoteState: {
        indexes: {
          [projects[0].id]: {
            projectId: projects[0].id,
            apiKeyFingerprint: 'c'.repeat(64),
            vectorStoreId: 'vs-must-not-export',
            status: 'ready',
            usageBytes: 100,
            files: {
              [projects[0].sources[0].id]: {
                projectSourceId: projects[0].sources[0].id,
                openaiFileId: 'file-must-not-export',
                status: 'ready'
              }
            }
          }
        },
        cleanupTombstones: []
      },
      readBlob: async reference => {
        if (reference.sha256 === projectHash) return projectBlob;
        return snapshot.readBlob(reference);
      }
    };

    const inspected = await inspectWorkspaceArchive(
      await createWorkspaceArchive(projectSnapshot, { reason: 'manual' })
    );

    expect(inspected.manifest.version).toBe(3);
    expect(inspected.preview.counts).toMatchObject({
      projects: 1,
      projectSources: 1
    });
    expect(inspected.replacement.projects).toEqual(projects);
    expect(inspected.replacement.sessions[0].projectId).toBe(projects[0].id);
    expect(await inspected.replacement.blobs.get(projectHash)?.text())
      .toBe('project knowledge');
    expect(inspected.replacement.projectRemoteState).toBeUndefined();
    expect(inspected.manifest.entries.map(entry => entry.path))
      .not.toContain('workspace/project_remote_state.json');
  });

  it('round-trips metadata-only attachments without inventing blob entries', async () => {
    const metadataOnlyAttachment: FileAttachment = {
      name: 'dx12user.settings',
      type: 'application/octet-stream',
      size: 19
    };
    const archive = await createWorkspaceArchive(
      appendAttachment(metadataOnlyAttachment),
      { reason: 'manual' }
    );
    const inspected = await inspectWorkspaceArchive(archive);

    expect(inspected.preview.counts.attachments).toBe(2);
    expect(
      inspected.replacement.sessions[0].messages[0].attachments?.[1]
    ).toEqual(metadataOnlyAttachment);
    expect(inspected.replacement.blobs.size).toBe(2);
  });

  it('rejects attachment-local IDs and inline content from portable archives', async () => {
    const nonPortableAttachments: FileAttachment[] = [{
      id: 'legacy-attachment',
      name: 'legacy.txt',
      type: 'text/plain',
      size: 1
    }, {
      name: 'embedded.txt',
      type: 'text/plain',
      size: 1,
      content: 'data:text/plain;base64,eA=='
    }];

    for (const attachment of nonPortableAttachments) {
      const archive = await createWorkspaceArchive(
        appendAttachment(attachment),
        { reason: 'manual' }
      );
      await expect(inspectWorkspaceArchive(archive)).rejects.toThrow(
        `Attachment "${attachment.name}" contains non-portable local data.`
      );
    }
  });

  it('supports pre-merge recovery archives and filters staged blob entries', async () => {
    const archive = await createWorkspaceArchive(snapshot, {
      reason: 'pre-merge'
    });
    const inspected = await inspectWorkspaceArchive(archive, {
      retainBlobs: false
    });

    expect(inspected.preview.reason).toBe('pre-merge');
    expect(selectWorkspaceArchiveBlobEntries(
      inspected.manifest,
      new Set([generatedHash])
    )).toEqual([
      expect.objectContaining({
        path: `blobs/${generatedHash}`,
        sha256: generatedHash
      })
    ]);
    expect(selectWorkspaceArchiveBlobEntries(
      inspected.manifest,
      new Set()
    )).toEqual([]);
  });

  it('rejects a truncated archive before exposing a restore source', async () => {
    const archive = await createWorkspaceArchive(snapshot, { reason: 'manual' });
    const truncated = archive.slice(0, archive.size - 20, 'application/zip');

    await expect(inspectWorkspaceArchive(truncated)).rejects.toBeInstanceOf(Error);
  });

  it('gives legacy JSON backups a specific unsupported-format error', async () => {
    const legacy = new File(['{"schemaVersion":1}'], 'backup.json', {
      type: 'application/json'
    });

    await expect(inspectWorkspaceArchive(legacy, {
      filename: legacy.name
    })).rejects.toBeInstanceOf(UnsupportedLegacyBackupError);
  });

  it('rejects unsupported ZIP backup versions', async () => {
    const archive = await createZip([{
      path: 'manifest.json',
      text: JSON.stringify({ ...emptyManifest([]), version: 1 })
    }]);

    await expect(inspectWorkspaceArchive(archive)).rejects.toThrow(
      'Backup format version 1 is unsupported'
    );
  });

  it('rejects ZIP files that are not OpenAI Studio archives', async () => {
    await expect(inspectWorkspaceArchive(
      new Blob(['not a zip'], { type: 'application/zip' })
    )).rejects.toSatisfy(error => (
      error instanceof BackupArchiveError || error instanceof Error
    ));
  });

  it('rejects traversal, case collisions, and undeclared ZIP entries', async () => {
    await expect(inspectWorkspaceArchive(await createZip([
      { path: '../manifest.json', text: '{}' }
    ]))).rejects.toThrow('unsafe');

    await expect(inspectWorkspaceArchive(await createZip([
      { path: 'manifest.json', text: JSON.stringify(emptyManifest([])) },
      { path: 'EXTRA.txt', text: 'one' },
      { path: 'extra.txt', text: 'two' }
    ]))).rejects.toThrow(/duplicated|case-colliding|ambiguous/i);

    await expect(inspectWorkspaceArchive(await createZip([
      { path: 'manifest.json', text: JSON.stringify(emptyManifest([])) },
      { path: 'extra.txt', text: 'undeclared' }
    ]))).rejects.toThrow('Undeclared entry');
  });

  it('rejects a declared entry whose SHA-256 does not match its bytes', async () => {
    const settings = '{"theme":"dark"}';
    const instructions = '[]';
    const declared = [
      {
        path: 'workspace/settings.json',
        text: settings,
        sha256: '0'.repeat(64)
      },
      {
        path: 'workspace/system_instructions.json',
        text: instructions
      }
    ];
    const archive = await createZip([
      {
        path: 'manifest.json',
        text: JSON.stringify(emptyManifest(declared))
      },
      ...declared
    ]);

    await expect(inspectWorkspaceArchive(archive)).rejects.toThrow(
      'failed its SHA-256 check'
    );
  });
});
