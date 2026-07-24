import {
  FileAttachment,
  GeneratedFile,
  Message,
  OpenAIResponsesUsage,
  Session,
  Source,
  SystemInstruction
} from '../types';

export const WORKSPACE_SCHEMA_VERSION = 1;
export const MAX_WORKSPACE_BACKUP_BYTES = 512 * 1024 * 1024;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_API_IDENTIFIER_LENGTH = 512;
const MAX_SHORT_TEXT_LENGTH = 4096;
const MAX_URL_LENGTH = 16 * 1024;
const MAX_MESSAGE_CONTENT_LENGTH = 16 * 1024 * 1024;
const MAX_INSTRUCTION_CONTENT_LENGTH = 2 * 1024 * 1024;
const MAX_ATTACHMENT_CONTENT_LENGTH = 256 * 1024 * 1024;
const MAX_SESSIONS = 10_000;
const MAX_MESSAGES_PER_SESSION = 100_000;
const MAX_ATTACHMENTS_PER_MESSAGE = 100;
const MAX_SOURCES_PER_MESSAGE = 1_000;
const MAX_GENERATED_FILES_PER_MESSAGE = 1_000;
const MAX_INSTRUCTIONS = 10_000;
const MAX_TOKEN_COUNT = 1_000_000_000_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const MESSAGE_STATUSES = new Set(['streaming', 'complete', 'error', 'stopped']);
const TEXT_VERBOSITIES = new Set(['low', 'medium', 'high']);
const GENERATED_FILE_SOURCES = new Set(['container_file_citation']);

export interface AppSettings {
  theme: 'dark' | 'light';
  apiKey: string;
  lastActiveSessionId?: string;
}

export type BackupSettings = Omit<AppSettings, 'apiKey'> & { apiKey?: string };

export interface WorkspaceBackup {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  sessions: Session[];
  settings?: BackupSettings | null;
  instructions?: SystemInstruction[];
  timestamp: number;
}

export class WorkspaceSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSchemaError';
  }
}

const fail = (path: string, message: string): never => {
  throw new WorkspaceSchemaError(`${path} ${message}.`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const assertRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value as Record<string, unknown>;
};

const assertOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void => {
  const allowed = new Set(keys);
  const unknownKey = Object.keys(value).find(key => !allowed.has(key));
  if (unknownKey) fail(`${path}.${unknownKey}`, 'is not supported by this schema version');
};

const assertArray = (
  value: unknown,
  path: string,
  maximumLength: number
): unknown[] => {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const array = value as unknown[];
  if (array.length > maximumLength) {
    fail(path, `must contain at most ${maximumLength} items`);
  }
  return array;
};

const assertString = (
  value: unknown,
  path: string,
  maximumLength: number,
  allowEmpty = true
): string => {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const string = value as string;
  if (!allowEmpty && string.length === 0) fail(path, 'must not be empty');
  if (string.length > maximumLength) {
    fail(path, `must contain at most ${maximumLength} characters`);
  }
  return string;
};

const assertOptionalString = (
  value: unknown,
  path: string,
  maximumLength: number,
  allowEmpty = true
): string | undefined => (
  value === undefined
    ? undefined
    : assertString(value, path, maximumLength, allowEmpty)
);

const assertLocalId = (value: unknown, path: string): string => {
  const id = assertString(value, path, MAX_IDENTIFIER_LENGTH, false);
  if (!LOCAL_ID_PATTERN.test(id)) fail(path, 'contains unsupported characters');
  return id;
};

const assertOptionalLocalId = (value: unknown, path: string): string | undefined => (
  value === undefined ? undefined : assertLocalId(value, path)
);

const assertAttachmentId = (value: unknown, path: string): string => {
  const id = assertString(value, path, 128, false);
  if (!ATTACHMENT_ID_PATTERN.test(id)) fail(path, 'contains unsupported characters');
  return id;
};

const assertFiniteNumber = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(path, `must be a finite number between ${minimum} and ${maximum}`);
  }
  return value as number;
};

const assertSafeInteger = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number => {
  const number = assertFiniteNumber(value, path, minimum, maximum);
  if (!Number.isSafeInteger(number)) fail(path, 'must be a safe integer');
  return number;
};

const assertTimestamp = (value: unknown, path: string): number => (
  assertSafeInteger(value, path, 0, MAX_TIMESTAMP)
);

