import { createZoteroFullTextContentResolver } from '@/features/chat/linked-content/ZoteroFullTextPaperContent';
import { ZoteroStorageFullTextCache } from '@/features/chat/linked-content/ZoteroStorageFullText';

function createTier(text: string | null) {
  const fullText = new ZoteroStorageFullTextCache({
    storageRoot: 'C:\\Users\\me\\Zotero\\storage',
    readText: async () => {
      if (text === null) throw new Error('ENOENT');
      return text;
    },
    statFile: async () => ({ mtimeMs: 1, size: text?.length ?? 0 }),
  });
  return createZoteroFullTextContentResolver({ fullText });
}

describe('createZoteroFullTextContentResolver', () => {
  it('serves an attachment from Zotero\'s full-text cache and labels it', async () => {
    const resolve = createTier('Body of page one\fBody of page two');

    await expect(resolve('zotero/8ZJQUTW2.pdf')).resolves.toMatchObject({
      status: 'ready',
      sourcePath: 'zotero/8ZJQUTW2.pdf',
      fidelity: 'zotero-fulltext',
      pageCount: 2,
      warnings: [],
    });
  });

  it('carries the truncation caveat for a document at the extraction limit', async () => {
    const text = Array.from({ length: 99 }, (_, index) => `page ${index + 1}`).join('\f');
    const result = await createTier(text)('zotero/LAJSYNM3.pdf');

    expect(result).toMatchObject({ fidelity: 'zotero-fulltext', pageCount: 99 });
    expect(result?.warnings?.[0]).toContain('stops near 100 pages');
  });

  it('leaves vault paths and unknown attachments to the other tiers', async () => {
    const resolve = createTier('text');
    await expect(resolve('论文/PDF/paper.pdf')).resolves.toBeNull();
    await expect(resolve('zotero/NOPE.pdf')).resolves.toBeNull();
  });

  it('declines when Zotero has no extracted text', async () => {
    await expect(createTier(null)('zotero/8ZJQUTW2.pdf')).resolves.toBeNull();
  });
});
