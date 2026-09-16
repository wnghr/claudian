import type { PaperContentResult } from './PaperContentResolver';
import { parseZoteroAttachmentReference } from './ZoteroAttachmentReference';
import {
  anchorFullTextPages,
  countFullTextPages,
  type ZoteroStorageFullTextCache,
} from './ZoteroStorageFullText';

export interface ZoteroPdfTextResolverOptions {
  readonly storage: ZoteroStorageFullTextCache;
  readonly readPdfText?: (pdfPath: string) => Promise<string>;
}

async function readWithPdfToText(pdfPath: string): Promise<string> {
  // Kept behind a dynamic import so mobile builds can still load the plugin;
  // desktop users get a real page-complete fallback when Zotero's extractor
  // stopped at its long-document limit.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const result = await run('pdftotext', ['-layout', pdfPath, '-'], { windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  return result.stdout;
}

/** Read a Zotero PDF directly when no complete Markdown/full-text cache exists. */
export function createZoteroPdfTextResolver(
  options: ZoteroPdfTextResolverOptions,
): (sourcePath: string) => Promise<PaperContentResult | null> {
  const readPdfText = options.readPdfText ?? readWithPdfToText;
  return async (sourcePath) => {
    const attachmentKey = parseZoteroAttachmentReference(sourcePath);
    if (!attachmentKey) return null;
    const pdfPath = await options.storage.attachmentPdfPath(attachmentKey);
    if (!pdfPath) return null;
    try {
      const raw = await readPdfText(pdfPath);
      if (!raw.trim()) return null;
      const content = anchorFullTextPages(raw);
      return {
        status: 'ready',
        sourcePath,
        content,
        complete: true,
        fidelity: 'pdf-direct',
        pageCount: countFullTextPages(raw),
        warnings: ['Text was extracted directly from the PDF with pdftotext; formulas and complex layouts may need visual verification.'],
      };
    } catch {
      return null;
    }
  };
}
