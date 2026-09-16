/**
 * How faithful the returned text is to the PDF.
 *
 * `mineru-md` is a full LaTeX-aware parse with page anchors and section
 * headings. `zotero-fulltext` is Zotero's own plain-text extraction: faithful
 * page-by-page reading for ordinary articles, but no headings and no formulas.
 * `pdf-direct` is a desktop PDF text pass that can cover pages beyond Zotero's
 * full-text extraction cap, with the same plain-text caveat.
 * `none` means nothing could be read and the caller has to degrade.
 */
export type PaperReadFidelity = 'mineru-md' | 'zotflow-reader' | 'zotero-fulltext' | 'pdf-direct' | 'none';

export type PaperReadPageSource = 'zotflow-view-state' | 'zotero-reader-state';

export interface PaperReadPagePosition {
  /** 1-based, as the reader displays it. */
  readonly page: number;
  readonly source: PaperReadPageSource;
}

export interface PaperReadRequest {
  /**
   * A vault path, `zotero/<KEY>.pdf`, or a ZotFlow link. Omitted when the caller
   * wants the host to follow whatever the ZotFlow reader currently has open.
   */
  readonly sourcePath?: string;
  /** Prefer a live ZotFlow reader when sourcePath is only a linked fallback. */
  readonly preferActiveReader?: boolean;
  /** A page, a range such as `3-5`, or `current` for the reader's current page. */
  readonly pages?: string;
  readonly section?: string;
  readonly query?: string;
  readonly maxChars?: number;
  /** Render requested pages for figure/image inspection. */
  readonly includeImages?: boolean;
}

export interface PaperReadResult {
  readonly sourcePath: string;
  /** The parsed Markdown that was read, when one existed. */
  readonly cachePath?: string;
  readonly content: string;
  readonly selection: string;
  readonly truncated: boolean;
  readonly fidelity: PaperReadFidelity;
  /** Pages the readable text covers; may be fewer than the PDF has. */
  readonly pageCount?: number;
  /** Where the reader currently is, when that could be determined. */
  readonly currentPage?: PaperReadPagePosition;
  /** On-demand rendered page images supplied by ZotFlow Reader. */
  readonly images?: readonly PaperReadImage[];
  readonly warnings: readonly string[];
}

export interface PaperReadImage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly dataUrl: string;
}

export interface PaperReadPort {
  readPaper(request: PaperReadRequest): Promise<PaperReadResult>;
}
