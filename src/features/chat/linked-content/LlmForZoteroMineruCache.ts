import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  buildCacheNavigationIndex,
  buildPageAnchoredMarkdown,
  countPageAnchors,
} from './PaperCachePackage';
import type { PaperContentResult } from './PaperContentResolver';
import { parseZoteroAttachmentReference } from './ZoteroAttachmentReference';

const SOURCE_FILE = '_llm_source.json';
const CONTENT_LIST_FILE = 'content_list.json';
const FULL_MARKDOWN_FILE = 'full.md';
const MANIFEST_FILE = 'manifest.json';

export interface LlmForZoteroMineruCacheOptions {
  readonly cacheRoot: string;
  readonly listDirectories?: () => Promise<readonly string[]>;
  readonly readText?: (path: string) => Promise<string>;
  readonly statFile?: (path: string) => Promise<{ mtimeMs: number; size: number }>;
}

export interface LlmForZoteroMineruSource {
  readonly attachmentKey: string;
  readonly parentItemKey: string | null;
  readonly directory: string;
  readonly sourceFilename: string | null;
  readonly parsedAt?: string | null;
  readonly pages?: number | null;
}

export interface LlmForZoteroMineruDocument extends LlmForZoteroMineruSource {
  readonly path: string;
  readonly content: string;
}

