import { ProjectSourceCapability } from '../types';
import {
  AttachmentMetadata,
  AttachmentValidationError,
  MAX_ATTACHMENT_BYTES,
  getAttachmentFormat
} from './attachmentValidation';

export const MAX_PROJECT_SOURCES = 40;
export const MAX_PROJECT_SOURCE_UPLOADS = 10;
export const MAX_INDEXED_USAGE_BYTES = 900 * 1024 * 1024;

// Kept in sync with the official File Search supported-files table.
const FILE_SEARCH_EXTENSIONS = new Set([
  'c',
  'cpp',
  'cs',
  'css',
  'doc',
  'docx',
  'go',
  'html',
  'java',
  'js',
  'json',
  'md',
  'pdf',
  'php',
  'pptx',
  'py',
  'rb',
  'sh',
  'tex',
  'ts',
  'txt'
]);

const ANALYSIS_EXTENSIONS = new Set([
  'csv',
  'iif',
  'tsv',
  'xla',
  'xlb',
  'xlc',
  'xlm',
  'xls',
  'xlsx',
  'xlt',
  'xlw'
]);

const getExtension = (name: string): string => {
  const basename = name.trim().toLowerCase().split(/[\\/]/).pop() || '';
  const index = basename.lastIndexOf('.');
  return index > 0 && index < basename.length - 1
    ? basename.slice(index + 1)
    : '';
};

export const classifyProjectSource = (
  source: Pick<AttachmentMetadata, 'name' | 'type'>
): ProjectSourceCapability => {
  const extension = getExtension(source.name);
  if (FILE_SEARCH_EXTENSIONS.has(extension)) return 'file_search';
  if (ANALYSIS_EXTENSIONS.has(extension)) return 'code_interpreter';
  return 'direct_attachment';
};

export const validateProjectSourceFiles = (
  files: readonly File[],
  existingSourceCount: number
): Array<{
  mimeType: string;
  capability: ProjectSourceCapability;
}> => {
  if (files.length === 0) return [];
  if (files.length > MAX_PROJECT_SOURCE_UPLOADS) {
    throw new AttachmentValidationError(
      `Select at most ${MAX_PROJECT_SOURCE_UPLOADS} project sources at once.`
    );
  }
  if (existingSourceCount + files.length > MAX_PROJECT_SOURCES) {
    throw new AttachmentValidationError(
      `A project can contain at most ${MAX_PROJECT_SOURCES} sources.`
    );
  }

  return files.map(file => {
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new AttachmentValidationError(`"${file.name}" has an invalid size.`);
    }
    if (file.size >= MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `"${file.name}" must be smaller than 50 MB.`
      );
    }
    const format = getAttachmentFormat(file.name, file.type);
    return {
      mimeType: format.mimeType,
      capability: classifyProjectSource({
        name: file.name,
        type: format.mimeType
      })
    };
  });
};
