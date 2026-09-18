import {
  FileAttachment,
  GeneratedFile,
  LocalBlobReference,
  Message,
  OpenAIResponsesUsage,
  Project,
  ProjectRemoteState,
  ProjectSource,
  Session,
  Source,
  SystemInstruction
} from '../types';
import { MAX_ATTACHMENT_BYTES } from '../utils/attachmentValidation';
import { MAX_PROJECT_SOURCES } from '../utils/projectSources';
import { SHA256_PATTERN } from './contentAddressing';

export const MAX_WORKSPACE_BACKUP_BYTES = 512 * 1024 * 1024;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_API_IDENTIFIER_LENGTH = 512;
const MAX_MIME_TYPE_LENGTH = 512;
const MAX_SHORT_TEXT_LENGTH = 4096;
const MAX_URL_LENGTH = 16 * 1024;
const MAX_MESSAGE_CONTENT_LENGTH = 16 * 1024 * 1024;
const MAX_INSTRUCTION_CONTENT_LENGTH = 2 * 1024 * 1024;
const MAX_SESSIONS = 10_000;
const MAX_MESSAGES_PER_SESSION = 100_000;
const MAX_OUTPUT_MESSAGES_PER_MESSAGE = 1_000;
const MAX_ATTACHMENTS_PER_MESSAGE = 100;
const MAX_SOURCES_PER_MESSAGE = 1_000;
const MAX_GENERATED_FILES_PER_MESSAGE = 1_000;
const MAX_INSTRUCTIONS = 10_000;
export const MAX_PROJECTS = 10_000;
const MAX_TOKEN_COUNT = 1_000_000_000_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
// Registries key plain objects by ID; these names would resolve to inherited
// prototype members instead of stored records.
const RESERVED_LOCAL_IDS = new Set(Object.getOwnPropertyNames(Object.prototype));

const MESSAGE_STATUSES = new Set(['streaming', 'complete', 'incomplete', 'error', 'stopped']);
const INCOMPLETE_REASONS = new Set(['max_output_tokens', 'content_filter']);
const ASSISTANT_PHASES = new Set(['commentary', 'final_answer']);
const TEXT_VERBOSITIES = new Set(['low', 'medium', 'high']);
const WEB_SEARCH_CONTEXT_SIZES = new Set(['low', 'medium', 'high']);
const GENERATED_FILE_SOURCES = new Set(['container_file_citation']);
const PROJECT_ICONS = new Set(['folder', 'briefcase', 'code', 'book', 'research', 'writing', 'health']);
const PROJECT_SOURCE_CAPABILITIES = new Set(['file_search', 'code_interpreter', 'direct_attachment']);
const PROJECT_REMOTE_STATUSES = new Set(['disconnected', 'creating', 'ready', 'failed', 'deleting']);
const PROJECT_REMOTE_FILE_STATUSES = new Set(['uploading', 'indexing', 'ready', 'failed', 'removing']);

export interface AppSettings {
  theme: 'dark' | 'light';
  apiKey: string;
  lastActiveSessionId?: string;
}

export type BackupSettings = Omit<AppSettings, 'apiKey'> & { apiKey?: string };

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

// Every persisted object is checked against its declared key list so unknown
// fields are rejected at the storage boundary instead of silently dropped.
const assertObject = (
  value: unknown,
  path: string,
  keys: readonly string[]
): Record<string, unknown> => {
  const record = assertRecord(value, path);
  const allowed = new Set(keys);
  const unknownKey = Object.keys(record).find(key => !allowed.has(key));
  if (unknownKey) fail(`${path}.${unknownKey}`, 'is not supported by this schema version');
  return record;
};

const assertArray = (value: unknown, path: string, maximumLength: number): unknown[] => {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const array = value as unknown[];
  if (array.length > maximumLength) fail(path, `must contain at most ${maximumLength} items`);
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
  if (string.length > maximumLength) fail(path, `must contain at most ${maximumLength} characters`);
  return string;
};

const assertOptionalString = (
  value: unknown,
  path: string,
  maximumLength: number,
  allowEmpty = true
): string | undefined => (
  value === undefined ? undefined : assertString(value, path, maximumLength, allowEmpty)
);

