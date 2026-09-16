import { createZoteroAttachmentReference, parseZoteroAttachmentReference } from './ZoteroAttachmentReference';

/**
 * Turning "the paper I am looking at" into a readable path.
 *
 * Three inputs can name a paper, and they arrive in different shapes:
 *
 * 1. A live ZotFlow reader view. The remote reader reports
 *    `{libraryID, itemKey}` where `itemKey` is the **attachment** key; the local
 *    reader reports `{file}`, the vault path it is showing.
 * 2. A ZotFlow source note. Its frontmatter `zotero-key` is the **parent item**
 *    key, so it cannot be used as a cache key directly - the attachment has to
 *    be picked out of the `obsidian://zotflow?type=open-attachment&key=...`
 *    links in the Attachments section.
 * 3. A pasted `obsidian://zotflow` link or a `zotero/<KEY>.pdf` reference.
 *
 * Everything funnels into `ZotFlowPaperTarget.sourcePath`, which is what the
 * content resolver understands.
 */
export const ZOTFLOW_REMOTE_READER_VIEW_TYPE = 'zotflow-zotero-reader-view';
export const ZOTFLOW_LOCAL_READER_VIEW_TYPE = 'zotflow-local-zotero-reader-view';

export type ZotFlowTargetOrigin = 'reader' | 'local-reader' | 'source-note' | 'link' | 'reference';

export interface ZotFlowPaperTarget {
  /** `null` for vault files, which have no Zotero identity. */
  readonly attachmentKey: string | null;
  readonly libraryID: number | null;
  /** The Zotero *item* the note or link belongs to, when known. */
  readonly parentItemKey: string | null;
  readonly sourceNotePath: string | null;
  /** Canonical input for the content resolver: a vault path or `zotero/<KEY>.pdf`. */
  readonly sourcePath: string;
  readonly origin: ZotFlowTargetOrigin;
  /** Lazy page reader supplied by the active ZotFlow Reader, when available. */
  readonly readPage?: (pageIndex: number) => Promise<ZotFlowPageContent | null>;
  /** Lazy page renderer supplied by the active ZotFlow Reader, when available. */
  readonly readPageImage?: (pageIndex: number, scale?: number) => Promise<ZotFlowPageImage | null>;
}

export interface ZotFlowPageContent {
  readonly pageIndex: number;
  readonly pageCount: number | null;
  readonly blocks: readonly unknown[];
  readonly pageData: unknown;
}

export interface ZotFlowPageImage {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly dataUrl: string;
}

export interface ZotFlowReaderState {
  readonly viewType: string;
  readonly state: unknown;
  readonly readPage?: (pageIndex: number) => Promise<ZotFlowPageContent | null>;
  readonly readPageImage?: (pageIndex: number, scale?: number) => Promise<ZotFlowPageImage | null>;
}

export interface ZotFlowLinkReference {
  readonly kind: 'attachment' | 'annotation';
  readonly libraryID: number;
  readonly key: string;
}

export interface SourceNoteIdentity {
  readonly parentItemKey: string | null;
  readonly libraryID: number | null;
  readonly citationKey: string | null;
}

export interface ZotFlowLocatorOptions {
  /** Read a vault file as text; `null` when it is missing or unreadable. */
  readonly readNote: (path: string) => Promise<string | null>;
  /** Raw `getState()` results for every open ZotFlow reader view. */
  readonly listReaderStates: () => readonly ZotFlowReaderState[];
  /** Whether Zotero holds a PDF for this attachment, as opposed to a snapshot. */
  readonly isPdfAttachment?: (attachmentKey: string) => Promise<boolean>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isZotFlowLink(reference: string): boolean {
  return /^obsidian:\/\/zotflow\?/iu.test(reference.trim());
}

export function isZotFlowSourceNotePath(path: string): boolean {
  return path.toLocaleLowerCase().endsWith('.md');
}

/** Parse one `obsidian://zotflow?type=...&key=...` URL. */
export function parseZotFlowLink(url: string): ZotFlowLinkReference | null {
  const trimmed = url.trim();
  if (!isZotFlowLink(trimmed)) return null;
  const query = new URLSearchParams(trimmed.slice(trimmed.indexOf('?') + 1));
  const type = asString(query.get('type'));
  if (type !== 'open-attachment' && type !== 'open-annotation') return null;
  const libraryID = asNumber(Number(query.get('libraryID')));
  const key = asString(query.get('key'));
  if (libraryID === null || !key) return null;
  return { key, kind: type === 'open-annotation' ? 'annotation' : 'attachment', libraryID };
}

/** Attachment links in the order the note lists them, annotations excluded. */
export function parseAttachmentLinks(markdown: string): readonly ZotFlowLinkReference[] {
  const matches = markdown.match(/obsidian:\/\/zotflow\?[^\s)\]]+/giu) ?? [];
  const seen = new Set<string>();
  const references: ZotFlowLinkReference[] = [];
  for (const match of matches) {
    const reference = parseZotFlowLink(match);
    if (!reference || reference.kind !== 'attachment') continue;
    if (seen.has(reference.key)) continue;
    seen.add(reference.key);
    references.push(reference);
  }
  return references;
}

