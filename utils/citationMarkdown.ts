import type { Root, RootContent } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

interface Span {
  startIndex: number;
  endIndex: number;
}

interface MarkdownLink extends Span {
  url: string;
  title: string;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const literalTypes = new Set([
  'code', 'inlineCode', 'html', 'image', 'imageReference', 'definition',
  'math', 'inlineMath'
]);
const formattedTypes = new Set(['heading', 'strong', 'emphasis', 'delete', 'table']);

/** Inspect source offsets without serializing (and thereby rewriting) the Markdown. */
export const inspectCitationMarkdown = (markdown: string) => {
  const root = parser.parse(markdown);
  const links: MarkdownLink[] = [];
  const literals: Span[] = [];
  const textSpans: Span[] = [];
  const insertionSpans: Span[] = [];
  const paragraphEnds = new Set<number>();
  const definitions = new Map(root.children.flatMap(node => (
    node.type === 'definition' ? [[node.identifier, node.url] as const] : []
  )));

  const visit = (node: Root | RootContent, formatted = false): void => {
    const startIndex = node.position?.start.offset;
    const endIndex = node.position?.end.offset;
    if (startIndex === undefined || endIndex === undefined) return;
    const span = { startIndex, endIndex };

    if (literalTypes.has(node.type)) {
      literals.push(span);
      return;
    }
    if (node.type === 'link' || node.type === 'linkReference') {
      if (node.children.some(child => literalTypes.has(child.type))) {
        literals.push(span);
        return;
      }
      const url = node.type === 'link' ? node.url : definitions.get(node.identifier);
      if (url && /^https?:\/\//i.test(url)) {
        links.push({
          ...span,
          url,
          title: node.children.map(child => ('value' in child ? child.value : '')).join('')
        });
      }
      return;
    }
    const insideFormatting = formatted || formattedTypes.has(node.type);
    if (node.type === 'paragraph' && !insideFormatting) paragraphEnds.add(endIndex);
    if (node.type === 'text') {
      textSpans.push(span);
      if (!insideFormatting) insertionSpans.push(span);
    }
    if ('children' in node) node.children.forEach(child => visit(child, insideFormatting));
  };
  visit(root);

  return {
    links,
    literals,
    canReplaceMarker: (start: number, end: number): boolean => (
      textSpans.some(span => start >= span.startIndex && end <= span.endIndex) ||
      links.some(span => start === span.startIndex && end === span.endIndex)
    ),
    canAppendCitation: (index: number): boolean => {
      if (paragraphEnds.has(index)) return true;
      if (!insertionSpans.some(span => index > span.startIndex && index <= span.endIndex)) {
        return false;
      }
      // Stale offsets can land at perfectly valid word boundaries. Only insert
      // at sentence/paragraph ends, never in a heading, word, link, or delimiter.
      return /^[.!?](?:\s|$)/.test(markdown.slice(index, index + 2)) ||
        (/[.!?]/.test(markdown[index - 1]) && /\s/.test(markdown[index] || ''));
    }
  };
};

export const transformOutsideMarkdownLiterals = (
  markdown: string,
  transform: (text: string) => string
): string => {
  let result = '';
  let cursor = 0;
  for (const span of inspectCitationMarkdown(markdown).literals) {
    result += transform(markdown.slice(cursor, span.startIndex));
    result += markdown.slice(span.startIndex, span.endIndex);
    cursor = span.endIndex;
  }
  return result + transform(markdown.slice(cursor));
};