const assertLocalId = (value: unknown, path: string): string => {
  const id = assertString(value, path, MAX_IDENTIFIER_LENGTH, false);
  if (!LOCAL_ID_PATTERN.test(id)) fail(path, 'contains unsupported characters');
  if (RESERVED_LOCAL_IDS.has(id)) fail(path, 'uses a reserved name');
  return id;
};

const assertOptionalLocalId = (value: unknown, path: string): string | undefined => (
  value === undefined ? undefined : assertLocalId(value, path)
);

const assertApiId = (value: unknown, path: string): string => (
  assertString(value, path, MAX_API_IDENTIFIER_LENGTH, false)
);

const assertOptionalApiId = (value: unknown, path: string): string | undefined => (
  assertOptionalString(value, path, MAX_API_IDENTIFIER_LENGTH, false)
);

const assertFiniteNumber = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
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

const assertOptionalSafeInteger = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number | undefined => (
  value === undefined ? undefined : assertSafeInteger(value, path, minimum, maximum)
);

const assertTimestamp = (value: unknown, path: string): number => (
  assertSafeInteger(value, path, 0, MAX_TIMESTAMP)
);

const assertOptionalTimestamp = (value: unknown, path: string): number | undefined => (
  value === undefined ? undefined : assertTimestamp(value, path)
);

const assertEnum = (value: unknown, path: string, allowed: ReadonlySet<string>): string => {
  if (typeof value !== 'string' || !allowed.has(value)) fail(path, 'has an unsupported value');
  return value as string;
};

const assertOptionalEnum = (
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>
): string | undefined => (
  value === undefined ? undefined : assertEnum(value, path, allowed)
);

const assertOptionalBoolean = (value: unknown, path: string): void => {
  if (value !== undefined && typeof value !== 'boolean') fail(path, 'must be a boolean');
};

const assertSha256 = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(path, 'must be a lowercase SHA-256 digest');
  }
  return value as string;
};

const assertUniqueId = (ids: Set<string>, id: string, path: string): void => {
  if (ids.has(id)) fail(path, `duplicates the ID "${id}"`);
  ids.add(id);
};

const parseUsage = (value: unknown, path: string): OpenAIResponsesUsage => {
  const usage = assertObject(value, path, [
    'input_tokens',
    'input_tokens_details',
    'output_tokens',
    'output_tokens_details',
    'total_tokens'
  ]);
  assertSafeInteger(usage.input_tokens, `${path}.input_tokens`, 0, MAX_TOKEN_COUNT);
  assertSafeInteger(usage.output_tokens, `${path}.output_tokens`, 0, MAX_TOKEN_COUNT);
  assertSafeInteger(usage.total_tokens, `${path}.total_tokens`, 0, MAX_TOKEN_COUNT);

  const inputPath = `${path}.input_tokens_details`;
  const inputDetails = assertObject(usage.input_tokens_details, inputPath, [
    'cached_tokens',
    'cache_write_tokens'
  ]);
  assertSafeInteger(inputDetails.cached_tokens, `${inputPath}.cached_tokens`, 0, MAX_TOKEN_COUNT);
  assertOptionalSafeInteger(
    inputDetails.cache_write_tokens,
    `${inputPath}.cache_write_tokens`,
    0,
    MAX_TOKEN_COUNT
  );

  const outputPath = `${path}.output_tokens_details`;
  const outputDetails = assertObject(usage.output_tokens_details, outputPath, ['reasoning_tokens']);
  assertSafeInteger(outputDetails.reasoning_tokens, `${outputPath}.reasoning_tokens`, 0, MAX_TOKEN_COUNT);

  return value as OpenAIResponsesUsage;
};

