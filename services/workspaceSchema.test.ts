import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Project, Session } from '../types';
import {
  WORKSPACE_SCHEMA_VERSION,
  parseJsonText,
  parseJsonTextWithBackup,
  parseProjectRemoteState,
  parseProjects,
  parseStoredSessions,
  parseWorkspaceBackup,
  validateWorkspaceReferences
} from './workspaceSchema';

const createSession = (): Session => ({
  id: 'session-1',
  title: 'Test',
  config: {
    ...DEFAULT_CONFIG,
    tools: {
      ...DEFAULT_CONFIG.tools,
      webSearchOptions: {
        ...DEFAULT_CONFIG.tools.webSearchOptions,
        userLocation: DEFAULT_CONFIG.tools.webSearchOptions.userLocation
          ? { ...DEFAULT_CONFIG.tools.webSearchOptions.userLocation }
          : null
      }
    }
  },
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
      outputMessages: [{
        content: 'Checking the details.',
        phase: 'commentary' as const
      }, {
        content: 'Answer',
        phase: 'final_answer' as const
      }],
      requestId: 'request-1',
      status: 'complete' as const,
      timestamp: 2,
      modelName: 'GPT-5.6 Sol',
      sources: [{ kind: 'web', title: 'OpenAI', url: 'https://openai.com' }],
      usage: {
        input_tokens: 10,
        input_tokens_details: {
          cached_tokens: 2,
          cache_write_tokens: 1
        },
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

const createProject = (overrides: Partial<Project> = {}): Project => {
  const { systemInstructionId: _systemInstructionId, ...defaultConfig } = DEFAULT_CONFIG;
  return {
    id: 'project-1',
    name: 'Research',
    icon: 'research',
    instructions: 'Use project sources.',
    defaultConfig,
    sources: [{
      id: 'source-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      byteSize: 5,
      localBlob: {
        sha256: 'a'.repeat(64),
        byteSize: 5,
        mimeType: 'text/plain'
      },
      capability: 'file_search',
      addedAt: 1
    }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
};

describe('workspace runtime schema', () => {
  it('accepts a complete versioned backup and migrates a legacy version marker', () => {
    const parsedBackup = parseWorkspaceBackup(createBackup());
    expect(parsedBackup).toMatchObject({
      schemaVersion: WORKSPACE_SCHEMA_VERSION
    });
    expect(parsedBackup.sessions[0].messages[1].usage?.input_tokens_details)
      .toEqual({ cached_tokens: 2, cache_write_tokens: 1 });

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

  it('accepts additive Web Search options and legacy configs without them', () => {
    const backup = createBackup();
    backup.sessions[0].config.tools.webSearchOptions = {
      searchContextSize: 'high',
      userLocation: null
    };
    expect(parseWorkspaceBackup(backup).sessions[0].config.tools.webSearchOptions)
      .toEqual({ searchContextSize: 'high', userLocation: null });

    const legacyBackup = createBackup();
    delete (legacyBackup.sessions[0].config.tools as Partial<
      typeof legacyBackup.sessions[0]['config']['tools']
    >).webSearchOptions;
    expect(() => parseWorkspaceBackup(legacyBackup)).not.toThrow();
  });

  it('rejects malformed Web Search options', () => {
    const invalidContext = createBackup();
    invalidContext.sessions[0].config.tools.webSearchOptions.searchContextSize =
      'extreme' as any;
    expect(() => parseWorkspaceBackup(invalidContext)).toThrow(
      'webSearchOptions.searchContextSize has an unsupported value'
    );

    const invalidLocationType = createBackup();
    invalidLocationType.sessions[0].config.tools.webSearchOptions.userLocation = {
      type: 'precise'
    } as any;
    expect(() => parseWorkspaceBackup(invalidLocationType)).toThrow(
      'webSearchOptions.userLocation.type must equal "approximate"'
    );

    const invalidCountry = createBackup();
    invalidCountry.sessions[0].config.tools.webSearchOptions.userLocation = {
      type: 'approximate',
      country: 'USA'
    };
    expect(() => parseWorkspaceBackup(invalidCountry)).toThrow(
      'webSearchOptions.userLocation.country must contain at most 2 characters'
    );
  });

  it('requires static model names only on assistant messages', () => {
    const missingName = createBackup();
    delete missingName.sessions[0].messages[1].modelName;
    expect(() => parseWorkspaceBackup(missingName)).toThrow(
      'messages[1].modelName must be a string'
    );

    const userName = createBackup();
    userName.sessions[0].messages[0].modelName = 'GPT-5.6 Sol';
    expect(() => parseWorkspaceBackup(userName)).toThrow(
      'messages[0].modelName is only supported for assistant messages'
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

  it('validates assistant output phases without requiring them on legacy messages', () => {
    const backup = createBackup();
    expect(parseWorkspaceBackup(backup).sessions[0].messages[1].outputMessages)
      .toEqual([{
        content: 'Checking the details.',
        phase: 'commentary'
      }, {
        content: 'Answer',
        phase: 'final_answer'
      }]);

    const invalidPhase = createBackup();
    invalidPhase.sessions[0].messages[1].outputMessages![0].phase = 'analysis' as any;
    expect(() => parseWorkspaceBackup(invalidPhase)).toThrow(
      'outputMessages[0].phase has an unsupported value'
    );

    const userOutputs = createBackup();
    userOutputs.sessions[0].messages[0].outputMessages = [{
      content: 'Not allowed.'
    }];
    expect(() => parseWorkspaceBackup(userOutputs)).toThrow(
      'messages[0].outputMessages is only supported for assistant messages'
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

  it('migrates historical web citation records to the discriminated shape', () => {
    const session = createSession();
    session.messages[1].sources = [{
      title: 'Legacy',
      url: 'https://example.com'
    } as any];

    expect(parseStoredSessions([session])[0].messages[1].sources).toEqual([{
      kind: 'web',
      title: 'Legacy',
      url: 'https://example.com'
    }]);
  });

  it('validates project bounds, global source IDs, capabilities, and defaults', () => {
    expect(parseProjects([createProject()])).toHaveLength(1);
    expect(parseProjects([{ ...createProject(), icon: 'health' }])).toHaveLength(1);
    expect(() => parseProjects([{
      ...createProject(),
      color: 'blue'
    } as any])).toThrow('projects[0].color is not supported');

    expect(() => parseProjects([
      createProject(),
      createProject({ id: 'project-2' })
    ])).toThrow('sources[0].id duplicates');

    expect(() => parseProjects([createProject({
      sources: Array.from({ length: 41 }, (_, index) => ({
        ...createProject().sources[0],
        id: `source-${index}`
      }))
    })])).toThrow('must contain at most 40 items');

    expect(() => parseProjects([createProject({
      sources: [{
        ...createProject().sources[0],
        capability: 'memory' as any
      }]
    })])).toThrow('capability has an unsupported value');

    expect(() => parseProjects([createProject({
      sources: [{
        ...createProject().sources[0],
        byteSize: 50 * 1024 * 1024,
        localBlob: {
          ...createProject().sources[0].localBlob,
          byteSize: 50 * 1024 * 1024
        }
      }]
    })])).toThrow('byteSize must be a finite number between 0 and 52428799');

    expect(() => parseProjects([createProject({
      defaultConfig: {
        ...createProject().defaultConfig,
        systemInstructionId: 'instruction-1'
      } as any
    })])).toThrow('systemInstructionId is not supported');
  });

  it('validates project membership and live remote-registry references', () => {
    const session = createSession();
    session.projectId = 'missing-project';
    expect(() => validateWorkspaceReferences({
      sessions: [session],
      projects: [createProject()]
    })).toThrow('must reference a project');

    expect(() => parseProjectRemoteState({
      indexes: {
        'project-1': {
          projectId: 'project-1',
          apiKeyFingerprint: 'b'.repeat(64),
          status: 'ready',
          usageBytes: 1,
          files: {
            'missing-source': {
              projectSourceId: 'missing-source',
              status: 'ready'
            }
          }
        }
      },
      cleanupTombstones: []
    }, [createProject()])).toThrow('must reference a source in the same project');
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
    })).resolves.toEqual(JSON.parse(JSON.stringify(sessions)));

    await expect(parseJsonTextWithBackup({
      filename: 'sessions.json',
      primaryText: '{}',
      readBackupText: async () => '{}',
      parseValue: parseStoredSessions
    })).rejects.toThrow('Recovery also failed');
  });
});
