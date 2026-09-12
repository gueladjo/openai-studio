const escapeDollarSigns = (value: string): string => (
  value.replace(/(?<!\\)\$/g, '\\$')
);

const normalizePlainMarkdown = (value: string): string => (
  value
    .replace(
      /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,
      (_match, math: string) => `\n\n$$\n${escapeDollarSigns(math).trim()}\n$$\n\n`
    )
    .replace(
      /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g,
      (_match, math: string) => `$${escapeDollarSigns(math)}$`
    )
);

const countRun = (value: string, start: number, character: string): number => {
  let end = start;
  while (value[end] === character) end += 1;
  return end - start;
};

const findClosingFence = (
  markdown: string,
  searchStart: number,
  marker: string,
  minimumLength: number
): number => {
  let lineStart = searchStart;

  while (lineStart < markdown.length) {
    const lineEnd = markdown.indexOf('\n', lineStart);
    const contentEnd = lineEnd === -1 ? markdown.length : lineEnd;
    const line = markdown.slice(lineStart, contentEnd);
    const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/);

    if (match && match[1][0] === marker && match[1].length >= minimumLength) {
      return lineEnd === -1 ? markdown.length : lineEnd + 1;
    }

    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  return markdown.length;
};

/**
 * Converts TeX's \(...\) and \[...\] delimiters into remark-math syntax.
 * Markdown code spans and fenced code blocks are deliberately left untouched.
 */
export const normalizeMarkdownMath = (markdown: string): string => {
  let output = '';
  let plainStart = 0;
  let index = 0;

  while (index < markdown.length) {
    const lineStart = index === 0 || markdown[index - 1] === '\n';

    if (lineStart) {
      let markerStart = index;
      while (markerStart < index + 3 && markdown[markerStart] === ' ') {
        markerStart += 1;
      }
      const marker = markdown[markerStart];
      const markerLength = marker === '`' || marker === '~'
        ? countRun(markdown, markerStart, marker)
        : 0;

      if (markerLength >= 3) {
        const openingLineEnd = markdown.indexOf('\n', markerStart + markerLength);
        const fenceEnd = openingLineEnd === -1
          ? markdown.length
          : findClosingFence(markdown, openingLineEnd + 1, marker, markerLength);
        output += normalizePlainMarkdown(markdown.slice(plainStart, index));
        output += markdown.slice(index, fenceEnd);
        index = fenceEnd;
        plainStart = fenceEnd;
        continue;
      }
    }

    if (markdown[index] === '`') {
      const delimiterLength = countRun(markdown, index, '`');
      const delimiter = '`'.repeat(delimiterLength);
      const closingIndex = markdown.indexOf(delimiter, index + delimiterLength);

      if (closingIndex !== -1) {
        const codeEnd = closingIndex + delimiterLength;
        output += normalizePlainMarkdown(markdown.slice(plainStart, index));
        output += markdown.slice(index, codeEnd);
        index = codeEnd;
        plainStart = codeEnd;
        continue;
      }
    }

    index += 1;
  }

  return output + normalizePlainMarkdown(markdown.slice(plainStart));
};