const assertUniqueId = (
  ids: Set<string>,
  id: string,
  path: string
): void => {
  if (ids.has(id)) fail(path, `duplicates the ID "${id}"`);
  ids.add(id);
};

const parseUsage = (value: unknown, path: string): OpenAIResponsesUsage => {
  const usage = assertRecord(value, path);
  assertOnlyKeys(
    usage,
    [
      'input_tokens',
      'input_tokens_details',
      'output_tokens',
      'output_tokens_details',
      'total_tokens'
    ],
    path
  );
  assertSafeInteger(usage.input_tokens, `${path}.input_tokens`, 0, MAX_TOKEN_COUNT);
  assertSafeInteger(usage.output_tokens, `${path}.output_tokens`, 0, MAX_TOKEN_COUNT);
  assertSafeInteger(usage.total_tokens, `${path}.total_tokens`, 0, MAX_TOKEN_COUNT);

  const inputDetails = assertRecord(
    usage.input_tokens_details,
    `${path}.input_tokens_details`
  );
  assertOnlyKeys(inputDetails, ['cached_tokens'], `${path}.input_tokens_details`);
  assertSafeInteger(
    inputDetails.cached_tokens,
    `${path}.input_tokens_details.cached_tokens`,
    0,
    MAX_TOKEN_COUNT
  );

  const outputDetails = assertRecord(
    usage.output_tokens_details,
    `${path}.output_tokens_details`
  );
  assertOnlyKeys(outputDetails, ['reasoning_tokens'], `${path}.output_tokens_details`);
  assertSafeInteger(
    outputDetails.reasoning_tokens,
    `${path}.output_tokens_details.reasoning_tokens`,
    0,
    MAX_TOKEN_COUNT
  );

  return value as OpenAIResponsesUsage;
};

const parseSource = (value: unknown, path: string): Source => {
  const source = assertRecord(value, path);
  assertOnlyKeys(source, ['title', 'url'], path);
  assertString(source.title, `${path}.title`, MAX_SHORT_TEXT_LENGTH);
  assertString(source.url, `${path}.url`, MAX_URL_LENGTH, false);
  return value as Source;
};

const parseGeneratedFile = (value: unknown, path: string): GeneratedFile => {
  const file = assertRecord(value, path);
  assertOnlyKeys(
    file,
    ['filename', 'fileId', 'containerId', 'displayName', 'mimeType', 'source'],
    path
  );
  assertString(file.filename, `${path}.filename`, MAX_SHORT_TEXT_LENGTH, false);
  assertString(file.fileId, `${path}.fileId`, MAX_API_IDENTIFIER_LENGTH, false);
  assertString(file.containerId, `${path}.containerId`, MAX_API_IDENTIFIER_LENGTH, false);
  assertOptionalString(file.displayName, `${path}.displayName`, MAX_SHORT_TEXT_LENGTH);
  assertOptionalString(file.mimeType, `${path}.mimeType`, 512);
  if (
    file.source !== undefined &&
    (
      typeof file.source !== 'string' ||
      !GENERATED_FILE_SOURCES.has(file.source)
    )
  ) {
    fail(`${path}.source`, 'has an unsupported value');
  }
  return value as GeneratedFile;
};

const parseAttachment = (
  value: unknown,
  path: string,
  backup: boolean
): FileAttachment => {
  const attachment = assertRecord(value, path);
  assertOnlyKeys(attachment, ['id', 'name', 'type', 'content'], path);
  const id = attachment.id === undefined
    ? undefined
    : assertAttachmentId(attachment.id, `${path}.id`);
  assertString(attachment.name, `${path}.name`, MAX_SHORT_TEXT_LENGTH);
  assertString(attachment.type, `${path}.type`, 512);
  const content = assertOptionalString(
    attachment.content,
    `${path}.content`,
    MAX_ATTACHMENT_CONTENT_LENGTH,
    false
  );
  if (content !== undefined && !content.startsWith('data:')) {
    fail(`${path}.content`, 'must be a data URL');
  }
  if (backup && id !== undefined && content === undefined) {
    fail(path, 'cannot reference a local attachment ID without embedded content');
  }
  return value as FileAttachment;
};

