import { describe, expect, it } from 'vitest';
import {
  applyCitationAnnotations,
  isCitationMarkerSpan,
  stripAdjacentCitationSourceLabels,
  type CitationRegistry
} from './openaiService';

const FIRST_URL = 'https://example.com/articles/first';
const SECOND_URL = 'https://docs.example.org/second';
const FIRST_MARKER = `[[1]](<${FIRST_URL}>)`;

const createRegistry = (): CitationRegistry => ({
  sources: [],
  sourceIndexByUrl: new Map<string, number>()
});

const createAnnotation = (
  text: string,
  span: string,
  url = FIRST_URL,
  title = 'Example source'
) => {
  const startIndex = text.indexOf(span);

  if (startIndex === -1) {
    throw new Error(`Citation span not found: ${span}`);
  }

  return {
    type: 'url_citation',
    start_index: startIndex,
    end_index: startIndex + span.length,
    title,
    url
  };
};

describe('isCitationMarkerSpan', () => {
  it.each([
    '【turn0search0】',
    '\uE200cite\uE202turn0search0\uE201',
    '[1]',
    ' [1, 3-5] ',
    'example.com',
    '(https://www.example.com/articles/1)',
    '[docs.example.co.uk]'
  ])('recognizes citation marker %j', (marker) => {
    expect(isCitationMarkerSpan(marker)).toBe(true);
  });

  it.each([
    '',
    'ordinary prose',
    '[source]',
    'example',
    'https://example dot com',
    '【unclosed marker'
  ])('rejects non-marker text %j', (text) => {
    expect(isCitationMarkerSpan(text)).toBe(false);
  });
});

describe('stripAdjacentCitationSourceLabels', () => {
  it.each([
    {
      content: `Claim (example.com) ${FIRST_MARKER}.`,
      expected: `Claim ${FIRST_MARKER}.`
    },
    {
      content: `Claim ${FIRST_MARKER} (https://www.example.com/articles/first).`,
      expected: `Claim ${FIRST_MARKER}.`
    },
    {
      content: `Claim ([example.com] ${FIRST_MARKER}).`,
      expected: `Claim ${FIRST_MARKER}.`
    },
    {
      content: `Claim (example.com, [docs.example.org] ${FIRST_MARKER}).`,
      expected: `Claim ${FIRST_MARKER}.`
    }
  ])('removes redundant source labels from $content', ({ content, expected }) => {
    expect(stripAdjacentCitationSourceLabels(content)).toBe(expected);
  });

  it('preserves nearby parenthetical prose', () => {
    const content = `Claim (from a recent survey) ${FIRST_MARKER} (reviewed independently).`;

    expect(stripAdjacentCitationSourceLabels(content)).toBe(content);
  });
});

describe('applyCitationAnnotations', () => {
  it('appends a Markdown citation to an annotated prose span', () => {
    const text = 'Cats are mammals.';
    const registry = createRegistry();

    const result = applyCitationAnnotations(
      text,
      [createAnnotation(text, 'Cats are mammals', FIRST_URL, 'Cat facts')],
      registry
    );

    expect(result).toBe(`Cats are mammals${FIRST_MARKER}.`);
    expect(registry.sources).toEqual([
      { title: 'Cat facts', url: FIRST_URL }
    ]);
    expect(registry.sourceIndexByUrl).toEqual(new Map([[FIRST_URL, 1]]));
  });

  it.each([
    '【turn0search0】',
    '\uE200cite\uE202turn0search0\uE201',
    '[1]',
    'example.com',
    '(example.com)'
  ])('replaces an annotated marker span %j instead of appending to it', (span) => {
    const text = `Claim ${span}.`;
    const registry = createRegistry();

    expect(applyCitationAnnotations(
      text,
      [createAnnotation(text, span)],
      registry
    )).toBe(`Claim ${FIRST_MARKER}.`);
  });

  it('combines distinct sources for the same annotation span', () => {
    const span = '【turn0search0】';
    const text = `Claim ${span}.`;
    const registry = createRegistry();
    const firstAnnotation = createAnnotation(text, span);

    const result = applyCitationAnnotations(
      text,
      [
        firstAnnotation,
        createAnnotation(text, span, SECOND_URL, 'Second source'),
        firstAnnotation
      ],
      registry
    );

    expect(result).toBe(
      `Claim ${FIRST_MARKER} [[2]](<${SECOND_URL}>).`
    );
    expect(registry.sources).toEqual([
      { title: 'Example source', url: FIRST_URL },
      { title: 'Second source', url: SECOND_URL }
    ]);
  });

  it('sorts annotation spans and reuses citation numbers across them', () => {
    const firstSpan = '【turn0search0】';
    const secondSpan = '【turn0search1】';
    const text = `First ${firstSpan}; second ${secondSpan}.`;
    const registry = createRegistry();

    const result = applyCitationAnnotations(
      text,
      [
        createAnnotation(text, secondSpan),
        createAnnotation(text, firstSpan)
      ],
      registry
    );

    expect(result).toBe(`First ${FIRST_MARKER}; second ${FIRST_MARKER}.`);
    expect(registry.sources).toHaveLength(1);
  });

  it('removes a source label left adjacent to a replaced marker', () => {
    const span = '【turn0search0】';
    const text = `Claim (example.com) ${span}.`;

    expect(applyCitationAnnotations(
      text,
      [createAnnotation(text, span)],
      createRegistry()
    )).toBe(`Claim ${FIRST_MARKER}.`);
  });

  it('ignores malformed and unsupported annotations without mutating the registry', () => {
    const text = 'Unchanged text.';
    const registry = createRegistry();

    const result = applyCitationAnnotations(
      text,
      [
        { type: 'file_citation', start_index: 0, end_index: 9, url: FIRST_URL },
        { type: 'url_citation', start_index: -1, end_index: 9, url: FIRST_URL },
        { type: 'url_citation', start_index: 0, end_index: text.length + 1, url: FIRST_URL },
        { type: 'url_citation', start_index: 0.5, end_index: 9, url: FIRST_URL },
        { type: 'url_citation', start_index: 9, end_index: 9, url: FIRST_URL }
      ],
      registry
    );

    expect(result).toBe(text);
    expect(registry.sources).toEqual([]);
    expect(registry.sourceIndexByUrl.size).toBe(0);
  });
});
