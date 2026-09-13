import type {
  PaperReadRequest,
  PaperReadResult,
} from '../../../core/paper/PaperRead';
import type { PaperContentResolver } from './PaperContentResolver';

const DEFAULT_MAX_CHARS = 12_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 50_000;
const PAGE_MARKER = /^\s*<!--\s*p\.(\d+)\s*-->\s*$/gm;

interface SelectedContent {
  readonly content: string;
  readonly selection: string;
}

function clampMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CHARS;
  return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, Math.floor(value)));
}

function parsePageRange(value: string): { start: number; end: number } {
  const match = value.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!match) throw new Error('pages must be a page number or range such as 3 or 3-5.');
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (start < 1 || end < start || end - start > 50) {
    throw new Error('pages must be an ascending range of at most 51 pages.');
  }
  return { end, start };
}

function selectPages(content: string, pages: string): SelectedContent {
  const range = parsePageRange(pages);
  const markers = [...content.matchAll(PAGE_MARKER)];
  if (markers.length === 0) {
    throw new Error('This cache has no page anchors. Read by section/query or inspect the PDF visually.');
  }
  const selected: string[] = [];
  for (let index = 0; index < markers.length; index++) {
    const page = Number(markers[index][1]);
    if (page < range.start || page > range.end) continue;
    const start = markers[index].index ?? 0;
    const end = markers[index + 1]?.index ?? content.length;
    selected.push(content.slice(start, end).trim());
  }
  if (selected.length === 0) {
    throw new Error(`The cache has no content for pages ${pages}.`);
  }
  return {
    content: selected.join('\n\n'),
    selection: range.start === range.end ? `p.${range.start}` : `p.${range.start}-p.${range.end}`,
  };
}

function selectSection(content: string, section: string): SelectedContent {
  const wanted = section.trim().toLocaleLowerCase();
  if (!wanted) throw new Error('section cannot be empty.');
  const headings = [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const index = headings.findIndex(match => match[2].trim().toLocaleLowerCase().includes(wanted));
  if (index < 0) throw new Error(`No cached section matches "${section}".`);
  const heading = headings[index];
  const level = heading[1].length;
  const start = heading.index ?? 0;
  let end = content.length;
  for (const candidate of headings.slice(index + 1)) {
    if (candidate[1].length <= level) {
      end = candidate.index ?? content.length;
      break;
    }
  }
  return {
    content: content.slice(start, end).trim(),
    selection: `section: ${heading[2].trim()}`,
  };
}

function queryTerms(query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) throw new Error('query cannot be empty.');
  const words = normalized.match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
  const hanRuns = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  const hanTerms = hanRuns.flatMap(run => run.length <= 2
    ? [run]
    : [...run].slice(0, -1).map((char, index) => char + run[index + 1]));
  return [...new Set([...words, ...hanTerms])];
}

function selectQuery(content: string, query: string): SelectedContent {
  const terms = queryTerms(query);
  const blocks = content.split(/\n\s*\n/).map((text, index) => ({ index, text: text.trim() }))
    .filter(block => block.text.length > 0);
  const ranked = blocks.map(block => {
    const lower = block.text.toLocaleLowerCase();
    const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
    return { ...block, score };
  }).filter(block => block.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 8)
    .sort((left, right) => left.index - right.index);
  if (ranked.length === 0) throw new Error(`No cached passage matches "${query}".`);
  return {
    content: ranked.map(block => block.text).join('\n\n'),
    selection: `query: ${query.trim()}`,
  };
}

export class PaperReader {
  constructor(private readonly resolver: PaperContentResolver) {}

  async read(request: PaperReadRequest): Promise<PaperReadResult> {
    const selectors = [request.pages, request.section, request.query]
      .filter(value => value !== undefined);
    if (selectors.length > 1) {
      throw new Error('Use only one of pages, section, or query per read_pdf call.');
    }
    const resolved = await this.resolver.resolve(request.sourcePath, {
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    if (resolved.status !== 'ready' || !resolved.content || !resolved.cachePath) {
      throw new Error(resolved.reason ?? `Cannot read cached PDF content: ${resolved.status}.`);
    }
    const selected = request.pages
      ? selectPages(resolved.content, request.pages)
      : request.section
        ? selectSection(resolved.content, request.section)
        : request.query
          ? selectQuery(resolved.content, request.query)
          : { content: resolved.content, selection: 'beginning of paper' };
    const maxChars = clampMaxChars(request.maxChars);
    const truncated = selected.content.length > maxChars;
    return {
      cachePath: resolved.cachePath,
      content: truncated ? selected.content.slice(0, maxChars) : selected.content,
      selection: selected.selection,
      sourcePath: resolved.sourcePath,
      truncated,
    };
  }
}
