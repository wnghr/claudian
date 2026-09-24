import path from 'node:path';

import { type App, FileSystemAdapter, TFile as ObsidianFile, type TFile } from 'obsidian';

import { LlmForZoteroMineruCache } from './LlmForZoteroMineruCache';
import { PaperContentResolver, type PaperContentResult } from './PaperContentResolver';
import { parseZoteroAttachmentReference } from './ZoteroAttachmentReference';
import { createZoteroFullTextContentResolver } from './ZoteroFullTextPaperContent';
import { createDirectPdfTextResolver } from './ZoteroPdfText';
import { resolveZoteroStorageRoot, ZoteroStorageFullTextCache } from './ZoteroStorageFullText';

export interface VaultPaperContentResolverOptions {
  /** Enables external Zotero/ZotFlow content sources. */
  readonly enableZoteroSupport?: boolean;
  readonly llmForZoteroCacheRoot?: string;
  /** Zotero's data directory; its `storage` subfolder holds the attachments. */
  readonly zoteroDataDirectory?: string;
  /**
   * ZotFlow's own configured storage folder, used when no directory is set so
   * the location is only configured once.
   */
  readonly zotFlowStoragePath?: string;
  /** Optional direct PDF extractor; defaults to pdftotext on desktop. */
  readonly readPdfText?: (pdfPath: string) => Promise<string>;
}

export function resolveLlmForZoteroCacheRoot(configuredRoot: string | undefined): string | null {
  const configured = configuredRoot?.trim();
  if (configured) return configured;
  const userProfile = process.env.USERPROFILE ?? process.env.HOME;
  return userProfile ? path.join(userProfile, 'Zotero', 'llm-for-zotero-mineru') : null;
}

/**
 * Content resolution order for a paper:
 *
 * 1. A MinerU parse, if one was configured - full fidelity, page anchors, and
 *    section headings.
 * 2. Direct desktop PDF extraction when MinerU has no usable parse.
 * 3. Zotero's own full-text cache if the direct PDF pass is unavailable.
 * 4. The vault's own `论文/MD` cache, for PDFs that live in the vault.
 *
 * Failing to produce text is reported as a reason, never as an empty read.
 */
export function createVaultPaperContentResolver(
  app: App,
  options: VaultPaperContentResolverOptions = {},
): PaperContentResolver {
  const getVaultFile = (path: string): TFile => {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof ObsidianFile)) {
      throw new Error(`Vault file is unavailable: ${path}`);
    }
    return file;
  };

  const zoteroEnabled = options.enableZoteroSupport !== false;
  const externalCacheRoot = zoteroEnabled
    ? resolveLlmForZoteroCacheRoot(options.llmForZoteroCacheRoot)
    : null;
  const externalCache = externalCacheRoot
    ? new LlmForZoteroMineruCache({ cacheRoot: externalCacheRoot })
    : null;

  // The legacy Claudian setting points at Zotero's data directory and needs
  // `/storage` appended. ZotFlow's setting already points at that concrete
  // storage folder (it joins `<path>/<attachment-key>/<filename>` itself).
  const configuredDataDirectory = options.zoteroDataDirectory?.trim();
  const storageRoot = zoteroEnabled
    ? (configuredDataDirectory
      ? resolveZoteroStorageRoot(configuredDataDirectory)
      : options.zotFlowStoragePath?.trim() || resolveZoteroStorageRoot())
    : null;
  // Both fallback tiers use the same Zotero storage location and attachment
  // lookup, so a failed direct extraction can still fall back to cached text.
  const zoteroStorage = storageRoot
    ? new ZoteroStorageFullTextCache({ storageRoot })
    : null;
  const zoteroFullText = zoteroStorage
    ? createZoteroFullTextContentResolver({ fullText: zoteroStorage })
    : null;
  const directPdfText = createDirectPdfTextResolver({
    readPdfText: options.readPdfText,
    resolvePdfPath: async sourcePath => {
      const attachmentKey = parseZoteroAttachmentReference(sourcePath);
      if (attachmentKey) return zoteroStorage?.attachmentPdfPath(attachmentKey) ?? null;
      const file = app.vault.getAbstractFileByPath(sourcePath);
      const adapter = app.vault.adapter;
      return file instanceof ObsidianFile && adapter instanceof FileSystemAdapter
        ? adapter.getFullPath(file.path)
        : null;
    },
  });

  /**
   * MinerU Markdown is preferred for layout and formula fidelity. Without a
   * usable parse, read the PDF itself first; Zotero's cached plain text remains
   * a fallback when direct extraction is unavailable. A non-ready MinerU
   * result is returned only after both fallback tiers decline.
   */
  const resolveExternalCache = async (sourcePath: string): Promise<PaperContentResult | null> => {
    const parsed = await externalCache?.resolve(sourcePath);
    if (parsed?.status === 'ready') return parsed;

    const direct = await directPdfText(sourcePath);
    if (direct) return direct;

    const extracted = zoteroFullText ? await zoteroFullText(sourcePath) : null;
    if (extracted) return extracted;

    return parsed ?? null;
  };

  return new PaperContentResolver({
    getFile: path => {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof ObsidianFile ? file : null;
    },
    getFiles: () => app.vault.getFiles(),
    read: file => app.vault.read(getVaultFile(file.path)),
    readBinary: file => app.vault.readBinary(getVaultFile(file.path)),
    resolveExternalCache,
  });
}