function defaultListDirectories(cacheRoot: string): Promise<readonly string[]> {
  return fs.readdir(cacheRoot, { withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
}

function defaultReadText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

function defaultStatFile(filePath: string): Promise<{ mtimeMs: number; size: number }> {
  return fs.stat(filePath).then(stats => ({ mtimeMs: stats.mtimeMs, size: stats.size }));
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function optionalPageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

interface CacheSourceEntry {
  readonly source: LlmForZoteroMineruSource;
  readonly cacheDirectory: string;
}

/** Reads an existing llm-for-zotero MinerU cache without copying it into the vault. */
export class LlmForZoteroMineruCache {
  private readonly listDirectories: () => Promise<readonly string[]>;
  private readonly readText: (filePath: string) => Promise<string>;
  private readonly statFile: (filePath: string) => Promise<{ mtimeMs: number; size: number }>;
  private readonly textCache = new Map<string, { mtimeMs: number; size: number; text: string }>();

  constructor(private readonly options: LlmForZoteroMineruCacheOptions) {
    this.listDirectories = options.listDirectories
      ?? (() => defaultListDirectories(options.cacheRoot));
    this.readText = options.readText ?? defaultReadText;
    this.statFile = options.statFile ?? defaultStatFile;
  }

  private async readCachedText(filePath: string): Promise<string> {
    try {
      const stats = await this.statFile(filePath);
      const cached = this.textCache.get(filePath);
      if (cached?.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        return cached.text;
      }
      const text = await this.readText(filePath);
      this.textCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, text });
      return text;
    } catch {
      // Injectable readers often represent virtual files without stat data.
      return this.readText(filePath);
    }
  }

  /**
   * The source manifest is the cache's stable identity index. Keep its scan in
   * one place so browse, search intake, and targeted reads cannot drift apart
   * in how they normalize attachment keys or tolerate partial directories.
   */
  private async scanSourceEntries(): Promise<readonly CacheSourceEntry[] | null> {
    let directories: readonly string[];
    try {
      directories = await this.listDirectories();
    } catch {
      return null;
    }

    const entries: CacheSourceEntry[] = [];
    for (const directory of directories) {
      try {
        const source = parsedObject(await this.readCachedText(
          path.join(this.options.cacheRoot, directory, SOURCE_FILE),
        ));
        const attachmentKey = typeof source?.attachmentKey === 'string'
          ? source.attachmentKey.trim().toLocaleUpperCase()
          : '';
        if (!attachmentKey) continue;
        const parentItemKey = typeof source?.parentItemKey === 'string'
          ? source.parentItemKey.trim().toLocaleUpperCase()
          : null;
        const sourceFilename = typeof source?.sourceFilename === 'string'
          ? source.sourceFilename
          : null;
        const parsedAt = typeof source?.parsedAt === 'string' ? source.parsedAt : null;
        entries.push({
          source: { attachmentKey, parentItemKey, directory, sourceFilename, parsedAt },
          cacheDirectory: path.join(this.options.cacheRoot, directory),
        });
      } catch {
        // A partial cache directory must not hide the rest of the library.
      }
    }
    return entries;
  }

  private async readManifest(cacheDirectory: string): Promise<Record<string, unknown> | null> {
    try {
      return parsedObject(await this.readCachedText(path.join(cacheDirectory, MANIFEST_FILE)));
    } catch {
      return null;
    }
  }

  async listSources(): Promise<readonly LlmForZoteroMineruSource[]> {
    const entries = (await this.scanSourceEntries()) ?? [];
    const sources: LlmForZoteroMineruSource[] = [];
    for (const entry of entries) {
      const manifest = await this.readManifest(entry.cacheDirectory);
      const parsedAt = typeof manifest?.parsed_at === 'string'
        ? manifest.parsed_at
        : entry.source.parsedAt ?? null;
      sources.push({
        ...entry.source,
        parsedAt,
        pages: optionalPageCount(manifest?.totalPages),
      });
    }
    return sources;
  }

  async listDocuments(): Promise<readonly LlmForZoteroMineruDocument[]> {
    const entries = (await this.scanSourceEntries()) ?? [];
    const documents: LlmForZoteroMineruDocument[] = [];
    for (const entry of entries) {
      try {
        const rawMarkdown = await this.readCachedText(path.join(entry.cacheDirectory, FULL_MARKDOWN_FILE));
        if (!rawMarkdown.trim()) continue;
        let contentList: unknown = null;
        try {
          contentList = parsedJson(
            await this.readCachedText(path.join(entry.cacheDirectory, CONTENT_LIST_FILE)),
          );
        } catch {
          // full.md is still a useful searchable document without page metadata.
        }
        documents.push({
          ...entry.source,
          content: buildPageAnchoredMarkdown(rawMarkdown, contentList),
          path: `zotero/${entry.source.attachmentKey}.pdf`,
        });
      } catch {
        // Invalid or partial caches remain visible through browse/read status,
        // but are excluded from full-text retrieval until they are complete.
      }
    }
    return documents;
  }

  async resolve(sourcePath: string): Promise<PaperContentResult | null> {
    const attachmentKey = parseZoteroAttachmentReference(sourcePath);
    if (!attachmentKey) return null;

    const entries = await this.scanSourceEntries();
    if (entries === null) {
      return {
        status: 'missing',
        sourcePath,
        reason: 'The llm-for-zotero MinerU cache folder is unavailable.',
      };
    }

    const matchingEntry = entries.find(entry =>
      entry.source.attachmentKey === attachmentKey,
    );
    if (!matchingEntry) {
      return {
        status: 'missing',
        sourcePath,
        reason: 'No llm-for-zotero MinerU cache matches this Zotero attachment.',
      };
    }

    try {
        const rawMarkdown = await this.readCachedText(path.join(matchingEntry.cacheDirectory, FULL_MARKDOWN_FILE));
        if (!rawMarkdown.trim()) {
          return { status: 'invalid', sourcePath, reason: 'The llm-for-zotero Markdown cache is empty.' };
        }
        let contentList: unknown = null;
        try {
          contentList = parsedJson(
            await this.readCachedText(path.join(matchingEntry.cacheDirectory, CONTENT_LIST_FILE)),
          );
        } catch {
          // Auxiliary metadata is optional; full.md remains reusable.
        }
        const manifest = await this.readManifest(matchingEntry.cacheDirectory);
        const content = buildPageAnchoredMarkdown(rawMarkdown, contentList);
        const navigation = buildCacheNavigationIndex(content, contentList);
        const cachePath = `llm-for-zotero-mineru/${matchingEntry.source.directory}/${FULL_MARKDOWN_FILE}`;
        return {
          status: 'ready',
          sourcePath,
          cachePath,
          content,
          complete: Boolean(contentList && manifest),
          fidelity: 'mineru-md',
          ...(countPageAnchors(content) > 0 ? { pageCount: countPageAnchors(content) } : {}),
          manifest: {
            ...manifest,
            ...navigation,
            full_md: cachePath,
            status: 'success',
          },
        };
    } catch {
        return {
          status: 'invalid',
          sourcePath,
          reason: 'The matching llm-for-zotero cache is incomplete.',
        };
    }
  }
}