const parseSource = (value: unknown, path: string): Source => {
  const source = assertRecord(value, path);
  if (source.kind === undefined) {
    assertObject(source, path, ['title', 'url']);
    return {
      kind: 'web',
      title: assertString(source.title, `${path}.title`, MAX_SHORT_TEXT_LENGTH),
      url: assertString(source.url, `${path}.url`, MAX_URL_LENGTH, false)
    };
  }
  if (source.kind === 'web') {
    assertObject(source, path, ['kind', 'title', 'url']);
    assertString(source.title, `${path}.title`, MAX_SHORT_TEXT_LENGTH);
    assertString(source.url, `${path}.url`, MAX_URL_LENGTH, false);
    return value as Source;
  }
  if (source.kind === 'file') {
    assertObject(source, path, ['kind', 'filename', 'fileId', 'projectSourceId']);
    assertString(source.filename, `${path}.filename`, MAX_SHORT_TEXT_LENGTH, false);
    assertApiId(source.fileId, `${path}.fileId`);
    assertOptionalLocalId(source.projectSourceId, `${path}.projectSourceId`);
    return value as Source;
  }
  return fail(`${path}.kind`, 'has an unsupported value');
};

const parseLocalBlobReference = (value: unknown, path: string): LocalBlobReference => {
  const reference = assertObject(value, path, ['sha256', 'byteSize', 'mimeType']);
  assertSha256(reference.sha256, `${path}.sha256`);
  assertSafeInteger(reference.byteSize, `${path}.byteSize`, 0, MAX_WORKSPACE_BACKUP_BYTES);
  assertOptionalString(reference.mimeType, `${path}.mimeType`, MAX_MIME_TYPE_LENGTH);
  return value as LocalBlobReference;
};

const parseOptionalLocalBlobReference = (
  value: unknown,
  path: string
): LocalBlobReference | undefined => (
  value === undefined ? undefined : parseLocalBlobReference(value, path)
);

const parseGeneratedFile = (value: unknown, path: string): GeneratedFile => {
  const file = assertObject(value, path, [
    'filename',
    'fileId',
    'containerId',
    'displayName',
    'mimeType',
    'source', // retired: older records still carry it
    'localBlob'
  ]);
  assertString(file.filename, `${path}.filename`, MAX_SHORT_TEXT_LENGTH, false);
  assertApiId(file.fileId, `${path}.fileId`);
  assertApiId(file.containerId, `${path}.containerId`);
  assertOptionalString(file.displayName, `${path}.displayName`, MAX_SHORT_TEXT_LENGTH);
  assertOptionalString(file.mimeType, `${path}.mimeType`, MAX_MIME_TYPE_LENGTH);
  assertOptionalEnum(file.source, `${path}.source`, GENERATED_FILE_SOURCES);
  parseOptionalLocalBlobReference(file.localBlob, `${path}.localBlob`);
  return value as GeneratedFile;
};

const parseAttachment = (value: unknown, path: string): FileAttachment => {
  const attachment = assertObject(value, path, ['name', 'type', 'size', 'localBlob']);
  assertString(attachment.name, `${path}.name`, MAX_SHORT_TEXT_LENGTH);
  assertString(attachment.type, `${path}.type`, MAX_MIME_TYPE_LENGTH);
  assertOptionalSafeInteger(attachment.size, `${path}.size`, 0, MAX_WORKSPACE_BACKUP_BYTES);
  const localBlob = parseOptionalLocalBlobReference(attachment.localBlob, `${path}.localBlob`);
  if (localBlob && attachment.size !== undefined && attachment.size !== localBlob.byteSize) {
    fail(`${path}.size`, 'must match localBlob.byteSize');
  }
  return value as FileAttachment;
};

const parseOutputMessage = (value: unknown, path: string): void => {
  const output = assertObject(value, path, ['content', 'phase']);
  assertString(output.content, `${path}.content`, MAX_MESSAGE_CONTENT_LENGTH);
  assertOptionalEnum(output.phase, `${path}.phase`, ASSISTANT_PHASES);
};