export function parseSourceNoteIdentity(markdown: string): SourceNoteIdentity {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
  const field = (name: string): string | null => {
    const match = frontmatter.match(new RegExp(`^${name}:\\s*(.*?)\\s*$`, 'mu'));
    return match && match[1] && match[1] !== 'null' ? match[1] : null;
  };
  const rawLibraryID = field('library-id');
  const libraryID = rawLibraryID === null ? Number.NaN : Number(rawLibraryID);
  return {
    citationKey: field('citationKey') ?? field('citation-key'),
    libraryID: Number.isFinite(libraryID) ? libraryID : null,
    parentItemKey: field('zotero-key'),
  };
}

/**
 * Pick the attachment to read from a source note. Preference order is: the
 * first link Zotero itself lists for a real PDF, then the first link at all.
 * Preferring a PDF keeps supplementary-material and snapshot attachments from
 * shadowing the paper when they happen to be listed first.
 */
export function resolveTargetFromSourceNote(
  markdown: string,
  notePath: string,
  pdfAttachmentKeys: ReadonlySet<string> = new Set(),
): ZotFlowPaperTarget | null {
  const identity = parseSourceNoteIdentity(markdown);
  const links = parseAttachmentLinks(markdown);
  const chosen = links.find(link => pdfAttachmentKeys.has(link.key)) ?? links[0];
  if (!chosen) return null;
  const sourcePath = createZoteroAttachmentReference(chosen.key);
  if (!sourcePath) return null;
  return {
    attachmentKey: chosen.key,
    libraryID: chosen.libraryID ?? identity.libraryID,
    origin: 'source-note',
    parentItemKey: identity.parentItemKey,
    sourceNotePath: notePath,
    sourcePath,
  };
}

export function resolveTargetFromReaderState(reader: ZotFlowReaderState): ZotFlowPaperTarget | null {
  const state = asRecord(reader.state);
  if (!state) return null;

  if (reader.viewType === ZOTFLOW_REMOTE_READER_VIEW_TYPE) {
    const attachmentKey = asString(state.itemKey);
    const sourcePath = attachmentKey ? createZoteroAttachmentReference(attachmentKey) : null;
    if (!attachmentKey || !sourcePath) return null;
    return {
      attachmentKey,
      libraryID: asNumber(state.libraryID),
      origin: 'reader',
      parentItemKey: null,
      sourceNotePath: null,
      sourcePath,
      ...(reader.readPage ? { readPage: reader.readPage } : {}),
      ...(reader.readPageImage ? { readPageImage: reader.readPageImage } : {}),
    };
  }

  if (reader.viewType === ZOTFLOW_LOCAL_READER_VIEW_TYPE) {
    const file = asString(state.file);
    if (!file) return null;
    return {
      attachmentKey: null,
      libraryID: null,
      origin: 'local-reader',
      parentItemKey: null,
      sourceNotePath: null,
      sourcePath: file,
      ...(reader.readPage ? { readPage: reader.readPage } : {}),
      ...(reader.readPageImage ? { readPageImage: reader.readPageImage } : {}),
    };
  }

  return null;
}

export function resolveTargetFromReference(reference: string): ZotFlowPaperTarget | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;

  const link = parseZotFlowLink(trimmed);
  if (link) {
    const sourcePath = createZoteroAttachmentReference(link.key);
    return sourcePath
      ? {
        attachmentKey: link.key,
        libraryID: link.libraryID,
        origin: 'link',
        parentItemKey: null,
        sourceNotePath: null,
        sourcePath,
      }
      : null;
  }

  const attachmentKey = parseZoteroAttachmentReference(trimmed);
  if (attachmentKey) {
    return {
      attachmentKey,
      libraryID: null,
      origin: 'reference',
      parentItemKey: null,
      sourceNotePath: null,
      sourcePath: createZoteroAttachmentReference(attachmentKey) ?? trimmed,
    };
  }

  return null;
}

export class ZotFlowLocator {
  constructor(private readonly options: ZotFlowLocatorOptions) {}

  /**
   * Resolve a paper target. An explicit reference always wins; otherwise a live
   * reader beats the note linked to the conversation, because "the paper I am
   * reading" is what the user is pointing at.
   */
  async resolve(reference?: string | null): Promise<ZotFlowPaperTarget | null> {
    const explicit = reference?.trim();
    if (explicit) {
      const direct = resolveTargetFromReference(explicit);
      if (direct) return direct;
      if (isZotFlowSourceNotePath(explicit)) return this.resolveSourceNote(explicit);
      if (explicit.toLocaleLowerCase().endsWith('.pdf')) {
        return {
          attachmentKey: parseZoteroAttachmentReference(explicit),
          libraryID: null,
          origin: 'reference',
          parentItemKey: null,
          sourceNotePath: null,
          sourcePath: explicit,
        };
      }
      return null;
    }

    return this.resolveActiveReader();
  }

  resolveActiveReader(): ZotFlowPaperTarget | null {
    for (const reader of this.options.listReaderStates()) {
      const target = resolveTargetFromReaderState(reader);
      if (target) return target;
    }
    return null;
  }

  async resolveSourceNote(notePath: string): Promise<ZotFlowPaperTarget | null> {
    const markdown = await this.options.readNote(notePath);
    if (markdown === null) return null;
    const keys = parseAttachmentLinks(markdown).map(link => link.key);
    const pdfKeys = new Set<string>();
    if (this.options.isPdfAttachment) {
      const flags = await Promise.all(keys.map(async key => (
        await this.options.isPdfAttachment?.(key) ? key : null
      )));
      for (const key of flags) if (key) pdfKeys.add(key);
    }
    return resolveTargetFromSourceNote(markdown, notePath, pdfKeys);
  }
}
