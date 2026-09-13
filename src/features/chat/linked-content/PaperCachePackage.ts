/**
 * The on-disk contract for a parsed PDF.
 *
 * Obsidian does not expose a Zotero attachment id, so `cache_id` is a stable
 * digest of the vault-relative PDF path.  The PDF content hash remains the
 * freshness authority; the path digest only prevents two PDFs with the same
 * filename from sharing a package.
 */

export const PAPER_CACHE_ROOT = '论文/MD';
export const PAPER_CACHE_SCHEMA_VERSION = 2;
export const PAPER_CACHE_FILES = {
  contentList: 'content_list.json',
  fullMarkdown: 'full.md',
  manifest: 'manifest.json',
  source: '_llm_source.json',
} as const;

export interface PaperCacheSection {
  readonly heading: string;
  readonly page: number | null;
  readonly charStart: number;
  readonly charEnd: number;
  readonly figures: readonly string[];
  readonly tables: readonly string[];
  readonly equationCount: number;
}

export interface PaperCacheFigureBlock {
  readonly path: string;
  readonly page: number | null;
  readonly caption: string | null;
  readonly charStart: number | null;
  readonly charEnd: number | null;
}

export interface PaperCacheManifest {
  readonly schema_version?: number;
  readonly cache_id?: string;
  readonly citekey?: string;
  readonly source_pdf?: string;
  readonly source_sha256?: string;
  readonly source_bytes?: number;
  readonly source_mtime?: string;
  readonly source?: {
    readonly path?: string;
    readonly filename?: string;
    readonly sha256?: string;
    readonly bytes?: number;
    readonly mtime?: string;
  };
  readonly parser?: string;
  readonly parser_version?: string;
  readonly status?: string;
  readonly parsed_at?: string;
  readonly full_md?: string;
  readonly output?: string;
  readonly paged_md?: string;
  readonly json_output?: string;
  readonly images_dir?: string;
  readonly files?: {
    readonly full_md?: string;
    readonly content_list?: string;
    readonly source?: string;
    readonly images?: string;
  };
  readonly sections?: readonly PaperCacheSection[];
  readonly allFigures?: readonly string[];
  readonly allTables?: readonly string[];
  readonly figureBlocks?: readonly PaperCacheFigureBlock[];
  readonly totalPages?: number;
  readonly totalChars?: number;
  readonly page_map?: {
    readonly anchors?: number;
    readonly pages?: number;
    readonly page_range?: readonly number[];
    readonly pages_missing?: readonly number[];
  };
  readonly [key: string]: unknown;
}

interface ContentListItem {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly page_idx?: unknown;
  readonly text_level?: unknown;
  readonly img_path?: unknown;
  readonly image_caption?: unknown;
  readonly table_caption?: unknown;
}

const PAGE_MARKER = /^\s*<!--\s*p\.(\d+)\s*-->\s*$/gmu;
const HEADING = /^(#{1,6})\s+(.+)$/gmu;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asPage(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value + 1
    : null;
}

function asStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => asString(item))
    .filter((item): item is string => item !== null);
}

function contentListItems(value: unknown): readonly ContentListItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ContentListItem => (
      typeof item === 'object' && item !== null && !Array.isArray(item)
    ),
  );
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n');
}

function hasPageAnchors(markdown: string): boolean {
  PAGE_MARKER.lastIndex = 0;
  const result = PAGE_MARKER.test(markdown);
  PAGE_MARKER.lastIndex = 0;
  return result;
}

/**
 * Converts a MinerU content list into a page-addressable Markdown document
 * when the parser's Markdown output did not include page anchors.  Existing
 * anchored Markdown wins because it preserves MinerU's richer layout.
 */
