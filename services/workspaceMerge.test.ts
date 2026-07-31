import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  type LocalBlobReference,
  type Session,
  type SystemInstruction
} from '../types';
import type { WorkspaceReplacement } from './storage';
import { createWorkspaceMergePlan } from './workspaceMerge';

const config = (systemInstructionId?: string) => ({
  ...DEFAULT_CONFIG,
  tools: { ...DEFAULT_CONFIG.tools },
  ...(systemInstructionId ? { systemInstructionId } : {})
});

const createSession = (
  id: string,
  lastModified: number,
  options: {
    content?: string;
    instructionId?: string;
    blob?: LocalBlobReference;
  } = {}
): Session => ({
  id,
  title: id,
  lastModified,
  config: config(options.instructionId),
  messages: [{
    id: `message-${id}`,
    role: 'user',
    content: options.content || id,
    timestamp: lastModified,
    ...(options.blob
      ? {
          attachments: [{
            id: `attachment-${id}`,
            name: `${id}.txt`,
            type: 'text/plain',
            size: options.blob.byteSize,
            localBlob: options.blob
          }]
        }
      : {})
  }]
});

const currentWorkspace = (
  sessions: Session[],
  instructions: SystemInstruction[] = []
) => ({
  sessions,
  settings: {
    theme: 'dark' as const,
    apiKey: 'local-key',
    lastActiveSessionId: sessions[0]?.id
  },
  instructions
});

const importedWorkspace = (
  sessions: Session[],
  instructions: SystemInstruction[] = []
): WorkspaceReplacement => ({
  sessions,
  settings: { theme: 'light' },
  instructions,
  blobs: new Map()
});

