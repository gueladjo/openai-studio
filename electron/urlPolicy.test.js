import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl, isSameAppDocument } from './urlPolicy.js';

describe('isSafeExternalUrl', () => {
  it('allows HTTP and HTTPS URLs', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:3000')).toBe(true);
  });

  it('rejects local, executable, relative, and malformed URLs', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('/etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('not a URL')).toBe(false);
  });
});

describe('isSameAppDocument', () => {
  const appUrl = 'file:///opt/OpenAI%20Studio/dist/index.html';

  it('allows the exact app document and its fragments', () => {
    expect(isSameAppDocument(appUrl, appUrl)).toBe(true);
    expect(isSameAppDocument(`${appUrl}#settings`, appUrl)).toBe(true);
  });

  it('rejects other local files and URLs that merely share a prefix', () => {
    expect(isSameAppDocument('file:///etc/passwd', appUrl)).toBe(false);
    expect(isSameAppDocument(`${appUrl}.backup`, appUrl)).toBe(false);
    expect(isSameAppDocument('https://example.com', appUrl)).toBe(false);
  });
});
