import { describe, expect, it } from 'vitest';
import {
  AttachmentValidationError,
  getAttachmentFormat,
  getDataUrlByteLength,
  MAX_ATTACHMENT_BYTES,
  validateAttachments
} from './attachmentValidation';

describe('attachment validation', () => {
  it('accepts supported image, document, and code formats', () => {
    expect(getAttachmentFormat('photo.JPEG', 'image/jpeg')).toEqual({
      kind: 'image',
      mimeType: 'image/jpeg'
    });
    expect(getAttachmentFormat('report.docx', '')).toEqual({
      kind: 'file',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    expect(getAttachmentFormat('component.tsx', 'text/tsx')).toEqual({
      kind: 'file',
      mimeType: 'text/tsx'
    });
  });

  it('rejects unsupported extensions and mismatched MIME types', () => {
    expect(() => getAttachmentFormat('payload.exe', 'application/octet-stream'))
      .toThrow(AttachmentValidationError);
    expect(() => getAttachmentFormat('photo.png', 'application/pdf'))
      .toThrow('does not match its supported format');
    expect(() => getAttachmentFormat('report.pdf', 'image/png'))
      .toThrow('does not match its supported format');
  });

  it('enforces strict per-file and combined 50 MB limits', () => {
    expect(() => validateAttachments([{
      name: 'report.pdf',
      type: 'application/pdf',
      size: MAX_ATTACHMENT_BYTES
    }])).toThrow('must be smaller than 50 MB');

    expect(() => validateAttachments([
      {
        name: 'first.pdf',
        type: 'application/pdf',
        size: 30 * 1024 * 1024
      },
      {
        name: 'second.pdf',
        type: 'application/pdf',
        size: 20 * 1024 * 1024
      }
    ])).toThrow('smaller than 50 MB combined');

    expect(() => validateAttachments([
      {
        name: 'first.pdf',
        type: 'application/pdf',
        size: 30 * 1024 * 1024
      },
      {
        name: 'second.pdf',
        type: 'application/pdf',
        size: 19 * 1024 * 1024
      }
    ])).not.toThrow();
  });

  it('measures base64 and percent-encoded data URLs without decoding them to blobs', () => {
    expect(getDataUrlByteLength('data:text/plain;base64,SGVsbG8=')).toBe(5);
    expect(getDataUrlByteLength('data:text/plain,Hello%20world')).toBe(11);
    expect(() => getDataUrlByteLength('not-a-data-url')).toThrow('valid data URL');
  });
});
