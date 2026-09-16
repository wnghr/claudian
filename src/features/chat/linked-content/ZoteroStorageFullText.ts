import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Zotero extracts an attachment's plain text once and caches it next to the
 * file as `.zotero-ft-cache`. Pages are separated by a form feed, and for
 * ordinary journal articles the separator count matches the PDF's page count
 * exactly (verified against `pdfinfo` for every article in the reference
 * vault), so the cache is a faithful stand-in for the PDF text.
 *
 * Long documents are the exception: Zotero's extractor stops around 100 pages,
 * so books and theses come back truncated. `alignment` carries that caveat
 * instead of letting callers assume page numbers always line up.
 */
export const ZOTERO_FULL_TEXT_FILE = '.zotero-ft-cache';
export const ZOTERO_READER_STATE_FILE = '.zotero-reader-state';
export const ZOTERO_STORAGE_DIRECTORY = 'storage';

const ZOTERO_DEFAULT_DATA_DIRECTORY = 'Zotero';
const PAGE_SEPARATOR = '\f';
const TRUNCATION_PAGE_THRESHOLD = 90;

export type ZoteroFullTextAlignment = 'exact' | 'suspect';

export interface ZoteroFullText {
  readonly attachmentKey: string;
  readonly filePath: string;
  /** Page-anchored Markdown: `<!-- p.N -->` before every page, blank pages kept. */
  readonly content: string;
  readonly pageCount: number;
  readonly mtimeMs: number;
  readonly alignment: ZoteroFullTextAlignment;
}

export interface ZoteroFullTextReaderOptions {
  readonly storageRoot: string;
  readonly readText?: (filePath: string) => Promise<string>;
  readonly statFile?: (filePath: string) => Promise<{ mtimeMs: number; size: number }>;
  readonly listDirectory?: (directory: string) => Promise<readonly string[]>;
  /** List attachment directories under `storageRoot` (separate from per-file listings). */
  readonly listDirectories?: (directory: string) => Promise<readonly string[]>;
}

/**
 * Resolve the `storage` directory holding Zotero's per-attachment folders.
 *
 * `configuredDataDirectory` is Zotero's data directory (the folder containing
 * `zotero.sqlite`), not the `storage` folder itself, so that users can point at
 * a relocated library with a single value.
 */
export function resolveZoteroStorageRoot(
  configuredDataDirectory?: string,
  userProfile: string | undefined = process.env.USERPROFILE ?? process.env.HOME,
): string | null {
  const configured = configuredDataDirectory?.trim();
  if (configured) {
    return path.basename(configured).toLocaleLowerCase() === ZOTERO_STORAGE_DIRECTORY
      ? configured
      : path.join(configured, ZOTERO_STORAGE_DIRECTORY);
  }
  return userProfile
    ? path.join(userProfile, ZOTERO_DEFAULT_DATA_DIRECTORY, ZOTERO_STORAGE_DIRECTORY)
    : null;
}

