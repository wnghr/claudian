import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import type { App } from 'obsidian';

import { PaperReader } from '@/features/chat/linked-content/PaperReader';
import { createVaultPaperContentResolver } from '@/features/chat/linked-content/VaultPaperContentResolver';
import { parseZoteroAttachmentReference } from '@/features/chat/linked-content/ZoteroAttachmentReference';
import { ZoteroReadingPositionReader } from '@/features/chat/linked-content/ZoteroReadingPosition';
import {
  resolveZoteroStorageRoot,
  ZoteroStorageFullTextCache,
} from '@/features/chat/linked-content/ZoteroStorageFullText';
import { ZotFlowLocator } from '@/features/chat/linked-content/ZotFlowLocator';

/**
 * Acceptance run against the real vault and the real Zotero storage folder.
 *
 * It is skipped unless `CLAUDIAN_ACCEPTANCE_VAULT` points at a vault, because it
 * asserts on actual papers on disk rather than on fixtures:
 *
 *   CLAUDIAN_ACCEPTANCE_VAULT=D:/research/research npx jest --selectProjects integration
 *
 * The papers live in Zotero, not in the vault - the vault holds source notes
 * only - so this is the only place the `Zotero/<key>/.zotero-ft-cache` route
 * gets exercised end to end, next to the MinerU route it falls back from.
 */
const VAULT = process.env.CLAUDIAN_ACCEPTANCE_VAULT?.trim() ?? '';
const NOTE_PATH = '文献/My Library/@asilehanLightdrivenDancingNematic2025a.md';
/** Parsed by llm-for-zotero, so the article exercises the MinerU tier. */
const PARSED_ATTACHMENT = '8ZJQUTW2';
const PARSED_PAGES = 13;
/** A 407-page book Zotero extracts only partially; no MinerU parse exists. */
const UNPARSED_ATTACHMENT = 'LAJSYNM3';

const storageRoot = resolveZoteroStorageRoot(undefined);
const enabled = Boolean(
  VAULT
  && existsSync(VAULT)
  && existsSync(path.join(VAULT, NOTE_PATH))
  && storageRoot
  && existsSync(path.join(storageRoot, PARSED_ATTACHMENT, '.zotero-ft-cache')),
);

const describeAcceptance = enabled ? describe : describe.skip;

describeAcceptance('read_pdf against the real vault', () => {
  /** The vault has no PDFs, so only the note and attachment lookups matter. */
  function createApp(): App {
    return {
      vault: {
        getAbstractFilesByPath: () => null,
        getAbstractFileByPath: () => null,
        getFiles: () => [],
      },
    } as unknown as App;
  }

  function createLocator(): ZotFlowLocator {
    const fullText = storageRoot
      ? new ZoteroStorageFullTextCache({ storageRoot })
      : null;
    return new ZotFlowLocator({
      readNote: async notePath => {
        const filePath = path.join(VAULT, notePath);
        return existsSync(filePath) ? await fs.readFile(filePath, 'utf8') : null;
      },
      listReaderStates: () => [],
      isPdfAttachment: async key => (await fullText?.hasAttachmentFile(key) ?? false),
    });
  }

  function createReader(): PaperReader {
    const positions = storageRoot
      ? new ZoteroReadingPositionReader({
        storageRoot,
        zotFlowDataFile: path.join(VAULT, '.obsidian', 'plugins', 'zotflow', 'data.json'),
      })
      : null;
    return new PaperReader(
      createVaultPaperContentResolver(createApp()),
      {
        resolveCurrentPage: async sourcePath => {
          const attachmentKey = parseZoteroAttachmentReference(sourcePath);
          if (!attachmentKey || !positions) return null;
          const position = await positions.read({ attachmentKey, libraryID: null });
          return position ? { page: position.page, source: position.source } : null;
        },
      },
    );
  }

  it('finds the attachment behind a source note whose zotero-key is a parent item', async () => {
    const target = await createLocator().resolve(NOTE_PATH);

    expect(target).toMatchObject({
      attachmentKey: PARSED_ATTACHMENT,
      origin: 'source-note',
      sourcePath: `zotero/${PARSED_ATTACHMENT}.pdf`,
    });
    // The note's own `zotero-key` is the parent, never a readable attachment.
    expect(target?.parentItemKey).not.toBe(PARSED_ATTACHMENT);
  });

  it('reads a real article page-by-page and reports the parse as the source', async () => {
    const result = await createReader().read({
      pages: '5',
      sourcePath: `zotero/${PARSED_ATTACHMENT}.pdf`,
    });

    expect(result.fidelity).toBe('mineru-md');
    expect(result.pageCount).toBe(PARSED_PAGES);
    expect(result.selection).toBe('p.5');
    expect(result.content).toContain('<!-- p.5 -->');
    // Real prose, not a placeholder: the requested page must carry substance.
    expect(result.content.replace(/<!--[^>]*-->/g, '').trim().length).toBeGreaterThan(500);
  });

  it('falls back to direct PDF extraction when Zotero\'s cache is truncated', async () => {
    const result = await createReader().read({
      pages: '5',
      sourcePath: `zotero/${UNPARSED_ATTACHMENT}.pdf`,
    });

    expect(result.fidelity).toBe('pdf-direct');
    expect(result.pageCount).toBeGreaterThan(99);
    expect(result.content).toContain('<!-- p.5 -->');
    expect(result.warnings.join(' ')).toContain('pdftotext');
  });

  it('reports the reader position ZotFlow recorded for a paper it has opened', async () => {
    const result = await createReader().read({
      pages: '1',
      sourcePath: `zotero/${UNPARSED_ATTACHMENT}.pdf`,
    });

    expect(result.currentPage?.page).toBeGreaterThan(0);
    expect(['zotflow-view-state', 'zotero-reader-state']).toContain(result.currentPage?.source);
  });

  it('reads a page beyond Zotero\'s historical 99-page extraction cap', async () => {
    const result = await createReader().read({
      pages: '100',
      sourcePath: `zotero/${UNPARSED_ATTACHMENT}.pdf`,
    });
    expect(result.fidelity).toBe('pdf-direct');
    expect(result.content).toContain('<!-- p.100 -->');
  });
});
