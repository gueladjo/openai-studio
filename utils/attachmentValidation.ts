export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface AttachmentMetadata {
  name: string;
  type: string;
  size: number;
}

export interface AttachmentFormat {
  kind: 'image' | 'file';
  mimeType: string;
}

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
  }
}

const IMAGE_FORMATS: Record<string, { mimeType: string; acceptedMimeTypes: string[] }> = {
  gif: { mimeType: 'image/gif', acceptedMimeTypes: ['image/gif'] },
  jpeg: { mimeType: 'image/jpeg', acceptedMimeTypes: ['image/jpeg'] },
  jpg: { mimeType: 'image/jpeg', acceptedMimeTypes: ['image/jpeg'] },
  png: { mimeType: 'image/png', acceptedMimeTypes: ['image/png'] },
  webp: { mimeType: 'image/webp', acceptedMimeTypes: ['image/webp'] }
};

const PDF_MIME_TYPES = ['application/pdf'];
const EXCEL_MIME_TYPES = [
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];
const DELIMITED_DATA_MIME_TYPES = [
  'application/csv',
  'application/vnd.google-apps.spreadsheet',
  'application/x-iif',
  'text/csv',
  'text/tsv',
  'text/x-iif'
];
const SPREADSHEET_MIME_TYPES = [
  ...EXCEL_MIME_TYPES,
  ...DELIMITED_DATA_MIME_TYPES
];
const DOCUMENT_MIME_TYPES = [
  'application/msword',
  'application/rtf',
  'application/vnd.apple.iwork',
  'application/vnd.apple.pages',
  'application/vnd.google-apps.document',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/rtf'
];
const PRESENTATION_MIME_TYPES = [
  'application/vnd.apple.iwork',
  'application/vnd.apple.keynote',
  'application/vnd.google-apps.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
];
const TEXT_AND_CODE_MIME_TYPES = [
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/json5',
  'application/toml',
  'application/typescript',
  'application/x-awk',
  'application/x-bash',
  'application/x-httpd-php',
  'application/x-httpd-php-source',
  'application/x-json5',
  'application/x-patch',
  'application/x-php',
  'application/x-protobuf',
  'application/x-sql',
  'application/x-subrip',
  'application/x-terraform',
  'application/x-toml',
  'application/x-yaml',
  'application/yaml',
  'message/rfc822',
  'text/calendar',
  'text/css',
  'text/html',
  'text/javascript',
  'text/jsx',
  'text/markdown',
  'text/plain',
  'text/srt',
  'text/tsx',
  'text/vbscript',
  'text/vtt',
  'text/x-R',
  'text/x-asm',
  'text/x-bash',
  'text/x-c',
  'text/x-c++',
  'text/x-clojure',
  'text/x-cmake',
  'text/x-csharp',
  'text/x-dart',
  'text/x-diff',
  'text/x-dockerfile',
  'text/x-ejs',
  'text/x-elixir',
  'text/x-erb',
  'text/x-erlang',
  'text/x-golang',
  'text/x-gradle',
  'text/x-graphql',
  'text/x-groovy',
  'text/x-handlebars',
  'text/x-haskell',
  'text/x-hcl',
  'text/x-httpd-php',
  'text/x-ini',
  'text/x-java',
  'text/x-jade',
  'text/x-jinja2',
  'text/x-julia',
  'text/x-kotlin',
  'text/x-less',
  'text/x-liquid',
  'text/x-lisp',
  'text/x-lua',
  'text/x-makefile',
  'text/x-mustache',
  'text/x-objectivec',
  'text/x-objectivec++',
  'text/x-patch',
  'text/x-perl',
  'text/x-php',
  'text/x-powershell',
  'text/x-properties',
  'text/x-protobuf',
  'text/x-pug',
  'text/x-python',
  'text/x-r',
  'text/x-rst',
  'text/x-ruby',
  'text/x-rust',
  'text/x-sass',
  'text/x-scala',
  'text/x-scss',
  'text/x-script.python',
  'text/x-sh',
  'text/x-shellscript',
  'text/x-sql',
  'text/x-swift',
  'text/x-terraform',
  'text/x-tex',
  'text/x-tmpl',
  'text/x-toml',
  'text/x-tsv',
  'text/x-twig',
  'text/x-typescript',
  'text/x-vcard',
  'text/x-yaml',
  'text/x-zsh',
  'text/xml'
];

