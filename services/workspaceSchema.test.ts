import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Session } from '../types';
import {
  WORKSPACE_SCHEMA_VERSION,
  parseJsonText,
  parseJsonTextWithBackup,
  parseStoredSessions,
  parseWorkspaceBackup,
  validateWorkspaceReferences
} from './workspaceSchema';

const createSession = (): Session => ({
  id: 'session-1',
  title: 'Test',
  config: DEFAULT_CONFIG,
  lastModified: 1,
  messages: [
    {
      id: 'message-user',
      role: 'user' as const,
      content: 'Question',
      requestId: 'request-1',
      timestamp: 1
    },
    {
      id: 'message-assistant',
      role: 'assistant' as const,
      content: 'Answer',
      requestId: 'request-1',
      status: 'complete' as const,
      timestamp: 2,
      sources: [{ title: 'OpenAI', url: 'https://openai.com' }],
      usage: {
        input_tokens: 10,
        input_tokens_details: {
          cached_tokens: 2,
          cache_write_tokens: 1
        } as any,
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 15
      },
      generatedFiles: [{
        filename: 'result.txt',
        fileId: 'file-1',
        containerId: 'container-1'
      }]
    }
  ]
});

const createBackup = () => ({
  schemaVersion: WORKSPACE_SCHEMA_VERSION,
  sessions: [createSession()],
  settings: {
    theme: 'dark' as const,
    lastActiveSessionId: 'session-1'
  },
  instructions: [],
  timestamp: 3
});

describe('workspace runtime schema', () => {
  it('accepts a complete versioned backup and migrates a legacy version marker', () => {
    expect(parseWorkspaceBackup(createBackup())).toMatchObject({
      schemaVersion: WORKSPACE_SCHEMA_VERSION
    });

    const legacyBackup = createBackup();
    delete (legacyBackup as Partial<typeof legacyBackup>).schemaVersion;
    expect(parseWorkspaceBackup(legacyBackup).schemaVersion).toBe(
      WORKSPACE_SCHEMA_VERSION
    );

    expect(() => parseWorkspaceBackup({
      ...createBackup(),
      schemaVersion: WORKSPACE_SCHEMA_VERSION + 1
    })).toThrow('must equal the supported version');
  });

  it('rejects malformed nested sources, usage, generated files, and timestamps', () => {
    const invalidSource = createBackup();
    invalidSource.sessions[0].messages[1].sources = [{} as any];
    expect(() => parseWorkspaceBackup(invalidSource)).toThrow(
      'sources[0].title must be a string'
    );

    const invalidUsage = createBackup();
    invalidUsage.sessions[0].messages[1].usage!.total_tokens = Number.POSITIVE_INFINITY;
    expect(() => parseWorkspaceBackup(invalidUsage)).toThrow(
      'total_tokens must be a finite number'
    );

    const invalidFile = createBackup();
    invalidFile.sessions[0].messages[1].generatedFiles = [{
      filename: 'result.txt',
      fileId: '',
      containerId: 'container-1'
    }];
    expect(() => parseWorkspaceBackup(invalidFile)).toThrow(
      'fileId must not be empty'
    );

    const invalidTimestamp = createBackup();
    invalidTimestamp.sessions[0].lastModified = Number.NaN;
    expect(() => parseWorkspaceBackup(invalidTimestamp)).toThrow(
      'lastModified must be a finite number'
    );
  });

  it('rejects duplicate IDs and invalid pending-request references', () => {
    const duplicateSessions = createBackup();
    duplicateSessions.sessions.push(createSession());
    expect(() => parseWorkspaceBackup(duplicateSessions)).toThrow(
      'duplicates the ID "session-1"'
    );

    const invalidPending = createBackup();
    invalidPending.sessions[0].pendingRequest = {
      id: 'request-2',
      userMessageId: 'message-user',
      assistantMessageId: 'message-assistant',
      createdAt: 2
    };
    expect(() => parseWorkspaceBackup(invalidPending)).toThrow(
      'must match the referenced user message requestId'
    );
  });

  it('enforces bounded text values', () => {
    const oversizedTitle = createBackup();
    oversizedTitle.sessions[0].title = 'x'.repeat(4097);

    expect(() => parseWorkspaceBackup(oversizedTitle)).toThrow(
      'must contain at most 4096 characters'
    );
  });

  it('rejects dangling workspace references and local-only backup attachments', () => {
    const danglingSession = createBackup();
    danglingSession.settings!.lastActiveSessionId = 'missing-session';
    expect(() => parseWorkspaceBackup(danglingSession)).toThrow(
      'must reference a session in the same workspace'
    );

    const localAttachment = createBackup();
    localAttachment.sessions[0].messages[0].attachments = [{
      id: 'attachment-1',
      name: 'notes.txt',
      type: 'text/plain'
    }];
    expect(() => parseWorkspaceBackup(localAttachment)).toThrow(
      'cannot reference a local attachment ID without embedded content'
    );
  });

  it('validates stored sessions with the same nested schema', () => {
    const sessions = [createSession()];
    expect(parseStoredSessions(sessions)).toBe(sessions);

    sessions[0].messages[1].sources = [{} as any];
    expect(() => parseStoredSessions(sessions)).toThrow(
      'sources[0].title must be a string'
    );
  });

  it('accepts bounded refusal and incomplete-response metadata', () => {
    const backup = createBackup();
    const assistantMessage = backup.sessions[0].messages[1];
    assistantMessage.status = 'incomplete';
    assistantMessage.refusal = 'I cannot help with that request.';
    assistantMessage.incompleteReason = 'content_filter';

    expect(parseWorkspaceBackup(backup).sessions[0].messages[1]).toMatchObject({
      status: 'incomplete',
      refusal: 'I cannot help with that request.',
      incompleteReason: 'content_filter'
    });

    assistantMessage.incompleteReason = 'unknown_reason' as any;
    expect(() => parseWorkspaceBackup(backup)).toThrow(
      'incompleteReason has an unsupported value'
    );

    assistantMessage.incompleteReason = 'max_output_tokens';
    assistantMessage.status = 'complete';
    expect(() => parseWorkspaceBackup(backup)).toThrow(
      'incompleteReason requires an incomplete message status'
    );
  });

  it('validates system-instruction references after all sections are loaded', () => {
    const session = createSession();
    session.config = {
      ...session.config,
      systemInstructionId: 'missing-instruction'
    };

    expect(() => validateWorkspaceReferences({
      sessions: [session],
      settings: null,
      instructions: []
    })).toThrow('must reference a system instruction');
  });

  it('reports schema-invalid JSON distinctly from syntax-invalid JSON', () => {
    expect(() => parseJsonText(
      'sessions.json',
      '{}',
      parseStoredSessions
    )).toThrow('Stored file sessions.json: sessions must be an array');

    expect(() => parseJsonText(
      'sessions.json',
      '{',
      parseStoredSessions
    )).toThrow('Stored file sessions.json is not valid JSON');
  });

  it('recovers schema-invalid primary JSON only from a schema-valid backup', async () => {
    const sessions = [createSession()];
    await expect(parseJsonTextWithBackup({
      filename: 'sessions.json',
      primaryText: '{}',
      readBackupText: async () => JSON.stringify(sessions),
      parseValue: parseStoredSessions
    })).resolves.toEqual(sessions);

    await expect(parseJsonTextWithBackup({
      filename: 'sessions.json',
      primaryText: '{}',
      readBackupText: async () => '{}',
      parseValue: parseStoredSessions
    })).rejects.toThrow('Recovery also failed');
  });
});
