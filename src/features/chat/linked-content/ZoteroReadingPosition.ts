import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ZOTERO_READER_STATE_FILE } from './ZoteroStorageFullText';

/**
 * Where did the reader leave off?
 *
 * Two independent writers keep score, and they disagree, so the source has to
 * be tracked rather than averaged:
 *
 * - ZotFlow's reader reports `viewStateChanged` and the Obsidian side stores a
 *   debounced copy in the plugin's `data.json`, keyed `"<libraryID>:<key>"`.
 *   This is the live source while reading inside Obsidian.
 * - Zotero Desktop writes `.zotero-reader-state` next to the attachment. ZotFlow
 *   never touches that file, so it only moves when the paper was opened in
 *   Zotero itself.
 *
 * `data.json` has no per-entry timestamp, so when no live reader confirms which
 * entry is current we fall back to comparing file modification times.
 */
export type ZoteroReadingPositionSource = 'zotflow-view-state' | 'zotero-reader-state';

export interface ZoteroReadingPosition {
  /** 1-based page number, as the reader displays it. */
  readonly page: number;
  readonly source: ZoteroReadingPositionSource;
  readonly recordedAt: number | null;
}

export interface ZoteroReadingPositionOptions {
  readonly storageRoot: string;
  /** Absolute path to the ZotFlow plugin's `data.json`, when the plugin is installed. */
  readonly zotFlowDataFile?: string | null;
  readonly readText?: (filePath: string) => Promise<string>;
  readonly statFile?: (filePath: string) => Promise<{ mtimeMs: number }>;
}

export interface ZoteroReadingPositionQuery {
  readonly libraryID: number | null;
  readonly attachmentKey: string;
  /**
   * Set when a live ZotFlow reader is showing this attachment. Its entry is
   * then authoritative even if an unrelated paper was read more recently.
   */
  readonly preferViewState?: boolean;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pageIndex(record: Record<string, unknown> | null): number | null {
  if (!record) return null;
  const value = record.pageIndex;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function zotFlowViewStateKey(libraryID: number, attachmentKey: string): string {
  return `${libraryID}:${attachmentKey}`;
}

/**
 * Find the entry for an attachment. The key is `"<libraryID>:<attachmentKey>"`,
 * and Zotero item keys are globally unique, so a key-only lookup is safe when
 * the library is unknown - which is the case when all we have is a
 * `zotero/<KEY>.pdf` path.
 */
export function findZotFlowViewStateKey(
  viewStates: Readonly<Record<string, unknown>>,
  libraryID: number | null,
  attachmentKey: string,
): string | null {
  if (libraryID !== null) {
    const exact = zotFlowViewStateKey(libraryID, attachmentKey);
    return exact in viewStates ? exact : null;
  }
  const suffix = `:${attachmentKey}`;
  return Object.keys(viewStates).find(key => key.endsWith(suffix)) ?? null;
}

/** Read `pageIndex` out of ZotFlow's `data.json` for one attachment. */
export function parseZotFlowViewStatePage(
  dataJson: string,
  libraryID: number | null,
  attachmentKey: string,
): number | null {
  const data = asRecord(parseJson(dataJson));
  const viewStates = asRecord(data?.viewStates);
  if (!viewStates) return null;
  const key = findZotFlowViewStateKey(viewStates, libraryID, attachmentKey);
  if (!key) return null;
  const entry = asRecord(viewStates[key]);
  if (!entry) return null;
  return pageIndex(asRecord(entry.primaryViewState)) ?? pageIndex(asRecord(entry.secondaryViewState));
}

/** Read `pageIndex` out of Zotero's own `.zotero-reader-state`. */
export function parseZoteroReaderStatePage(stateJson: string): number | null {
  return pageIndex(asRecord(parseJson(stateJson)));
}

function defaultReadText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

function defaultStatFile(filePath: string): Promise<{ mtimeMs: number }> {
  return fs.stat(filePath).then(stats => ({ mtimeMs: stats.mtimeMs }));
}

export class ZoteroReadingPositionReader {
  private readonly readText: (filePath: string) => Promise<string>;
  private readonly statFile: (filePath: string) => Promise<{ mtimeMs: number }>;

  constructor(private readonly options: ZoteroReadingPositionOptions) {
    this.readText = options.readText ?? defaultReadText;
    this.statFile = options.statFile ?? defaultStatFile;
  }

  async read(query: ZoteroReadingPositionQuery): Promise<ZoteroReadingPosition | null> {
    const [viewState, readerState] = await Promise.all([
      this.readViewState(query),
      this.readReaderState(query.attachmentKey),
    ]);
    if (viewState && readerState) {
      if (query.preferViewState) return viewState;
      if (readerState.recordedAt !== null && viewState.recordedAt !== null) {
        return readerState.recordedAt > viewState.recordedAt ? readerState : viewState;
      }
      return viewState;
    }
    return viewState ?? readerState;
  }

  private async readViewState(
    query: ZoteroReadingPositionQuery,
  ): Promise<ZoteroReadingPosition | null> {
    const file = this.options.zotFlowDataFile;
    if (!file) return null;
    try {
      const [text, stats] = await Promise.all([this.readText(file), this.statFile(file)]);
      const index = parseZotFlowViewStatePage(text, query.libraryID, query.attachmentKey);
      return index === null
        ? null
        : { page: index + 1, recordedAt: stats.mtimeMs, source: 'zotflow-view-state' };
    } catch {
      return null;
    }
  }

  private async readReaderState(attachmentKey: string): Promise<ZoteroReadingPosition | null> {
    if (!attachmentKey) return null;
    const file = path.join(this.options.storageRoot, attachmentKey, ZOTERO_READER_STATE_FILE);
    try {
      const [text, stats] = await Promise.all([this.readText(file), this.statFile(file)]);
      const index = parseZoteroReaderStatePage(text);
      return index === null ? null : { page: index + 1, recordedAt: stats.mtimeMs, source: 'zotero-reader-state' };
    } catch {
      return null;
    }
  }
}