const parseMessage = (
  value: unknown,
  path: string,
  backup: boolean,
  messageIds: Set<string>,
  attachmentIds: Set<string>
): Message => {
  const message = assertRecord(value, path);
  assertOnlyKeys(
    message,
    [
      'id',
      'role',
      'content',
      'status',
      'requestId',
      'openaiResponseId',
      'thinking',
      'thinkingDuration',
      'usage',
      'sources',
      'generatedFiles',
      'timestamp',
      'attachments',
      'model',
      'reasoningEffort'
    ],
    path
  );

  const id = assertOptionalLocalId(message.id, `${path}.id`);
  if (id !== undefined) assertUniqueId(messageIds, id, `${path}.id`);
  if (message.role !== 'user' && message.role !== 'assistant') {
    fail(`${path}.role`, 'must be "user" or "assistant"');
  }
  assertString(message.content, `${path}.content`, MAX_MESSAGE_CONTENT_LENGTH);
  if (
    message.status !== undefined &&
    (
      typeof message.status !== 'string' ||
      !MESSAGE_STATUSES.has(message.status)
    )
  ) {
    fail(`${path}.status`, 'has an unsupported value');
  }
  assertOptionalLocalId(message.requestId, `${path}.requestId`);
  assertOptionalString(
    message.openaiResponseId,
    `${path}.openaiResponseId`,
    MAX_API_IDENTIFIER_LENGTH,
    false
  );
  assertOptionalString(
    message.thinking,
    `${path}.thinking`,
    MAX_MESSAGE_CONTENT_LENGTH
  );
  if (message.thinkingDuration !== undefined) {
    assertFiniteNumber(
      message.thinkingDuration,
      `${path}.thinkingDuration`,
      0,
      MAX_DURATION_MS
    );
  }
  if (message.usage !== undefined) parseUsage(message.usage, `${path}.usage`);

  if (message.sources !== undefined) {
    assertArray(message.sources, `${path}.sources`, MAX_SOURCES_PER_MESSAGE)
      .forEach((source, index) => parseSource(source, `${path}.sources[${index}]`));
  }

  if (message.generatedFiles !== undefined) {
    const generatedFileKeys = new Set<string>();
    assertArray(
      message.generatedFiles,
      `${path}.generatedFiles`,
      MAX_GENERATED_FILES_PER_MESSAGE
    ).forEach((file, index) => {
      const generatedFile = parseGeneratedFile(
        file,
        `${path}.generatedFiles[${index}]`
      );
      const key = `${generatedFile.containerId}\u0000${generatedFile.fileId}`;
      assertUniqueId(generatedFileKeys, key, `${path}.generatedFiles[${index}]`);
    });
  }

  assertTimestamp(message.timestamp, `${path}.timestamp`);

  if (message.attachments !== undefined) {
    assertArray(
      message.attachments,
      `${path}.attachments`,
      MAX_ATTACHMENTS_PER_MESSAGE
    ).forEach((attachment, index) => {
      const parsedAttachment = parseAttachment(
        attachment,
        `${path}.attachments[${index}]`,
        backup
      );
      if (parsedAttachment.id !== undefined) {
        assertUniqueId(
          attachmentIds,
          parsedAttachment.id,
          `${path}.attachments[${index}].id`
        );
      }
    });
  }

  assertOptionalString(message.model, `${path}.model`, MAX_API_IDENTIFIER_LENGTH, false);
  assertOptionalString(
    message.reasoningEffort,
    `${path}.reasoningEffort`,
    MAX_IDENTIFIER_LENGTH,
    false
  );
  return value as Message;
};

const parseConfig = (value: unknown, path: string): void => {
  const config = assertRecord(value, path);
  assertOnlyKeys(
    config,
    ['model', 'reasoningEffort', 'textVerbosity', 'tools', 'systemInstructionId'],
    path
  );
  assertOptionalString(
    config.model,
    `${path}.model`,
    MAX_API_IDENTIFIER_LENGTH,
    false
  );
  assertOptionalString(
    config.reasoningEffort,
    `${path}.reasoningEffort`,
    MAX_IDENTIFIER_LENGTH,
    false
  );
  if (
    config.textVerbosity !== undefined &&
    (
      typeof config.textVerbosity !== 'string' ||
      !TEXT_VERBOSITIES.has(config.textVerbosity)
    )
  ) {
    fail(`${path}.textVerbosity`, 'has an unsupported value');
  }
  if (config.tools !== undefined) {
    const tools = assertRecord(config.tools, `${path}.tools`);
    assertOnlyKeys(tools, ['webSearch', 'codeInterpreter'], `${path}.tools`);
    if (tools.webSearch !== undefined && typeof tools.webSearch !== 'boolean') {
      fail(`${path}.tools.webSearch`, 'must be a boolean');
    }
    if (
      tools.codeInterpreter !== undefined &&
      typeof tools.codeInterpreter !== 'boolean'
    ) {
      fail(`${path}.tools.codeInterpreter`, 'must be a boolean');
    }
  }
  assertOptionalLocalId(
    config.systemInstructionId,
    `${path}.systemInstructionId`
  );
};