export function splitFullTextPages(text: string): readonly string[] {
  const pages = text.split(PAGE_SEPARATOR);
  // A trailing separator would otherwise be counted as an extra empty page.
  if (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
  return pages;
}

export function countFullTextPages(text: string): number {
  return splitFullTextPages(text).length;
}

/**
 * Convert form-feed separated text into the `<!-- p.N -->` Markdown the paper
 * reader already understands. Every page gets a marker, including blank ones,
 * so page N of the excerpt is page N of the PDF.
 */
export function anchorFullTextPages(text: string): string {
  return splitFullTextPages(text)
    .map((page, index) => `<!-- p.${index + 1} -->\n${page.trim()}`)
    .join('\n\n');
}

export function resolveFullTextAlignment(pageCount: number): ZoteroFullTextAlignment {
  return pageCount >= TRUNCATION_PAGE_THRESHOLD ? 'suspect' : 'exact';
}

function defaultReadText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

function defaultStatFile(filePath: string): Promise<{ mtimeMs: number; size: number }> {
  return fs.stat(filePath).then(stats => ({ mtimeMs: stats.mtimeMs, size: stats.size }));
}

function defaultListDirectory(directory: string): Promise<readonly string[]> {
  return fs.readdir(directory);
}

function defaultListDirectories(directory: string): Promise<readonly string[]> {
  return fs.readdir(directory, { withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
}

export class ZoteroStorageFullTextCache {
  private readonly readText: (filePath: string) => Promise<string>;
  private readonly statFile: (filePath: string) => Promise<{ mtimeMs: number; size: number }>;
  private readonly listDirectory: (directory: string) => Promise<readonly string[]>;
  private readonly listDirectories: (directory: string) => Promise<readonly string[]>;
  private readonly textCache = new Map<string, { mtimeMs: number; size: number; text: string }>();

  constructor(private readonly options: ZoteroFullTextReaderOptions) {
    this.readText = options.readText ?? defaultReadText;
    this.statFile = options.statFile ?? defaultStatFile;
    this.listDirectory = options.listDirectory ?? defaultListDirectory;
    this.listDirectories = options.listDirectories ?? defaultListDirectories;
  }

  fullTextPath(attachmentKey: string): string {
    return path.join(this.options.storageRoot, attachmentKey, ZOTERO_FULL_TEXT_FILE);
  }

  async read(attachmentKey: string): Promise<ZoteroFullText | null> {
    if (!attachmentKey) return null;
    const filePath = this.fullTextPath(attachmentKey);
    let text: string;
    let mtimeMs: number;
    let size: number;
    try {
      const stats = await this.statFile(filePath);
      mtimeMs = stats.mtimeMs;
      size = stats.size;
      const cached = this.textCache.get(filePath);
      if (cached?.mtimeMs === mtimeMs && cached.size === size) {
        text = cached.text;
      } else {
        text = await this.readText(filePath);
        this.textCache.set(filePath, { mtimeMs, size, text });
      }
    } catch {
      return null;
    }
    if (!text.trim()) return null;
    const pageCount = countFullTextPages(text);
    return {
      alignment: resolveFullTextAlignment(pageCount),
      attachmentKey,
      content: anchorFullTextPages(text),
      filePath,
      mtimeMs,
      pageCount,
    };
  }

  /**
   * Enumerate Zotero's cached full text for PDF attachments.
   *
   * Directory membership is checked on every request, while unchanged text is
   * reused by `read()` through the file's mtime and size. Newly extracted or
   * changed attachments therefore become visible without an indexing job.
   * Non-attachment folders and web snapshots are ignored to keep synthetic PDF
   * paths honest.
   */
  async listDocuments(): Promise<readonly ZoteroFullText[]> {
    let directories: readonly string[];
    try {
      directories = await this.listDirectories(this.options.storageRoot);
    } catch {
      return [];
    }

    const candidates = [...directories]
      .filter(directory => /^[A-Z0-9]{8}$/iu.test(directory))
      .sort((left, right) => left.localeCompare(right));
    const documents = await Promise.all(candidates.map(async directory => {
      if (!(await this.hasAttachmentFile(directory))) return null;
      return this.read(directory);
    }));
    return documents.filter((document): document is ZoteroFullText => document !== null);
  }

  /** Whether Zotero has a PDF next to the cached text, as opposed to a snapshot. */
  async hasAttachmentFile(attachmentKey: string, extension = '.pdf'): Promise<boolean> {
    if (!attachmentKey) return false;
    const directory = path.join(this.options.storageRoot, attachmentKey);
    try {
      const entries = await this.listDirectory(directory);
      return entries.some(entry => entry.toLocaleLowerCase().endsWith(extension));
    } catch {
      return false;
    }
  }

  /** Return the concrete PDF path inside Zotero storage, when present. */
  async attachmentPdfPath(attachmentKey: string): Promise<string | null> {
    if (!attachmentKey) return null;
    const directory = path.join(this.options.storageRoot, attachmentKey);
    try {
      const entries = await this.listDirectory(directory);
      const filename = entries.find(entry => entry.toLocaleLowerCase().endsWith('.pdf'));
      return filename ? path.join(directory, filename) : null;
    } catch {
      return null;
    }
  }
}
