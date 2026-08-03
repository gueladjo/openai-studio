import { describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_SOURCE_UPLOADS,
  MAX_PROJECT_SOURCES,
  classifyProjectSource,
  validateProjectSourceFiles
} from './projectSources';

const fileMetadata = (
  name: string,
  size = 1,
  type = ''
): File => ({ name, size, type } as File);

describe('project source routing', () => {
  it.each([
    ['notes.md', 'file_search'],
    ['report.docx', 'file_search'],
    ['app.ts', 'file_search'],
    ['metrics.csv', 'code_interpreter'],
    ['workbook.xlsx', 'code_interpreter'],
    ['diagram.png', 'direct_attachment']
  ] as const)('classifies %s as %s', (name, capability) => {
    expect(classifyProjectSource({ name, type: '' })).toBe(capability);
  });

  it('enforces upload count, project count, and the strict per-file limit', () => {
    expect(() => validateProjectSourceFiles(
      Array.from(
        { length: MAX_PROJECT_SOURCE_UPLOADS + 1 },
        (_, index) => fileMetadata(`source-${index}.txt`)
      ),
      0
    )).toThrow(`at most ${MAX_PROJECT_SOURCE_UPLOADS}`);

    expect(() => validateProjectSourceFiles(
      [fileMetadata('last.txt')],
      MAX_PROJECT_SOURCES
    )).toThrow(`at most ${MAX_PROJECT_SOURCES}`);

    expect(() => validateProjectSourceFiles(
      [fileMetadata('large.pdf', 50 * 1024 * 1024, 'application/pdf')],
      0
    )).toThrow('smaller than 50 MB');
  });

  it('does not apply the composer combined-size limit to project uploads', () => {
    const files = [
      fileMetadata('first.pdf', 30 * 1024 * 1024, 'application/pdf'),
      fileMetadata('second.pdf', 30 * 1024 * 1024, 'application/pdf')
    ];

    expect(validateProjectSourceFiles(files, 0)).toEqual([
      { mimeType: 'application/pdf', capability: 'file_search' },
      { mimeType: 'application/pdf', capability: 'file_search' }
    ]);
  });
});