const parseMessage = (value: unknown, path: string, messageIds: Set<string>): Message => {
  const message = assertObject(value, path, [
    'id',
    'role',
    'content',
    'outputMessages',
    'status',
    'requestId',
    'openaiResponseId',
    'thinking',
    'refusal', // retired: older records still carry it
    'incompleteReason',
    'thinkingDuration',
    'usage',
    'sources',
    'generatedFiles',
    'timestamp',
    'attachments',
    'model',
    'modelName',
    'reasoningEffort',
    'fileSearchCallCount'
  ]);

  const id = assertOptionalLocalId(message.id, `${path}.id`);
  if (id !== undefined) assertUniqueId(messageIds, id, `${path}.id`);
  if (message.role !== 'user' && message.role !== 'assistant') {
    fail(`${path}.role`, 'must be "user" or "assistant"');
  }
  assertString(message.content, `${path}.content`, MAX_MESSAGE_CONTENT_LENGTH);
  if (message.outputMessages !== undefined) {
    if (message.role !== 'assistant') {
      fail(`${path}.outputMessages`, 'is only supported for assistant messages');
    }
    assertArray(message.outputMessages, `${path}.outputMessages`, MAX_OUTPUT_MESSAGES_PER_MESSAGE)
      .forEach((output, index) => parseOutputMessage(output, `${path}.outputMessages[${index}]`));
  }
  assertOptionalEnum(message.status, `${path}.status`, MESSAGE_STATUSES);
  assertOptionalLocalId(message.requestId, `${path}.requestId`);
  assertOptionalApiId(message.openaiResponseId, `${path}.openaiResponseId`);
  assertOptionalString(message.thinking, `${path}.thinking`, MAX_MESSAGE_CONTENT_LENGTH);
  assertOptionalString(message.refusal, `${path}.refusal`, MAX_MESSAGE_CONTENT_LENGTH, false);
  assertOptionalEnum(message.incompleteReason, `${path}.incompleteReason`, INCOMPLETE_REASONS);
  if (message.incompleteReason !== undefined && message.status !== 'incomplete') {
    fail(`${path}.incompleteReason`, 'requires an incomplete message status');
  }
  if (message.thinkingDuration !== undefined) {
    assertFiniteNumber(message.thinkingDuration, `${path}.thinkingDuration`, 0, MAX_DURATION_MS);
  }
  if (message.usage !== undefined) parseUsage(message.usage, `${path}.usage`);

  if (message.sources !== undefined) {
    assertArray(message.sources, `${path}.sources`, MAX_SOURCES_PER_MESSAGE)
      .forEach((source, index) => parseSource(source, `${path}.sources[${index}]`));
  }

  if (message.generatedFiles !== undefined) {
    const generatedFileKeys = new Set<string>();
    assertArray(message.generatedFiles, `${path}.generatedFiles`, MAX_GENERATED_FILES_PER_MESSAGE)
      .forEach((file, index) => {
        const filePath = `${path}.generatedFiles[${index}]`;
        const generatedFile = parseGeneratedFile(file, filePath);
        const key = `${generatedFile.containerId}\u0000${generatedFile.fileId}`;
        assertUniqueId(generatedFileKeys, key, filePath);
      });
  }

  assertTimestamp(message.timestamp, `${path}.timestamp`);

  if (message.attachments !== undefined) {
    assertArray(message.attachments, `${path}.attachments`, MAX_ATTACHMENTS_PER_MESSAGE)
      .forEach((attachment, index) => parseAttachment(attachment, `${path}.attachments[${index}]`));
  }

  assertOptionalApiId(message.model, `${path}.model`);
  if (message.role === 'assistant') {
    assertString(message.modelName, `${path}.modelName`, MAX_SHORT_TEXT_LENGTH, false);
  } else if (message.modelName !== undefined) {
    fail(`${path}.modelName`, 'is only supported for assistant messages');
  }
  assertOptionalString(message.reasoningEffort, `${path}.reasoningEffort`, MAX_IDENTIFIER_LENGTH, false);
  assertOptionalSafeInteger(
    message.fileSearchCallCount,
    `${path}.fileSearchCallCount`,
    0,
    MAX_SOURCES_PER_MESSAGE
  );
  return value as Message;
};