describe('workspace merge planning', () => {
  it('imports disjoint chats newest-first with stable current-before-archive ties', () => {
    const localOlder = createSession('local-older', 10);
    const localTie = createSession('local-tie', 20);
    const importedTie = createSession('imported-tie', 20);
    const importedNewest = createSession('imported-newest', 30);

    const plan = createWorkspaceMergePlan(
      currentWorkspace([localOlder, localTie]),
      importedWorkspace([importedTie, importedNewest])
    );

    expect(plan.replacement.sessions.map(session => session.id)).toEqual([
      'imported-newest',
      'local-tie',
      'imported-tie',
      'local-older'
    ]);
    expect(plan.counts).toEqual({
      imported: 2,
      skipped: 0,
      divergent: 0
    });
    expect(plan.replacement.settings).toEqual({
      theme: 'dark',
      lastActiveSessionId: 'local-older'
    });
  });

  it('skips identical chats and preserves a divergent same-ID chat as a fully remapped copy', () => {
    const identical = createSession('identical', 5);
    const localDivergent: Session = {
      id: 'divergent',
      title: 'Local',
      lastModified: 6,
      config: config(),
      messages: [{
        id: 'shared-user',
        role: 'user',
        content: 'Local content',
        requestId: 'shared-request',
        timestamp: 6,
        attachments: [{
          id: 'shared-attachment',
          name: 'local.txt',
          type: 'text/plain'
        }]
      }, {
        id: 'shared-assistant',
        role: 'assistant',
        content: 'Local answer',
        requestId: 'shared-request',
        openaiResponseId: 'resp-local',
        timestamp: 7,
        modelName: 'GPT-5.6 Sol'
      }]
    };
    const importedDivergent: Session = {
      ...structuredClone(localDivergent),
      title: 'Imported',
      messages: [{
        ...structuredClone(localDivergent.messages[0]),
        content: 'Imported content'
      }, {
        ...structuredClone(localDivergent.messages[1]),
        openaiResponseId: 'resp-imported',
        generatedFiles: [{
          filename: 'result.txt',
          fileId: 'file-external',
          containerId: 'container-external'
        }]
      }],
      pendingRequest: {
        id: 'shared-request',
        userMessageId: 'shared-user',
        assistantMessageId: 'shared-assistant',
        createdAt: 6
      }
    };

    const plan = createWorkspaceMergePlan(
      currentWorkspace([identical, localDivergent]),
      importedWorkspace([structuredClone(identical), importedDivergent])
    );
    const importedCopy = plan.replacement.sessions.find(
      session => session.title === 'Imported'
    )!;

    expect(plan.counts).toEqual({
      imported: 1,
      skipped: 1,
      divergent: 1
    });
    expect(importedCopy.id).not.toBe('divergent');
    expect(importedCopy.messages.map(message => message.id)).not.toContain(
      'shared-user'
    );
    expect(importedCopy.messages[0].requestId).not.toBe('shared-request');
    expect(importedCopy.messages[0].attachments?.[0].id)
      .not.toBe('shared-attachment');
    expect(importedCopy.pendingRequest?.id)
      .toBe(importedCopy.messages[0].requestId);
    expect(importedCopy.pendingRequest?.userMessageId)
      .toBe(importedCopy.messages[0].id);
    expect(importedCopy.pendingRequest?.assistantMessageId)
      .toBe(importedCopy.messages[1].id);
    expect(importedCopy.messages[1].openaiResponseId).toBe('resp-imported');
    expect(importedCopy.messages[1].generatedFiles?.[0]).toMatchObject({
      fileId: 'file-external',
      containerId: 'container-external'
    });
  });

  it('skips a chat when differently identified instructions have identical content', () => {
    const local = createSession('same-chat', 1, {
      instructionId: 'local-instruction'
    });
    const imported = createSession('same-chat', 1, {
      instructionId: 'archive-instruction'
    });

    const plan = createWorkspaceMergePlan(
      currentWorkspace([local], [{
        id: 'local-instruction',
        title: 'Shared',
        content: 'Use shared rules.'
      }]),
      importedWorkspace([imported], [{
        id: 'archive-instruction',
        title: 'Shared',
        content: 'Use shared rules.'
      }])
    );

    expect(plan.counts).toEqual({
      imported: 0,
      skipped: 1,
      divergent: 0
    });
    expect(plan.replacement.instructions).toHaveLength(1);
  });

  it('remaps local-ID collisions even when chat IDs are disjoint', () => {
    const local = createSession('local', 1);
    const imported = createSession('imported', 2);
    imported.messages[0].id = local.messages[0].id;
    imported.messages[0].attachments = [{
      id: 'attachment-local',
      name: 'imported.txt',
      type: 'text/plain'
    }];
    local.messages[0].attachments = [{
      id: 'attachment-local',
      name: 'local.txt',
      type: 'text/plain'
    }];

    const plan = createWorkspaceMergePlan(
      currentWorkspace([local]),
      importedWorkspace([imported])
    );
    const importedCopy = plan.replacement.sessions[0];

    expect(importedCopy.id).toBe('imported');
    expect(importedCopy.messages[0].id).not.toBe(local.messages[0].id);
    expect(importedCopy.messages[0].attachments?.[0].id)
      .not.toBe('attachment-local');
  });

  it('reuses identical instructions and remaps conflicting instruction IDs', () => {
    const localInstructions: SystemInstruction[] = [{
      id: 'local-common',
      title: 'Common',
      content: 'Use the common rules.'
    }, {
      id: 'conflict',
      title: 'Local conflict',
      content: 'Use local rules.'
    }];
    const archiveInstructions: SystemInstruction[] = [{
      id: 'archive-common',
      title: 'Common',
      content: 'Use the common rules.'
    }, {
      id: 'conflict',
      title: 'Imported conflict',
      content: 'Use imported rules.'
    }, {
      id: 'unreferenced',
      title: 'Unused',
      content: 'Do not import me.'
    }];

    const plan = createWorkspaceMergePlan(
      currentWorkspace([], localInstructions),
      importedWorkspace([
        createSession('common-chat', 2, {
          instructionId: 'archive-common'
        }),
        createSession('conflict-chat', 1, {
          instructionId: 'conflict'
        })
      ], archiveInstructions)
    );

    const common = plan.replacement.sessions.find(
      session => session.id === 'common-chat'
    );
    const conflict = plan.replacement.sessions.find(
      session => session.id === 'conflict-chat'
    );
    expect(common?.config.systemInstructionId).toBe('local-common');
    expect(conflict?.config.systemInstructionId).toBe('conflict-merged');
    expect(plan.replacement.instructions).toHaveLength(3);
    expect(plan.replacement.instructions.map(instruction => instruction.id))
      .not.toContain('unreferenced');
  });

  it('selects blobs only from accepted imported chats', () => {
    const skippedBlob = {
      sha256: 'a'.repeat(64),
      byteSize: 5,
      mimeType: 'text/plain'
    };
    const acceptedBlob = {
      sha256: 'b'.repeat(64),
      byteSize: 6,
      mimeType: 'text/plain'
    };
    const duplicate = createSession('duplicate', 1, { blob: skippedBlob });

    const plan = createWorkspaceMergePlan(
      currentWorkspace([duplicate]),
      importedWorkspace([
        structuredClone(duplicate),
        createSession('accepted', 2, { blob: acceptedBlob })
      ])
    );

    expect([...plan.importedBlobHashes]).toEqual([acceptedBlob.sha256]);
  });

  it('rejects a merged workspace that exceeds the session limit', () => {
    const localSessions = Array.from(
      { length: 10_000 },
      (_, index) => createSession(`local-${index}`, index)
    );

    expect(() => createWorkspaceMergePlan(
      currentWorkspace(localSessions),
      importedWorkspace([createSession('one-too-many', 10_001)])
    )).toThrow('at most 10000 items');
  });
});
