import { createZoteroPdfTextResolver } from '@/features/chat/linked-content/ZoteroPdfText';
import { ZoteroStorageFullTextCache } from '@/features/chat/linked-content/ZoteroStorageFullText';

describe('createZoteroPdfTextResolver', () => {
  it('extracts every page when Zotero full-text cache is truncated', async () => {
    const storage = new ZoteroStorageFullTextCache({
      storageRoot: 'C:/Zotero/storage',
      listDirectory: async () => ['book.pdf'],
      statFile: async () => ({ mtimeMs: 1, size: 10 }),
      readText: async () => '',
    });
    const resolver = createZoteroPdfTextResolver({
      storage,
      readPdfText: async () => 'page one\fpage two\fpage three',
    });

    await expect(resolver('zotero/LAJSYNM3.pdf')).resolves.toMatchObject({
      status: 'ready',
      fidelity: 'pdf-direct',
      pageCount: 3,
      content: expect.stringContaining('<!-- p.3 -->'),
    });
  });

  it('returns null when the attachment has no PDF file', async () => {
    const storage = new ZoteroStorageFullTextCache({
      storageRoot: 'C:/Zotero/storage',
      listDirectory: async () => ['.zotero-ft-cache'],
    });
    const resolver = createZoteroPdfTextResolver({ storage, readPdfText: jest.fn() });

    await expect(resolver('zotero/LAJSYNM3.pdf')).resolves.toBeNull();
  });
});