const parseWebSearchOptions = (value: unknown, path: string): void => {
  const options = assertObject(value, path, ['searchContextSize', 'userLocation']);
  assertEnum(options.searchContextSize, `${path}.searchContextSize`, WEB_SEARCH_CONTEXT_SIZES);
  if (options.userLocation === null) return;

  const locationPath = `${path}.userLocation`;
  const location = assertObject(options.userLocation, locationPath, ['type', 'city', 'region', 'country']);
  if (location.type !== 'approximate') fail(`${locationPath}.type`, 'must equal "approximate"');
  assertOptionalString(location.city, `${locationPath}.city`, MAX_IDENTIFIER_LENGTH);
  assertOptionalString(location.region, `${locationPath}.region`, MAX_IDENTIFIER_LENGTH);
  const country = assertOptionalString(location.country, `${locationPath}.country`, 2);
  if (country !== undefined && !/^[A-Za-z]{0,2}$/.test(country)) {
    fail(`${locationPath}.country`, 'must contain only letters');
  }
};

const parseConfig = (value: unknown, path: string): void => {
  const config = assertObject(value, path, [
    'model',
    'reasoningEffort',
    'textVerbosity',
    'tools',
    'systemInstructionId'
  ]);
  assertOptionalApiId(config.model, `${path}.model`);
  assertOptionalString(config.reasoningEffort, `${path}.reasoningEffort`, MAX_IDENTIFIER_LENGTH, false);
  assertOptionalEnum(config.textVerbosity, `${path}.textVerbosity`, TEXT_VERBOSITIES);
  if (config.tools !== undefined) {
    const toolsPath = `${path}.tools`;
    const tools = assertObject(config.tools, toolsPath, ['webSearch', 'webSearchOptions', 'codeInterpreter']);
    assertOptionalBoolean(tools.webSearch, `${toolsPath}.webSearch`);
    assertOptionalBoolean(tools.codeInterpreter, `${toolsPath}.codeInterpreter`);
    if (tools.webSearchOptions !== undefined) {
      parseWebSearchOptions(tools.webSearchOptions, `${toolsPath}.webSearchOptions`);
    }
  }
  assertOptionalLocalId(config.systemInstructionId, `${path}.systemInstructionId`);
};

const parsePendingRequest = (
  value: unknown,
  path: string,
  sessionMessages: Message[],
  pendingRequestIds: Set<string>
): void => {
  const pending = assertObject(value, path, ['id', 'userMessageId', 'assistantMessageId', 'createdAt']);
  const pendingId = assertLocalId(pending.id, `${path}.id`);
  assertUniqueId(pendingRequestIds, pendingId, `${path}.id`);
  const userMessageId = assertLocalId(pending.userMessageId, `${path}.userMessageId`);
  const assistantMessageId = assertOptionalLocalId(pending.assistantMessageId, `${path}.assistantMessageId`);
  assertTimestamp(pending.createdAt, `${path}.createdAt`);

  const userMessage = sessionMessages.find(message => message.id === userMessageId);
  if (!userMessage || userMessage.role !== 'user') {
    fail(`${path}.userMessageId`, 'must reference a user message in the same session');
  }
  if ((userMessage as Message).requestId !== pendingId) {
    fail(`${path}.id`, 'must match the referenced user message requestId');
  }
  if (assistantMessageId === undefined) return;
  const assistantMessage = sessionMessages.find(message => message.id === assistantMessageId);
  if (assistantMessage && assistantMessage.role !== 'assistant') {
    fail(`${path}.assistantMessageId`, 'must reference an assistant message in the same session');
  }
  if (assistantMessage && assistantMessage.requestId !== pendingId) {
    fail(`${path}.id`, 'must match the referenced assistant message requestId');
  }
};

