/**
 * Search-level capabilities: hybrid retrieval over Obsidian notes and the
 * external Zotero MinerU paper cache.
 *
 * This is the port the search tool talks to. The implementation decides where
 * the corpus comes from; the tool only shapes the request and the answer.
 */

export const PAPER_SEARCH_MODES = ['hybrid', 'keyword', 'local-vector'] as const;
export type PaperSearchMode = (typeof PAPER_SEARCH_MODES)[number];

export const PAPER_SEARCH_DEFAULT_LIMIT = 8;
export const PAPER_SEARCH_MAX_LIMIT = 50;

/** Chunk kinds a caller may restrict to; `meta` is note/card frontmatter. */
export const PAPER_SEARCH_KINDS = ['md', 'meta'] as const;
export type PaperSearchKind = (typeof PAPER_SEARCH_KINDS)[number];

export interface PaperSearchRequest {
  readonly query: string;
  readonly mode?: PaperSearchMode;
  readonly limit?: number;
  /** Obsidian path or path segment, or a Zotero attachment key. */
  readonly scope?: string;
  readonly kind?: PaperSearchKind;
}

export interface PaperSearchHit {
  readonly path: string;
  readonly kind: string;
  readonly heading: string;
  readonly locator: string;
  readonly score: number;
  readonly snippet: string;
  readonly body: string;
}

export interface PaperSearchIndexStats {
  readonly files: number;
  readonly chunks: number;
  readonly embedded: number;
}

export interface PaperSearchResult {
  readonly query: string;
  readonly mode: PaperSearchMode;
  /**
   * Non-null when part of the requested retrieval was unavailable. A degraded
   * answer must never be presented as if it were complete.
   */
  readonly degraded: string | null;
  readonly index: PaperSearchIndexStats;
  readonly hits: readonly PaperSearchHit[];
}

export interface PaperSearchPort {
  searchPapers(request: PaperSearchRequest): Promise<PaperSearchResult>;
}
