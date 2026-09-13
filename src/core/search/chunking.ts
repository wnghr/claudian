/**
 * Markdown chunking for the paper search index.
 *
 * The locator a chunk carries is what the model cites, so two rules are
 * non-negotiable:
 *
 * 1. **A chunk must lie on one page.** In a page-anchored file the buffer is
 *    flushed whenever the page changes, so a page locator is exact. Merging
 *    several pages into one chunk and citing it as a range is how a citation
 *    stops being checkable.
 * 2. **Line endings must not change the result.** Papers parsed on Windows are
 *    CRLF, and a heading written as `/^(#+)\s+(.*)$/` silently matches nothing
 *    there — which used to collapse a whole document into one unanchored chunk.
 *
 * Chunks with no page anchor fall back to a line range, split on paragraph
 * boundaries so each part gets its own narrow range rather than a shared one.
 */

import { splitFrontmatter } from '../text/frontmatter';

// Re-exported: existing importers (tests, probes) read it from here.
export { splitFrontmatter };

export type MarkdownChunkKind = 'meta' | 'md';

/** A logical line carried through paragraph grouping with its 1-based number. */
interface BufferedLine {
  readonly text: string;
  readonly number: number;
}

/** Consecutive non-blank lines; the unit paragraphs group by. */
interface Paragraph {
  readonly lines: readonly BufferedLine[];
}

export interface MarkdownChunk {
  readonly kind: MarkdownChunkKind;
  readonly heading: string;
  readonly locator: string;
  readonly body: string;
}

/** Chunks larger than this are split on paragraph boundaries. */
export const MAX_CHUNK_CHARS = 1300;
/** Chunks smaller than this are boilerplate (page furniture) and are dropped. */
export const MIN_CHUNK_CHARS = 20;

export const PAGE_MARK_PATTERN = /^\s*<!--\s*p\.(\d+)\s*-->\s*$/u;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/u;

/**
 * Frontmatter keys worth indexing. `id` is this vault's citekey field, so
 * without it a card cannot be found by its own citekey.
 */
const INDEXED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'title', 'id', 'citekey', 'aliases', 'tags',
  'author', 'authors', 'year', 'container-title', 'DOI', 'doi', 'status',
]);

function toParagraphs(lines: readonly BufferedLine[]): readonly Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: BufferedLine[] = [];
  for (const line of lines) {
    if (line.text.trim().length === 0) {
      if (current.length > 0) {
        paragraphs.push({ lines: current });
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) paragraphs.push({ lines: current });
  return paragraphs;
}

function paragraphLength(paragraph: Paragraph): number {
  return paragraph.lines.reduce((sum, line) => sum + line.text.length + 1, 0);
}

function groupParagraphs(paragraphs: readonly Paragraph[]): readonly (readonly Paragraph[])[] {
  const total = paragraphs.reduce((sum, paragraph) => sum + paragraphLength(paragraph) + 2, 0);
  if (total <= MAX_CHUNK_CHARS) return paragraphs.length > 0 ? [paragraphs] : [];

  const groups: Paragraph[][] = [];
  let current: Paragraph[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    const size = paragraphLength(paragraph);
    if (current.length > 0 && length + size > MAX_CHUNK_CHARS) {
      groups.push(current);
      current = [paragraph];
      length = size;
    } else {
      current.push(paragraph);
      length += size;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildMetaChunk(
  frontmatter: Readonly<Record<string, string | readonly string[]>>,
): MarkdownChunk | null {
  const lines: string[] = [];
  // Document order, so the metadata chunk reads like the card it came from.
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!INDEXED_FRONTMATTER_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      if (value.length > 0) lines.push(`${key}: ${value}`);
      continue;
    }
    if (value.length > 0) lines.push(`${key}: ${value.join(' ')}`);
  }
  if (lines.length === 0) return null;
  return { body: lines.join('\n'), heading: '元数据', kind: 'meta', locator: 'frontmatter' };
}

function headingOf(stack: readonly (readonly [number, string])[]): string {
  return stack.map(entry => entry[1]).join(' > ');
}

/**
 * Splits a Markdown document into citable chunks. `relpath` only supplies the
 * fallback heading, so a heading-less note is still attributable to its file.
 */
export function chunkMarkdown(text: string, relpath: string): readonly MarkdownChunk[] {
  const { frontmatter, body } = splitFrontmatter(text);
  const chunks: MarkdownChunk[] = [];

  const meta = buildMetaChunk(frontmatter);
  if (meta) chunks.push(meta);

  const fallbackHeading = relpath.split('/').pop()?.replace(/\.md$/iu, '') ?? relpath;
  // Normalized line endings keep line numbers and every pattern CRLF-proof.
  const lines = body.replace(/\r\n?/gu, '\n').split('\n');
  const stack: [number, string][] = [];
  let currentHeading = '';
  let buffer: BufferedLine[] = [];
  let currentPage: number | null = null;
  let bufferPage: number | null = null;

  const flush = (endLine: number): void => {
    const paragraphs = toParagraphs(buffer);
    if (paragraphs.length > 0) {
      const groups = groupParagraphs(paragraphs);
      for (const [index, group] of groups.entries()) {
        const first = group[0].lines[0].number;
        const last = group[group.length - 1].lines[group[group.length - 1].lines.length - 1].number;
        // A page-anchored chunk never spans pages, so the page is exact.
        const base = bufferPage !== null ? `p.${bufferPage}` : `L${first}-${last}`;
        const locator = groups.length > 1 ? `${base}#${index + 1}` : base;
        const body = group
          .map(paragraph => paragraph.lines.map(line => line.text).join('\n').trim())
          .filter(Boolean)
          .join('\n\n');
        if (body.length < MIN_CHUNK_CHARS) continue;
        chunks.push({
          body,
          heading: currentHeading || fallbackHeading,
          kind: 'md',
          locator,
        });
      }
    }
    buffer = [];
    bufferPage = null;
  };

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const pageMark = PAGE_MARK_PATTERN.exec(rawLine);
    if (pageMark) {
      // Close the previous page first, while `currentPage` still describes it.
      flush(lineNumber - 1);
      currentPage = Number.parseInt(pageMark[1], 10);
      continue; // the marker itself is never part of a chunk
    }

    const heading = HEADING_PATTERN.exec(rawLine);
    if (heading) {
      flush(lineNumber - 1);
      const level = heading[1].length;
      while (stack.length > 0 && stack[stack.length - 1][0] >= level) stack.pop();
      stack.push([level, heading[2].trim()]);
      currentHeading = headingOf(stack);
      buffer = [];
      continue;
    }

    if (buffer.length === 0) bufferPage = currentPage;
    buffer.push({ number: lineNumber, text: rawLine });
  }
  flush(lines.length);

  return chunks;
}