export const parseStoredSessions = (value: unknown): Session[] => {
  const sessions = assertArray(value, 'sessions', MAX_SESSIONS);
  const sessionIds = new Set<string>();
  const messageIds = new Set<string>();
  const pendingRequestIds = new Set<string>();

  sessions.forEach((sessionValue, sessionIndex) => {
    const path = `sessions[${sessionIndex}]`;
    const session = assertObject(sessionValue, path, [
      'id',
      'title',
      'messages',
      'config',
      'lastModified',
      'pendingRequest',
      'projectId'
    ]);
    const sessionId = assertLocalId(session.id, `${path}.id`);
    assertUniqueId(sessionIds, sessionId, `${path}.id`);
    assertString(session.title, `${path}.title`, MAX_SHORT_TEXT_LENGTH);
    parseConfig(session.config, `${path}.config`);
    assertTimestamp(session.lastModified, `${path}.lastModified`);
    assertOptionalLocalId(session.projectId, `${path}.projectId`);

    const sessionMessages = assertArray(session.messages, `${path}.messages`, MAX_MESSAGES_PER_SESSION)
      .map((message, messageIndex) => parseMessage(message, `${path}.messages[${messageIndex}]`, messageIds));

    if (session.pendingRequest !== undefined) {
      parsePendingRequest(session.pendingRequest, `${path}.pendingRequest`, sessionMessages, pendingRequestIds);
    }
  });

  const parsedSessions = value as Session[];
  parsedSessions.forEach(session => {
    session.messages.forEach(message => {
      message.sources?.forEach((source, index) => {
        if (source.kind !== undefined) return;
        const migrated = parseSource(source, `sessions.sources[${index}]`);
        Object.assign(source, migrated);
      });
    });
  });
  return parsedSessions;
};

export const parseAppSettings = (
  value: unknown,
  options: { backup?: boolean } = {}
): AppSettings | BackupSettings => {
  const settings = assertObject(value, 'settings', ['theme', 'apiKey', 'lastActiveSessionId']);
  if (settings.theme !== 'dark' && settings.theme !== 'light') {
    fail('settings.theme', 'must be "dark" or "light"');
  }
  if (!options.backup || settings.apiKey !== undefined) {
    assertString(settings.apiKey, 'settings.apiKey', 64 * 1024);
  }
  assertOptionalLocalId(settings.lastActiveSessionId, 'settings.lastActiveSessionId');
  return value as AppSettings | BackupSettings;
};

export const parseSystemInstructions = (value: unknown): SystemInstruction[] => {
  const instructions = assertArray(value, 'instructions', MAX_INSTRUCTIONS);
  const ids = new Set<string>();

  instructions.forEach((instructionValue, index) => {
    const path = `instructions[${index}]`;
    const instruction = assertObject(instructionValue, path, ['id', 'title', 'content']);
    const id = assertLocalId(instruction.id, `${path}.id`);
    assertUniqueId(ids, id, `${path}.id`);
    assertString(instruction.title, `${path}.title`, MAX_SHORT_TEXT_LENGTH);
    assertString(instruction.content, `${path}.content`, MAX_INSTRUCTION_CONTENT_LENGTH);
  });

  return value as SystemInstruction[];
};

const parseProjectSource = (value: unknown, path: string, sourceIds: Set<string>): ProjectSource => {
  const source = assertObject(value, path, [
    'id',
    'name',
    'mimeType',
    'byteSize',
    'localBlob',
    'capability',
    'addedAt'
  ]);
  const id = assertLocalId(source.id, `${path}.id`);
  assertUniqueId(sourceIds, id, `${path}.id`);
  assertString(source.name, `${path}.name`, MAX_SHORT_TEXT_LENGTH, false);
  assertString(source.mimeType, `${path}.mimeType`, MAX_MIME_TYPE_LENGTH, false);
  const byteSize = assertSafeInteger(source.byteSize, `${path}.byteSize`, 0, MAX_ATTACHMENT_BYTES - 1);
  const localBlob = parseLocalBlobReference(source.localBlob, `${path}.localBlob`);
  if (localBlob.byteSize !== byteSize) fail(`${path}.byteSize`, 'must match localBlob.byteSize');
  assertEnum(source.capability, `${path}.capability`, PROJECT_SOURCE_CAPABILITIES);
  assertTimestamp(source.addedAt, `${path}.addedAt`);
  return value as ProjectSource;
};

