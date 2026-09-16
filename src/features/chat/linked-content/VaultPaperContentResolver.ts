import path from 'node:path';

import type { App, TFile } from 'obsidian';
import { TFile as ObsidianFile } from 'obsidian';

import { LlmForZoteroMineruCache } from './LlmForZoteroMineruCache';
import { PaperContentResolver, type PaperContentResult } from './PaperContentResolver';
import { createZoteroFullTextContentResolver } from './ZoteroFullTextPaperContent';
import { createZoteroPdfTextResolver } from './ZoteroPdfText';
import { resolveZoteroStorageRoot, ZoteroStorageFullTextCache } from './ZoteroStorageFullText';

export interface VaultPaperContentResolverOptions {
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
 * 2. Zotero's own full-text cache - usually present for a synced attachment.
 * 3. A direct desktop PDF extraction when Zotero's cache is truncated or absent.
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

  const externalCacheRoot = resolveLlmForZoteroCacheRoot(options.llmForZoteroCacheRoot);
  const externalCache = externalCacheRoot
    ? new LlmForZoteroMineruCache({ cacheRoot: externalCacheRoot })
    : null;

  // The legacy Claudian setting points at Zotero's data directory and needs
  // `/storage` appended. ZotFlow's setting already points at that concrete
  // storage folder (it joins `<path>/<attachment-key>/<filename>` itself).
  const configuredDataDirectory = options.zoteroDataDirectory?.trim();
  const storageRoot = configuredDataDirectory
    ? resolveZoteroStorageRoot(configuredDataDirectory)
    : options.zotFlowStoragePath?.trim() || resolveZoteroStorageRoot();
  // Both fallback tiers consult the same metadata/text cache. Apart from
  // avoiding duplicate file reads, this guarantees that a direct PDF fallback
  // and the plain-text tier observe the same attachment directory snapshot.
  const zoteroStorage = storageRoot
    ? new ZoteroStorageFullTextCache({ storageRoot })
    : null;
  const zoteroFullText = zoteroStorage
    ? createZoteroFullTextContentResolver({ fullText: zoteroStorage })
    : null;
  const zoteroPdfText = zoteroStorage
    ? createZoteroPdfTextResolver({
      storage: zoteroStorage,
      readPdfText: options.readPdfText,
    })
    : null;

  /**
   * The MinerU tier answers with a *diagnosis* rather than null when it finds
   * nothing, so a non-ready result must not end the chain - otherwise the
   * full-text tier behind it would never run. A diagnosis is only returned once
   * every later tier has also declined, and a stale parse loses to the
   * full-text cache because Zotero extracted that from the current PDF.
   */
  const resolveExternalCache = async (sourcePath: string): Promise<PaperContentResult | null> => {
    const parsed = await externalCache?.resolve(sourcePath);
    if (parsed?.status === 'ready') return parsed;

    const extracted = zoteroFullText ? await zoteroFullText(sourcePath) : null;
    // Zotero's extractor is intentionally capped for long documents. Prefer a
    // direct PDF pass when that caveat is present so pages after the cap stay
    // readable; retain the cache as a fallback if pdftotext is unavailable.
    const needsDirect = extracted?.warnings?.some(warning => warning.includes('stops near 100 pages'));
    const direct = needsDirect || !extracted
      ? (zoteroPdfText ? await zoteroPdfText(sourcePath) : null)
      : null;
    if (direct) return direct;
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