interface FileFormatDefinition {
  mimeType: string;
  acceptedMimeTypes: string[];
}

const createFormats = (
  extensions: string[],
  mimeType: string,
  acceptedMimeTypes: string[]
): Record<string, FileFormatDefinition> => Object.fromEntries(
  extensions.map(extension => [extension, { mimeType, acceptedMimeTypes }])
);

const FILE_FORMATS: Record<string, FileFormatDefinition> = {
  ...createFormats(['pdf'], 'application/pdf', PDF_MIME_TYPES),
  ...createFormats(
    ['xla', 'xlb', 'xlc', 'xlm', 'xls', 'xlt', 'xlw'],
    'application/vnd.ms-excel',
    SPREADSHEET_MIME_TYPES
  ),
  ...createFormats(
    ['xlsx'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    SPREADSHEET_MIME_TYPES
  ),
  ...createFormats(['csv'], 'text/csv', SPREADSHEET_MIME_TYPES),
  ...createFormats(['tsv'], 'text/tsv', SPREADSHEET_MIME_TYPES),
  ...createFormats(['iif'], 'text/x-iif', SPREADSHEET_MIME_TYPES),
  ...createFormats(['doc', 'dot'], 'application/msword', DOCUMENT_MIME_TYPES),
  ...createFormats(
    ['docx'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    DOCUMENT_MIME_TYPES
  ),
  ...createFormats(['odt'], 'application/vnd.oasis.opendocument.text', DOCUMENT_MIME_TYPES),
  ...createFormats(['rtf'], 'application/rtf', DOCUMENT_MIME_TYPES),
  ...createFormats(['pages'], 'application/vnd.apple.pages', DOCUMENT_MIME_TYPES),
  ...createFormats(
    ['pot', 'ppa', 'pps', 'ppt', 'pwz', 'wiz'],
    'application/vnd.ms-powerpoint',
    PRESENTATION_MIME_TYPES
  ),
  ...createFormats(
    ['pptx'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    PRESENTATION_MIME_TYPES
  ),
  ...createFormats(['key'], 'application/vnd.apple.keynote', PRESENTATION_MIME_TYPES),
  ...createFormats(
    [
      'asm', 'astro', 'awk', 'bat', 'bash', 'c', 'cc', 'clj', 'cmake', 'conf',
      'cpp', 'cs', 'css', 'cxx', 'dart', 'def', 'dic', 'diff', 'dockerfile',
      'ejs', 'eml', 'erl', 'ex', 'exs', 'go', 'gradle', 'graphql', 'gql',
      'groovy', 'h', 'hbs', 'hcl', 'hh', 'hs', 'htm', 'html', 'ics', 'ifb',
      'in', 'ini', 'java', 'jade', 'j2', 'jinja', 'jl', 'js', 'json', 'json5',
      'jsonl', 'jsx', 'ksh', 'kt', 'kts', 'less', 'liquid', 'lisp', 'list',
      'log', 'lua', 'm', 'markdown', 'md', 'mht', 'mhtml', 'mime', 'mjs', 'mm',
      'mustache', 'ndjson', 'nws', 'patch', 'php', 'pl', 'properties', 'proto',
      'ps1', 'pug', 'py', 'r', 'rb', 'rs', 'rst', 's', 'sass', 'scala', 'scss',
      'sh', 'sql', 'srt', 'swift', 'tex', 'text', 'tf', 'toml', 'ts', 'tsx',
      'txt', 'vcf', 'vtt', 'xml', 'yaml', 'yml', 'zsh'
    ],
    'text/plain',
    TEXT_AND_CODE_MIME_TYPES
  )
};

const SUPPORTED_BASENAMES: Record<string, FileFormatDefinition> = {
  dockerfile: FILE_FORMATS.dockerfile,
  makefile: {
    mimeType: 'text/plain',
    acceptedMimeTypes: TEXT_AND_CODE_MIME_TYPES
  }
};

const normalizeMimeType = (type: string): string => (
  type.split(';', 1)[0].trim().toLowerCase()
);

const getExtension = (name: string): string | undefined => {
  const basename = name.trim().toLowerCase().split(/[\\/]/).pop() || '';
  const lastDot = basename.lastIndexOf('.');

  if (lastDot <= 0 || lastDot === basename.length - 1) return undefined;
  return basename.slice(lastDot + 1);
};

const getFormatDefinition = (
  name: string
): ({ kind: AttachmentFormat['kind'] } & FileFormatDefinition) | undefined => {
  const basename = name.trim().toLowerCase().split(/[\\/]/).pop() || '';
  const extension = getExtension(basename);

  if (extension && IMAGE_FORMATS[extension]) {
    return { kind: 'image', ...IMAGE_FORMATS[extension] };
  }
  if (extension && FILE_FORMATS[extension]) {
    return { kind: 'file', ...FILE_FORMATS[extension] };
  }
  if (SUPPORTED_BASENAMES[basename]) {
    return { kind: 'file', ...SUPPORTED_BASENAMES[basename] };
  }
  return undefined;
};

export const getAttachmentFormat = (
  name: string,
  type: string
): AttachmentFormat => {
  const definition = getFormatDefinition(name);
  if (!definition) {
    throw new AttachmentValidationError(
      `"${name || 'Attachment'}" does not use a supported image or file extension.`
    );
  }

  const normalizedType = normalizeMimeType(type);
  const isUninformativeType = (
    normalizedType === '' ||
    normalizedType === 'application/octet-stream'
  );
  if (
    !isUninformativeType &&
    !definition.acceptedMimeTypes.includes(normalizedType)
  ) {
    throw new AttachmentValidationError(
      `"${name}" has MIME type "${type}", which does not match its supported format.`
    );
  }

  return {
    kind: definition.kind,
    mimeType: isUninformativeType ? definition.mimeType : normalizedType
  };
};

export const validateAttachments = (
  attachments: readonly AttachmentMetadata[]
): AttachmentFormat[] => {
  let totalBytes = 0;

  const formats = attachments.map(attachment => {
    if (
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0
    ) {
      throw new AttachmentValidationError(
        `"${attachment.name || 'Attachment'}" has an invalid size.`
      );
    }
    if (attachment.size >= MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `"${attachment.name || 'Attachment'}" must be smaller than 50 MB.`
      );
    }

    totalBytes += attachment.size;
    if (totalBytes >= MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        'Attachments must be smaller than 50 MB combined.'
      );
    }

    return getAttachmentFormat(attachment.name, attachment.type);
  });

  return formats;
};

export const getAttachmentMimeType = (
  attachment: Pick<AttachmentMetadata, 'name' | 'type'>
): string => getAttachmentFormat(attachment.name, attachment.type).mimeType;

export const isSupportedImageAttachment = (
  attachment: Pick<AttachmentMetadata, 'name' | 'type'>
): boolean => {
  try {
    return getAttachmentFormat(attachment.name, attachment.type).kind === 'image';
  } catch {
    return false;
  }
};

export const getDataUrlByteLength = (dataUrl: string): number => {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s);
  if (!match) {
    throw new AttachmentValidationError('Attachment content is not a valid data URL.');
  }

  const payload = match[2];
  const isBase64 = dataUrl.slice(0, dataUrl.indexOf(',')).toLowerCase().includes(';base64');
  if (!isBase64) {
    try {
      return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
    } catch {
      throw new AttachmentValidationError('Attachment content could not be decoded.');
    }
  }

  const normalizedPayload = payload.replace(/\s/g, '');
  if (
    normalizedPayload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedPayload)
  ) {
    throw new AttachmentValidationError('Attachment content is not valid base64 data.');
  }
  const padding = normalizedPayload.endsWith('==')
    ? 2
    : normalizedPayload.endsWith('=')
      ? 1
      : 0;
  return (normalizedPayload.length / 4) * 3 - padding;
};

export const ATTACHMENT_INPUT_ACCEPT = [
  ...Object.keys(IMAGE_FORMATS),
  ...Object.keys(FILE_FORMATS)
]
  .map(extension => `.${extension}`)
  .join(',');