export const parseStoredSessions = (
  value: unknown,
  options: { backup?: boolean } = {}
): Session[] => {
  const sessions = assertArray(value, 'sessions', MAX_SESSIONS);
  const sessionIds = new Set<string>();
  const messageIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const pendingRequestIds = new Set<string>();

  sessions.forEach((sessionValue, sessionIndex) => {
    const path = `sessions[${sessionIndex}]`;
    const session = assertRecord(sessionValue, path);
    assertOnlyKeys(
      session,
      ['id', 'title', 'messages', 'config', 'lastModified', 'pendingRequest'],
      path
    );
    const sessionId = assertLocalId(session.id, `${path}.id`);
    assertUniqueId(sessionIds, sessionId, `${path}.id`);
    assertString(session.title, `${path}.title`, MAX_SHORT_TEXT_LENGTH);
    parseConfig(session.config, `${path}.config`);
    assertTimestamp(session.lastModified, `${path}.lastModified`);

    const messages = assertArray(
      session.messages,
      `${path}.messages`,
      MAX_MESSAGES_PER_SESSION
    );
    const sessionMessages = messages.map((message, messageIndex) => (
      parseMessage(
        message,
        `${path}.messages[${messageIndex}]`,
        Boolean(options.backup),
        messageIds,
        attachmentIds
      )
    ));

    if (session.pendingRequest !== undefined) {
      const pendingPath = `${path}.pendingRequest`;
      const pending = assertRecord(session.pendingRequest, pendingPath);
      assertOnlyKeys(
        pending,
        ['id', 'userMessageId', 'assistantMessageId', 'createdAt'],
        pendingPath
      );
      const pendingId = assertLocalId(pending.id, `${pendingPath}.id`);
      assertUniqueId(pendingRequestIds, pendingId, `${pendingPath}.id`);
      const userMessageId = assertLocalId(
        pending.userMessageId,
        `${pendingPath}.userMessageId`
      );
      const assistantMessageId = assertOptionalLocalId(
        pending.assistantMessageId,
        `${pendingPath}.assistantMessageId`
      );
      assertTimestamp(pending.createdAt, `${pendingPath}.createdAt`);

      const userMessage = sessionMessages.find(message => message.id === userMessageId);
      if (!userMessage || userMessage.role !== 'user') {
        fail(`${pendingPath}.userMessageId`, 'must reference a user message in the same session');
      }
      if ((userMessage as Message).requestId !== pendingId) {
        fail(`${pendingPath}.id`, 'must match the referenced user message requestId');
      }
      if (assistantMessageId !== undefined) {
        const assistantMessage = sessionMessages.find(
          message => message.id === assistantMessageId
        );
        if (assistantMessage && assistantMessage.role !== 'assistant') {
          fail(
            `${pendingPath}.assistantMessageId`,
            'must reference an assistant message in the same session'
          );
        }
        if (assistantMessage && assistantMessage.requestId !== pendingId) {
          fail(
            `${pendingPath}.id`,
            'must match the referenced assistant message requestId'
          );
        }
      }
    }
  });

  return value as Session[];
};

export const parseAppSettings = (
  value: unknown,
  options: { backup?: boolean } = {}
): AppSettings | BackupSettings => {
  const settings = assertRecord(value, 'settings');
  assertOnlyKeys(settings, ['theme', 'apiKey', 'lastActiveSessionId'], 'settings');
  if (settings.theme !== 'dark' && settings.theme !== 'light') {
    fail('settings.theme', 'must be "dark" or "light"');
  }
  if (!options.backup || settings.apiKey !== undefined) {
    assertString(settings.apiKey, 'settings.apiKey', 64 * 1024);
  }
  assertOptionalLocalId(
    settings.lastActiveSessionId,
    'settings.lastActiveSessionId'
  );
  return value as AppSettings | BackupSettings;
};

