/**
 * Library-level capabilities: enumerating the paper library and producing
 * citations.
 *
 * Both read vault-derived metadata only. Neither spawns a process, and neither
 * duplicates a host tool: `browse` merges metadata that no host file listing
 * can produce, and `cite` reads the bibliography index that only this vault has.
 */

/** Cheap cache freshness signal for a listing; the reader re-hashes on demand. */
export type PaperCacheStatus = 'ready' | 'stale' | 'missing';

export interface PaperLibraryEntry {
  readonly citekey: string;
  readonly title: string;
  readonly year: number | null;
  readonly domain: string | null;
  readonly subfield: string | null;
  readonly status: string | null;
  readonly cardPath: string | null;
  readonly pdfPath: string | null;
  readonly pages: number | null;
  readonly cache: PaperCacheStatus;
  readonly parsedAt: string | null;
}

export interface PaperLibraryQuery {
  readonly query?: string;
  readonly status?: string;
}

export interface PaperAuthor {
  readonly family: string;
  readonly given: string;
}

export interface PaperCitation {
  readonly citekey: string;
  readonly title: string;
  readonly authors: readonly PaperAuthor[];
  readonly year: number | null;
  readonly venue: string | null;
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
  readonly doi: string | null;
  readonly url: string | null;
}

export interface PaperLibraryBrowsePort {
  listPapers(query?: PaperLibraryQuery): Promise<readonly PaperLibraryEntry[]>;
}

export interface PaperCitationPort {
  citePaper(citekey: string): Promise<PaperCitation>;
}

export interface PaperLibraryPort extends PaperLibraryBrowsePort, PaperCitationPort {}
