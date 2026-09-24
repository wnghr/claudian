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

export interface DirectPdfTextResolverOptions {
  readonly resolvePdfPath: (sourcePath: string) => Promise<string | null>;
  readonly readPdfText?: (pdfPath: string) => Promise<string>;
}

async function readWithPdfToText(pdfPath: string): Promise<string> {
  // Kept behind a dynamic import so mobile builds can still load the plugin;
  // desktop users get a page-complete fallback when no MinerU parse is
  // available or Zotero's own extractor stopped at its long-document limit.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const result = await run('pdftotext', ['-layout', pdfPath, '-'], { windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  return result.stdout;
}

/** Read a Zotero PDF directly when no usable MinerU Markdown cache exists. */
export function createZoteroPdfTextResolver(
  options: ZoteroPdfTextResolverOptions,
): (sourcePath: string) => Promise<PaperContentResult | null> {
  return createDirectPdfTextResolver({
    readPdfText: options.readPdfText,
    resolvePdfPath: async sourcePath => {
      const attachmentKey = parseZoteroAttachmentReference(sourcePath);
      if (!attachmentKey) return null;
      return options.storage.attachmentPdfPath(attachmentKey);
    },
  });
}

/** Read a concrete PDF directly and return text with page anchors. */
export function createDirectPdfTextResolver(
  options: DirectPdfTextResolverOptions,
): (sourcePath: string) => Promise<PaperContentResult | null> {
  const readPdfText = options.readPdfText ?? readWithPdfToText;
  return async (sourcePath) => {
    const pdfPath = await options.resolvePdfPath(sourcePath);
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
