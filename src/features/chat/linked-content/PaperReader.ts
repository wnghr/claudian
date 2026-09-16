import type {
  PaperReadFidelity,
  PaperReadImage,
  PaperReadPagePosition,
  PaperReadRequest,
  PaperReadResult,
} from '../../../core/paper/PaperRead';
import { PAGE_ANCHOR_PATTERN, type PaperCacheManifest } from './PaperCachePackage';
import type { PaperContentResolver } from './PaperContentResolver';
import type { ZotFlowPageContent } from './ZotFlowLocator';
import { renderZotFlowPage } from './ZotFlowPageContent';

const DEFAULT_MAX_CHARS = 12_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 50_000;
const CURRENT_PAGE_SELECTOR = 'current';

interface SelectedContent {
  readonly content: string;
  readonly selection: string;
}

export interface PaperReaderOptions {
  /**
   * Where the reader currently is for this source, so `pages: "current"` can be
   * answered. Supplied by the host because it depends on ZotFlow/Zotero state.
   */
  readonly resolveCurrentPage?: (sourcePath: string) => Promise<PaperReadPagePosition | null>;
}

type PageReader = (pageIndex: number) => Promise<ZotFlowPageContent | null>;
type PageImageReader = (pageIndex: number, scale?: number) => Promise<{
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly dataUrl: string;
} | null>;

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

function selectPages(content: string, pages: string, pageCount?: number): SelectedContent {
  const range = parsePageRange(pages);
  if (pageCount !== undefined && range.start > pageCount) {
    throw new Error(
      `Page ${range.start} is beyond the readable text, which covers ${pageCount} pages. `
      + 'The rest of this attachment has no extracted text to read.',
    );
  }
  const markers = [...content.matchAll(PAGE_ANCHOR_PATTERN)];
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
    throw new Error(
      pageCount === undefined
        ? `The cache has no content for pages ${pages}.`
        : `The cache has no content for pages ${pages}; it covers ${pageCount} pages.`,
    );
  }
  return {
    content: selected.join('\n\n'),
    selection: range.start === range.end ? `p.${range.start}` : `p.${range.start}-p.${range.end}`,
  };
}

