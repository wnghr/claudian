import type { PaperContentResult } from './PaperContentResolver';
import { parseZoteroAttachmentReference } from './ZoteroAttachmentReference';
import type { ZoteroStorageFullTextCache } from './ZoteroStorageFullText';

/**
 * Fallback content tier for Zotero attachments when direct PDF extraction is
 * unavailable and no usable MinerU parse exists.
 *
 * Zotero keeps its own plain-text extraction next to every attachment, which
 * makes PDFs readable without shipping a PDF engine or re-parsing anything. It
 * is a lower-fidelity source than a MinerU parse - no headings and no LaTeX -
 * so the result is labelled rather than passed off as equivalent.
 */
export interface ZoteroFullTextPaperContentOptions {
  readonly fullText: ZoteroStorageFullTextCache;
  readonly maxChars?: number;
}

/**
 * Page selection needs the whole document, so this tier hands back everything
 * and leaves the size limit to the reader, which truncates after selecting.
 */
const DEFAULT_MAX_CHARS = Number.MAX_SAFE_INTEGER;

function truncationWarning(pageCount: number): string {
  return `Zotero's full-text extraction stops near 100 pages; this attachment's text covers ${pageCount} pages. Later pages, if the PDF has any, are not available through this cache.`;
}

export function createZoteroFullTextContentResolver(
  options: ZoteroFullTextPaperContentOptions,
): (sourcePath: string) => Promise<PaperContentResult | null> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  return async (sourcePath: string): Promise<PaperContentResult | null> => {
    const normalized = sourcePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const attachmentKey = parseZoteroAttachmentReference(normalized);
    if (!attachmentKey) return null;

    const fullText = await options.fullText.read(attachmentKey);
    if (!fullText) return null;

    const complete = fullText.content.length <= maxChars;
    return {
      status: 'ready',
      sourcePath: normalized,
      content: complete ? fullText.content : fullText.content.slice(0, maxChars),
      complete,
      fidelity: 'zotero-fulltext',
      pageCount: fullText.pageCount,
      warnings: fullText.alignment === 'suspect' ? [truncationWarning(fullText.pageCount)] : [],
      ...(complete ? {} : { reason: `The extracted text exceeds the ${maxChars}-character read limit.` }),
    };
  };
}
