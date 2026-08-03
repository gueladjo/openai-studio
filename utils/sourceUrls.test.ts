import { describe, expect, it, vi } from 'vitest';
import {
  createSourceRecord,
  getSourcePresentation,
  parseSourceUrl
} from './sourceUrls';

describe('source URL safety', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/source.html',
    'mailto:person@example.com',
    '/relative/path',
    '//example.com/protocol-relative',
    'not a URL'
  ])('does not make unsafe or malformed URL %j clickable', (url) => {
    expect(parseSourceUrl(url)).toBeNull();
    expect(getSourcePresentation({ kind: 'web', title: 'Source', url }).href).toBeNull();
  });

  it('normalizes safe HTTP URLs for presentation', () => {
    expect(getSourcePresentation({
      kind: 'web',
      title: '  ',
      url: ' https://docs.example.com/path?q=1 '
    })).toEqual({
      href: 'https://docs.example.com/path?q=1',
      hostname: 'docs.example.com',
      label: 'docs.example.com',
      rawUrl: 'https://docs.example.com/path?q=1'
    });
  });

  it('retains an invalid source as inert text and reports its context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const source = createSourceRecord(
      '',
      ' javascript:alert(1) ',
      'Web Search source'
    );

    expect(source).toEqual({
      kind: 'web',
      title: 'javascript:alert(1)',
      url: 'javascript:alert(1)'
    });
    expect(source && getSourcePresentation(source).href).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'Web Search source: invalid source URL',
      'javascript:alert(1)'
    );
    warn.mockRestore();
  });
});