function selectSection(
  content: string,
  section: string,
  manifest?: PaperCacheManifest,
): SelectedContent {
  const wanted = section.trim().toLocaleLowerCase();
  if (!wanted) throw new Error('section cannot be empty.');
  const indexed = manifest?.sections?.find(candidate => (
    candidate.heading.toLocaleLowerCase().includes(wanted)
  ));
  if (indexed) {
    const start = Math.max(0, Math.min(content.length, indexed.charStart));
    const end = Math.max(start, Math.min(content.length, indexed.charEnd));
    return {
      content: content.slice(start, end).trim(),
      selection: `section: ${indexed.heading}`,
    };
  }
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
  constructor(
    private readonly resolver: PaperContentResolver,
    private readonly options: PaperReaderOptions = {},
  ) {}

  /** `sourcePath` must already be resolved; see `ZotFlowLocator`. */
  async read(
    request: PaperReadRequest & { readonly sourcePath: string },
    pageReader?: PageReader,
    pageImageReader?: PageImageReader,
  ): Promise<PaperReadResult> {
    const selectors = [request.pages, request.section, request.query]
      .filter(value => value !== undefined);
    if (selectors.length > 1) {
      throw new Error('Use only one of pages, section, or query per read_pdf call.');
    }

    const currentPage = (await this.options.resolveCurrentPage?.(request.sourcePath)) ?? undefined;
    const readerPages = this.resolvePagesSelector(request.pages, currentPage);
    if (pageReader && readerPages) {
      const selected = await this.readReaderPages(readerPages, pageReader);
      if (selected) {
        const maxChars = clampMaxChars(request.maxChars);
        const truncated = selected.content.length > maxChars;
        const images = request.includeImages && pageImageReader
          ? (await Promise.all(selected.pageIndexes.map(index => pageImageReader(index, 1.25))))
            .filter((image): image is NonNullable<Awaited<ReturnType<PageImageReader>>> => image !== null)
            .map(image => ({ page: image.pageIndex + 1, width: image.width, height: image.height, dataUrl: image.dataUrl } satisfies PaperReadImage))
          : [];
        return {
          content: truncated ? selected.content.slice(0, maxChars) : selected.content,
          fidelity: 'zotflow-reader',
          ...(currentPage ? { currentPage } : {}),
          ...(selected.pageCount !== null ? { pageCount: selected.pageCount } : {}),
          selection: selected.selection,
          sourcePath: request.sourcePath,
          truncated,
          ...(images.length > 0 ? { images } : {}),
          warnings: [],
        };
      }
    }

    const resolved = await this.resolver.resolve(request.sourcePath, {
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    if (resolved.status !== 'ready' || !resolved.content) {
      throw new Error(resolved.reason ?? `Cannot read PDF content: ${resolved.status}.`);
    }

    const fidelity: PaperReadFidelity = resolved.fidelity ?? 'mineru-md';
    const warnings = [...(resolved.warnings ?? [])];
    if ((fidelity === 'zotero-fulltext' || fidelity === 'pdf-direct') && request.section) {
      throw new Error(
        'Section headings are not available for this attachment: its text comes from a plain-text '
        + 'PDF extraction, which has no headings. Read specific pages or use a query instead.',
      );
    }

    // The first lookup already used the requested source path. Avoid a second
    // read when the resolver keeps that same identity; fallback sources may
    // still have a different canonical path and need their own position.
    const resolvedCurrentPage = resolved.sourcePath === request.sourcePath
      ? currentPage
      : (await this.options.resolveCurrentPage?.(resolved.sourcePath)) ?? currentPage;
    if (
      resolvedCurrentPage
      && resolved.pageCount !== undefined
      && resolvedCurrentPage.page > resolved.pageCount
    ) {
      warnings.push(
        `The reader is on page ${resolvedCurrentPage.page}, but the readable text stops at page ${resolved.pageCount}.`,
      );
    }

    const pages = this.resolvePagesSelector(request.pages, resolvedCurrentPage);
    const selected = pages
      ? selectPages(resolved.content, pages, resolved.pageCount)
      : request.section
        ? selectSection(resolved.content, request.section, resolved.manifest)
        : request.query
          ? selectQuery(resolved.content, request.query)
          : { content: resolved.content, selection: 'beginning of paper' };

    const maxChars = clampMaxChars(request.maxChars);
    const truncated = selected.content.length > maxChars;
    return {
      ...(resolved.cachePath ? { cachePath: resolved.cachePath } : {}),
      content: truncated ? selected.content.slice(0, maxChars) : selected.content,
      fidelity,
      ...(resolvedCurrentPage ? { currentPage: resolvedCurrentPage } : {}),
      ...(resolved.pageCount !== undefined ? { pageCount: resolved.pageCount } : {}),
      selection: selected.selection,
      sourcePath: resolved.sourcePath,
      truncated,
      warnings,
    };
  }

  private async readReaderPages(
    pages: string,
    pageReader: PageReader,
  ): Promise<{ content: string; selection: string; pageCount: number | null; pageIndexes: readonly number[] } | null> {
    const range = parsePageRange(pages);
    const pageIndexes = Array.from({ length: range.end - range.start + 1 }, (_, offset) => (
      range.start - 1 + offset
    ));
    // A long range should not open dozens of reader/image requests at once.
    // Keep a small bounded fan-out while preserving page order in the result.
    const results: (ZotFlowPageContent | null)[] = [];
    for (let offset = 0; offset < pageIndexes.length; offset += 8) {
      const batch = pageIndexes.slice(offset, offset + 8);
      results.push(...await Promise.all(batch.map(index => pageReader(index))));
    }
    if (results.some(result => result === null)) return null;
    const pagesWithContent = results.filter((result): result is ZotFlowPageContent => result !== null);
    if (pagesWithContent.length === 0) return null;
    return {
      content: pagesWithContent.map(renderZotFlowPage).join('\n\n'),
      pageCount: pagesWithContent[0].pageCount,
      pageIndexes,
      selection: range.start === range.end ? `p.${range.start}` : `p.${range.start}-p.${range.end}`,
    };
  }

  private resolvePagesSelector(
    pages: string | undefined,
    currentPage: PaperReadPagePosition | undefined,
  ): string | undefined {
    if (pages === undefined) return undefined;
    if (pages.trim().toLocaleLowerCase() !== CURRENT_PAGE_SELECTOR) return pages;
    if (!currentPage) {
      throw new Error(
        'No current page is available for this source: ZotFlow has no reader open on it and '
        + 'Zotero never recorded a position. Pass an explicit page or range instead.',
      );
    }
    return String(currentPage.page);
  }
}