export const parseProjects = (value: unknown): Project[] => {
  const values = assertArray(value, 'projects', MAX_PROJECTS);
  const projectIds = new Set<string>();
  const sourceIds = new Set<string>();

  return values.map((projectValue, index): Project => {
    const path = `projects[${index}]`;
    const project = assertObject(projectValue, path, [
      'id',
      'name',
      'icon',
      'instructions',
      // Legacy per-project chat defaults: accepted and ignored so earlier v5
      // workspaces and archives still load.
      'defaultConfig',
      'sources',
      'createdAt',
      'updatedAt'
    ]);
    const id = assertLocalId(project.id, `${path}.id`);
    assertUniqueId(projectIds, id, `${path}.id`);
    const name = assertString(project.name, `${path}.name`, MAX_SHORT_TEXT_LENGTH, false);
    const icon = assertEnum(project.icon, `${path}.icon`, PROJECT_ICONS) as Project['icon'];
    const instructions = assertString(project.instructions, `${path}.instructions`, MAX_INSTRUCTION_CONTENT_LENGTH);
    const sources = assertArray(project.sources, `${path}.sources`, MAX_PROJECT_SOURCES)
      .map((source, sourceIndex) => parseProjectSource(source, `${path}.sources[${sourceIndex}]`, sourceIds));
    const createdAt = assertTimestamp(project.createdAt, `${path}.createdAt`);
    const updatedAt = assertTimestamp(project.updatedAt, `${path}.updatedAt`);
    if (updatedAt < createdAt) fail(`${path}.updatedAt`, 'must not be earlier than createdAt');
    return { id, name, icon, instructions, sources, createdAt, updatedAt };
  });
};

type ProjectRemoteIndex = ProjectRemoteState['indexes'][string];
type ProjectRemoteFile = ProjectRemoteIndex['files'][string];

const parseProjectRemoteFile = (
  value: unknown,
  path: string,
  sourceId: string,
  projectSourceIds: Set<string> | null
): ProjectRemoteFile => {
  const file = assertObject(value, path, [
    'projectSourceId',
    'openaiFileId',
    'status',
    'indexedUsageBytes',
    'lastError'
  ]);
  if (file.projectSourceId !== sourceId) fail(`${path}.projectSourceId`, 'must match its registry key');
  if (projectSourceIds && !projectSourceIds.has(sourceId)) {
    fail(`${path}.projectSourceId`, 'must reference a source in the same project');
  }
  assertOptionalApiId(file.openaiFileId, `${path}.openaiFileId`);
  assertEnum(file.status, `${path}.status`, PROJECT_REMOTE_FILE_STATUSES);
  assertOptionalSafeInteger(file.indexedUsageBytes, `${path}.indexedUsageBytes`, 0, Number.MAX_SAFE_INTEGER);
  assertOptionalString(file.lastError, `${path}.lastError`, MAX_SHORT_TEXT_LENGTH);
  return file as unknown as ProjectRemoteFile;
};

// `project` is undefined when no project list was supplied (cross-checks
// skipped) and null when the list was supplied but lacks this project.
const parseProjectRemoteIndex = (
  value: unknown,
  path: string,
  projectId: string,
  project: Project | null | undefined
): ProjectRemoteIndex => {
  const index = assertObject(value, path, [
    'projectId',
    'apiKeyFingerprint',
    'vectorStoreId',
    'status',
    'usageBytes',
    'files',
    'lastVerifiedAt'
  ]);
  if (index.projectId !== projectId) fail(`${path}.projectId`, 'must match its registry key');
  if (project === null) fail(`${path}.projectId`, 'must reference an existing project');
  assertSha256(index.apiKeyFingerprint, `${path}.apiKeyFingerprint`);
  assertOptionalApiId(index.vectorStoreId, `${path}.vectorStoreId`);
  assertEnum(index.status, `${path}.status`, PROJECT_REMOTE_STATUSES);
  assertSafeInteger(index.usageBytes, `${path}.usageBytes`, 0, Number.MAX_SAFE_INTEGER);
  assertOptionalTimestamp(index.lastVerifiedAt, `${path}.lastVerifiedAt`);
  const files = assertRecord(index.files, `${path}.files`);
  const projectSourceIds = project ? new Set(project.sources.map(source => source.id)) : null;
  const parsedFiles: ProjectRemoteIndex['files'] = {};
  Object.entries(files).forEach(([sourceId, fileValue]) => {
    const filePath = `${path}.files.${sourceId}`;
    assertLocalId(sourceId, filePath);
    parsedFiles[sourceId] = parseProjectRemoteFile(fileValue, filePath, sourceId, projectSourceIds);
  });
  return { ...index, files: parsedFiles } as ProjectRemoteIndex;
};