export function buildPageAnchoredMarkdown(markdown: string, contentList: unknown): string {
  const normalized = normalizeMarkdown(markdown).trim();
  if (hasPageAnchors(normalized)) return normalized + '\n';

  const items = contentListItems(contentList);
  if (items.length === 0 || !items.some(item => asPage(item.page_idx) !== null)) {
    return normalized + (normalized.length > 0 ? '\n' : '');
  }

  const output: string[] = [];
  let currentPage: number | null = null;
  for (const item of items) {
    const page = asPage(item.page_idx);
    if (page !== null && page !== currentPage) {
      output.push(`<!-- p.${page} -->`);
      currentPage = page;
    }
    const type = asString(item.type)?.toLocaleLowerCase() ?? '';
    if (type === 'header' || type === 'footer' || type === 'page_number') continue;

    const text = asString(item.text);
    if (text) {
      const level = typeof item.text_level === 'number' && Number.isInteger(item.text_level)
        ? Math.max(1, Math.min(6, item.text_level))
        : null;
      output.push(level && !/^#{1,6}\s+/u.test(text) ? `${'#'.repeat(level)} ${text}` : text);
    }
    const imagePath = asString(item.img_path);
    if (type === 'image' && imagePath) {
      output.push(`![](${imagePath})`);
      for (const caption of asStringList(item.image_caption)) output.push(caption);
    }
  }
  const rebuilt = output.join('\n\n').trim();
  return rebuilt.length > 0 ? `${rebuilt}\n` : `${normalized}\n`;
}

function pageAt(markdown: string, offset: number): number | null {
  PAGE_MARKER.lastIndex = 0;
  let page: number | null = null;
  for (const match of markdown.matchAll(PAGE_MARKER)) {
    if ((match.index ?? 0) > offset) break;
    page = Number(match[1]);
  }
  PAGE_MARKER.lastIndex = 0;
  return page;
}

function countEquations(text: string): number {
  return (text.match(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/gu) ?? []).length;
}

function markdownImagePaths(text: string): readonly string[] {
  return [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)]
    .map(match => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

/** Builds the manifest's bounded text navigation index from canonical full.md. */
export function buildCacheNavigationIndex(
  markdown: string,
  contentList: unknown = null,
): Pick<PaperCacheManifest, 'sections' | 'allFigures' | 'allTables' | 'figureBlocks' | 'totalPages' | 'totalChars' | 'page_map'> {
  const normalized = normalizeMarkdown(markdown);
  const headings = [...normalized.matchAll(HEADING)];
  const sections: PaperCacheSection[] = [];
  for (const [index, match] of headings.entries()) {
    const charStart = match.index ?? 0;
    const level = match[1].length;
    let charEnd = normalized.length;
    for (const candidate of headings.slice(index + 1)) {
      if (candidate[1].length <= level) {
        charEnd = candidate.index ?? normalized.length;
        break;
      }
    }
    const body = normalized.slice(charStart, charEnd);
    sections.push({
      heading: match[2].trim(),
      page: pageAt(normalized, charStart),
      charStart,
      charEnd,
      figures: markdownImagePaths(body),
      tables: [],
      equationCount: countEquations(body),
    });
  }

  const figures = new Set<string>(markdownImagePaths(normalized));
  const tables = new Set<string>();
  const figureBlocks: PaperCacheFigureBlock[] = [];
  for (const item of contentListItems(contentList)) {
    const type = asString(item.type)?.toLocaleLowerCase() ?? '';
    const imagePath = asString(item.img_path);
    if (type === 'image' && imagePath) {
      figures.add(imagePath);
      const caption = asStringList(item.image_caption).join(' ').trim() || null;
      figureBlocks.push({
        path: imagePath,
        page: asPage(item.page_idx),
        caption,
        charStart: null,
        charEnd: null,
      });
    }
    if (type === 'table') {
      const caption = asStringList(item.table_caption).join(' ').trim();
      if (caption) tables.add(caption);
    }
  }

  const pages = [...normalized.matchAll(PAGE_MARKER)].map(match => Number(match[1]));
  const totalPages = Math.max(
    pages.length > 0 ? Math.max(...pages) : 0,
    ...contentListItems(contentList).map(item => asPage(item.page_idx) ?? 0),
  );
  return {
    sections,
    allFigures: [...figures],
    allTables: [...tables],
    figureBlocks,
    totalPages: totalPages || 0,
    totalChars: normalized.length,
    page_map: {
      anchors: pages.length,
      pages: totalPages || 0,
      page_range: totalPages ? [1, totalPages] : [],
      pages_missing: [],
    },
  };
}

export function manifestSourcePath(manifest: PaperCacheManifest): string | null {
  return asString(manifest.source_pdf) ?? asString(manifest.source?.path) ?? null;
}

export function manifestSourceHash(manifest: PaperCacheManifest): string | null {
  return asString(manifest.source_sha256) ?? asString(manifest.source?.sha256) ?? null;
}

export function manifestFullMarkdownPath(manifest: PaperCacheManifest): string | null {
  const candidates = [
    manifest.files?.full_md,
    manifest.full_md,
    manifest.paged_md,
    manifest.output,
  ];
  return candidates.map(asString).find((value): value is string => value !== null) ?? null;
}
