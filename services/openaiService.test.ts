import { describe, expect, it } from 'vitest';
import type { ResponseOutputText } from 'openai/resources/responses/responses';
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
): ResponseOutputText.URLCitation => {
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
    '【unclosed marker',
    '\uE200cite\uE202turn0search0\uE201 ordinary prose \uE200cite\uE202turn0search1\uE201'
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

  it('preserves source label examples inside inline and fenced code', () => {
    const example = `(example.com) ${FIRST_MARKER}`;
    const text = `Keep \`${example}\` and:\n\n\`\`\`md\n${example}\n\`\`\``;
    expect(stripAdjacentCitationSourceLabels(text)).toBe(text);
  });
});

describe('applyCitationAnnotations', () => {
  it('never deletes prose between separate citation tokens in an annotation span', () => {
    const first = '\uE200cite\uE202turn0search0\uE201';
    const second = '\uE200cite\uE202turn0search1\uE201';
    const text = `Earlier ${first} There was **no comparison group**. ${second}`;

    const result = applyCitationAnnotations(
      text,
      [createAnnotation(text, `${first} There was **no comparison group**. ${second}`)],
      createRegistry()
    );

    expect(result).toContain('There was **no comparison group**.');
  });

  it.each([
    '## How I would place it in your routine',
    'Your current plan includes **extended support**.',
    '| Finding | Qualification |'
  ])('uses the existing source link instead of stale offsets in %j', (followingText) => {
    const text = `A finding. ([source](${FIRST_URL}))\n\n${followingText}`;
    // An apparently valid boundary can still be in unrelated prose or Markdown.
    const endIndex = text.indexOf(followingText) + followingText.indexOf(' ');
    const annotation = { ...createAnnotation(text, 'A finding.'), end_index: endIndex };

    expect(applyCitationAnnotations(text, [annotation], createRegistry())).toBe(
      `A finding. ${FIRST_MARKER}\n\n${followingText}`
    );
  });

  it('normalizes complete Markdown links with angle brackets and balanced URL parentheses', () => {
    const url = 'https://example.com/study_(overview)';
    const text = `See [study](<${url}>) and [details](${url}).`;
    const annotation = createAnnotation(text, 'See', url);

    expect(applyCitationAnnotations(text, [annotation], createRegistry())).toBe(
      `See [[1]](<${url}>) and [[1]](<${url}>).`
    );
  });

  it.each([
    '`[source](https://example.com/articles/first)`',
    '```md\n[source](https://example.com/articles/first)\n```',
    '![source](https://example.com/articles/first)',
    '[![Chart](https://example.com/chart.png)](https://example.com/articles/first)',
    '## A heading with several words',
    '**A bold phrase with several words**'
  ])('preserves protected Markdown when an annotation points into %j', (text) => {
    expect(applyCitationAnnotations(
      text,
      [createAnnotation(text, text.slice(0, text.length - 1))],
      createRegistry()
    )).toBe(text);
  });

  it.each([
    ['Your current plan includes **extended support**.', 'Your'],
    ['## How I would place it in your routine', '## How I would place it'],
    ['There was **no comparison group**, among other limitations.', 'There was **no comparison group'],
    ['The first sentence. The second sentence.', 'The first sentence. '],
    ['A sentence with 🧪 supplementary characters.', 'A sentence with \uD83E']
  ])('retains prose and sources when an offset ends after %j / %j', (text, span) => {
    const registry = createRegistry();
    expect(applyCitationAnnotations(text, [createAnnotation(text, span)], registry)).toBe(text);
    expect(registry.sources).toEqual([
      { kind: 'web', title: 'Example source', url: FIRST_URL }
    ]);
  });

  it('preserves whitespace around a replaced citation marker', () => {
    const text = 'First [1] next.';
    expect(applyCitationAnnotations(text, [createAnnotation(text, ' [1] ')], createRegistry()))
      .toBe(`First ${FIRST_MARKER} next.`);
  });

  it.each([
    ['The release is v1.2.', 'v1.2'],
    ['Use myexample.com for this.', 'example.com']
  ])('does not delete domain-like prose selected by a stale offset: %s', (text, span) => {
    expect(applyCitationAnnotations(text, [createAnnotation(text, span)], createRegistry())).toBe(text);
  });

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
      { kind: 'web', title: 'Cat facts', url: FIRST_URL }
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
      { kind: 'web', title: 'Example source', url: FIRST_URL },
      { kind: 'web', title: 'Second source', url: SECOND_URL }
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

  it('does not insert a citation inside a word when an annotation endpoint is unsafe', () => {
    const text = 'Your employee options have approximately $20,769 of intrinsic value.';
    const endIndex = text.indexOf('have') + 'hav'.length;
    const registry = createRegistry();

    expect(applyCitationAnnotations(
      text,
      [{
        type: 'url_citation',
        start_index: 0,
        end_index: endIndex,
        title: 'StockAnalysis',
        url: FIRST_URL
      }],
      registry
    )).toBe(text);
    expect(registry.sources).toEqual([
      { kind: 'web', title: 'StockAnalysis', url: FIRST_URL }
    ]);
  });

  it.each(['before', 'inside'] as const)(
    'does not insert a citation %s Markdown delimiter characters',
    (position) => {
      const text = 'I used **FXAIX return** for the estimate.';
      const endIndex = text.indexOf('**') + (position === 'inside' ? 1 : 0);

      expect(applyCitationAnnotations(
        text,
        [{
          type: 'url_citation',
          start_index: 0,
          end_index: endIndex,
          title: 'StockAnalysis',
          url: FIRST_URL
        }],
        createRegistry()
      )).toBe(text);
    }
  );

  it('normalizes a matching Markdown source link when its annotation endpoint is unsafe', () => {
    const text = [
      `The quote was $78.25. ([stockanalysis.com](${FIRST_URL}))`,
      '',
      'Your **2,040 NFLX employee options** have approximately $20,769 of intrinsic value.'
    ].join('\n');
    const endIndex = text.indexOf('have') + 'hav'.length;

    expect(applyCitationAnnotations(
      text,
      [{
        type: 'url_citation',
        start_index: 0,
        end_index: endIndex,
        title: 'StockAnalysis',
        url: FIRST_URL
      }],
      createRegistry()
    )).toBe([
      `The quote was $78.25. ${FIRST_MARKER}`,
      '',
      'Your **2,040 NFLX employee options** have approximately $20,769 of intrinsic value.'
    ].join('\n'));
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