export const parseSystemInstructions = (value: unknown): SystemInstruction[] => {
  const instructions = assertArray(value, 'instructions', MAX_INSTRUCTIONS);
  const ids = new Set<string>();

  instructions.forEach((instructionValue, index) => {
    const path = `instructions[${index}]`;
    const instruction = assertRecord(instructionValue, path);
    assertOnlyKeys(instruction, ['id', 'title', 'content'], path);
    const id = assertLocalId(instruction.id, `${path}.id`);
    assertUniqueId(ids, id, `${path}.id`);
    assertString(instruction.title, `${path}.title`, MAX_SHORT_TEXT_LENGTH);
    assertString(
      instruction.content,
      `${path}.content`,
      MAX_INSTRUCTION_CONTENT_LENGTH
    );
  });

  return value as SystemInstruction[];
};

export const validateWorkspaceReferences = ({
  sessions,
  settings,
  instructions
}: {
  sessions: Session[];
  settings?: AppSettings | BackupSettings | null;
  instructions?: SystemInstruction[];
}, options: {
  allowDanglingSelections?: boolean;
} = {}): void => {
  const sessionIds = new Set(sessions.map(session => session.id));
  if (
    !options.allowDanglingSelections &&
    settings?.lastActiveSessionId !== undefined &&
    !sessionIds.has(settings.lastActiveSessionId)
  ) {
    fail(
      'settings.lastActiveSessionId',
      'must reference a session in the same workspace'
    );
  }

  if (instructions === undefined || options.allowDanglingSelections) return;
  const instructionIds = new Set(instructions.map(instruction => instruction.id));
  sessions.forEach((session, index) => {
    const instructionId = session.config.systemInstructionId;
    if (instructionId !== undefined && !instructionIds.has(instructionId)) {
      fail(
        `sessions[${index}].config.systemInstructionId`,
        'must reference a system instruction in the same workspace'
      );
    }
  });
};

export const parseWorkspaceBackup = (value: unknown): WorkspaceBackup => {
  const backup = assertRecord(value, 'backup');
  assertOnlyKeys(
    backup,
    ['schemaVersion', 'sessions', 'settings', 'instructions', 'timestamp'],
    'backup'
  );
  if (
    backup.schemaVersion !== undefined &&
    backup.schemaVersion !== WORKSPACE_SCHEMA_VERSION
  ) {
    fail(
      'backup.schemaVersion',
      `must equal the supported version ${WORKSPACE_SCHEMA_VERSION}`
    );
  }

  const sessions = parseStoredSessions(backup.sessions, { backup: true });
  const settings = backup.settings === undefined || backup.settings === null
    ? backup.settings
    : parseAppSettings(backup.settings, { backup: true }) as BackupSettings;
  const instructions = backup.instructions === undefined
    ? undefined
    : parseSystemInstructions(backup.instructions);
  const timestamp = assertTimestamp(backup.timestamp, 'backup.timestamp');

  validateWorkspaceReferences({
    sessions,
    settings,
    instructions
  });

  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    sessions,
    settings,
    instructions,
    timestamp
  };
};

export const parseJsonText = <T>(
  filename: string,
  text: string,
  parseValue: (value: unknown) => T
): T => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkspaceSchemaError(`Stored file ${filename} is not valid JSON.`);
  }

  try {
    return parseValue(value);
  } catch (error) {
    if (error instanceof WorkspaceSchemaError) {
      throw new WorkspaceSchemaError(`Stored file ${filename}: ${error.message}`);
    }
    throw error;
  }
};

export const parseJsonTextWithBackup = async <T>({
  filename,
  primaryText,
  readBackupText,
  parseValue,
  onFallback
}: {
  filename: string;
  primaryText: string;
  readBackupText: () => Promise<string | null>;
  parseValue: (value: unknown) => T;
  onFallback?: (backupFilename: string) => void;
}): Promise<T> => {
  try {
    return parseJsonText(filename, primaryText, parseValue);
  } catch (primaryError) {
    const backupFilename = `${filename}.bak`;
    const backupText = await readBackupText();
    if (backupText === null) throw primaryError;

    try {
      const backup = parseJsonText(backupFilename, backupText, parseValue);
      onFallback?.(backupFilename);
      return backup;
    } catch (backupError) {
      const primaryMessage = primaryError instanceof Error
        ? primaryError.message
        : String(primaryError);
      const backupMessage = backupError instanceof Error
        ? backupError.message
        : String(backupError);
      throw new WorkspaceSchemaError(
        `${primaryMessage} Recovery also failed: ${backupMessage}`
      );
    }
  }
};