const parseCleanupTombstone = (
  value: unknown,
  path: string,
  tombstoneIds: Set<string>
): ProjectRemoteState['cleanupTombstones'][number] => {
  const tombstone = assertObject(value, path, [
    'id',
    'projectId',
    'projectSourceId',
    'apiKeyFingerprint',
    'openaiFileIds',
    'vectorStoreId',
    'createdAt',
    'lastError'
  ]);
  const id = assertLocalId(tombstone.id, `${path}.id`);
  assertUniqueId(tombstoneIds, id, `${path}.id`);
  assertOptionalLocalId(tombstone.projectId, `${path}.projectId`);
  assertOptionalLocalId(tombstone.projectSourceId, `${path}.projectSourceId`);
  assertSha256(tombstone.apiKeyFingerprint, `${path}.apiKeyFingerprint`);
  const fileIds = assertArray(tombstone.openaiFileIds, `${path}.openaiFileIds`, MAX_PROJECT_SOURCES)
    .map((fileId, fileIndex) => assertApiId(fileId, `${path}.openaiFileIds[${fileIndex}]`));
  if (new Set(fileIds).size !== fileIds.length) fail(`${path}.openaiFileIds`, 'must not contain duplicates');
  assertOptionalApiId(tombstone.vectorStoreId, `${path}.vectorStoreId`);
  assertTimestamp(tombstone.createdAt, `${path}.createdAt`);
  assertOptionalString(tombstone.lastError, `${path}.lastError`, MAX_SHORT_TEXT_LENGTH);
  return tombstone as unknown as ProjectRemoteState['cleanupTombstones'][number];
};

export const parseProjectRemoteState = (value: unknown, projects?: Project[]): ProjectRemoteState => {
  const state = assertObject(value, 'projectRemoteState', ['indexes', 'cleanupTombstones']);
  const indexes = assertRecord(state.indexes, 'projectRemoteState.indexes');
  const projectsById = new Map((projects || []).map(project => [project.id, project]));
  const parsedIndexes: ProjectRemoteState['indexes'] = {};

  Object.entries(indexes).forEach(([projectId, indexValue]) => {
    const path = `projectRemoteState.indexes.${projectId}`;
    assertLocalId(projectId, path);
    const project = projects === undefined ? undefined : projectsById.get(projectId) || null;
    parsedIndexes[projectId] = parseProjectRemoteIndex(indexValue, path, projectId, project);
  });

  const tombstoneIds = new Set<string>();
  const cleanupTombstones = assertArray(
    state.cleanupTombstones,
    'projectRemoteState.cleanupTombstones',
    MAX_PROJECTS * (MAX_PROJECT_SOURCES + 1)
  ).map((tombstone, index) => (
    parseCleanupTombstone(tombstone, `projectRemoteState.cleanupTombstones[${index}]`, tombstoneIds)
  ));

  return { indexes: parsedIndexes, cleanupTombstones };
};

export const validateWorkspaceReferences = ({
  sessions,
  settings,
  instructions,
  projects
}: {
  sessions: Session[];
  settings?: AppSettings | BackupSettings | null;
  instructions?: SystemInstruction[];
  projects?: Project[];
}, options: {
  allowDanglingSelections?: boolean;
} = {}): void => {
  const sessionIds = new Set(sessions.map(session => session.id));
  if (
    !options.allowDanglingSelections &&
    settings?.lastActiveSessionId !== undefined &&
    !sessionIds.has(settings.lastActiveSessionId)
  ) {
    fail('settings.lastActiveSessionId', 'must reference a session in the same workspace');
  }

  if (projects !== undefined) {
    const projectIds = new Set(projects.map(project => project.id));
    sessions.forEach((session, index) => {
      if (session.projectId !== undefined && !projectIds.has(session.projectId)) {
        fail(`sessions[${index}].projectId`, 'must reference a project in the same workspace');
      }
    });
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
