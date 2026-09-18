import { LlmForZoteroMineruCache } from '@/features/chat/linked-content/LlmForZoteroMineruCache';

describe('LlmForZoteroMineruCache', () => {
  it('enumerates attachment sources with manifest metadata for the Zotero library', async () => {
    const cache = new LlmForZoteroMineruCache({
      cacheRoot: 'C:/Users/test/Zotero/llm-for-zotero-mineru',
      listDirectories: async () => ['187'],
      readText: async (path) => {
        if (path.endsWith('_llm_source.json')) {
          return JSON.stringify({
            attachmentKey: 'HKN2KF9N',
            parentItemKey: 'PARENT01',
            sourceFilename: 'Paper.pdf',
            parsedAt: '2026-09-14T00:00:00.000Z',
          });
        }
        if (path.endsWith('manifest.json')) return JSON.stringify({ totalPages: 12 });
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    await expect(cache.listSources()).resolves.toEqual([{
      attachmentKey: 'HKN2KF9N',
      parentItemKey: 'PARENT01',
      directory: '187',
      sourceFilename: 'Paper.pdf',
      parsedAt: '2026-09-14T00:00:00.000Z',
      pages: 12,
    }]);
  });

  it('resolves a native ZotFlow attachment from its llm-for-zotero cache and restores page anchors', async () => {
    const cache = new LlmForZoteroMineruCache({
      cacheRoot: 'C:/Users/test/Zotero/llm-for-zotero-mineru',
      listDirectories: async () => ['187'],
      readText: async (path) => {
        if (path.endsWith('_llm_source.json')) {
          return JSON.stringify({ attachmentKey: 'HKN2KF9N', sourceFilename: 'Paper.pdf' });
        }
        if (path.endsWith('content_list.json')) {
          return JSON.stringify([
            { page_idx: 0, text: 'First page' },
            { page_idx: 1, text: 'Second page' },
          ]);
        }
        if (path.endsWith('full.md')) return 'First page\n\nSecond page';
        if (path.endsWith('manifest.json')) return JSON.stringify({ totalPages: 2 });
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    await expect(cache.resolve('zotero/HKN2KF9N.pdf')).resolves.toMatchObject({
      status: 'ready',
      sourcePath: 'zotero/HKN2KF9N.pdf',
      cachePath: 'llm-for-zotero-mineru/187/full.md',
      content: '<!-- p.1 -->\n\nFirst page\n\n<!-- p.2 -->\n\nSecond page\n',
      manifest: expect.objectContaining({ totalPages: 2 }),
    });
  });

  it('reuses full.md when auxiliary metadata files are absent', async () => {
    const cache = new LlmForZoteroMineruCache({
      cacheRoot: 'C:/Users/test/Zotero/llm-for-zotero-mineru',
      listDirectories: async () => ['188'],
      readText: async (path) => {
        if (path.endsWith('_llm_source.json')) {
          return JSON.stringify({ attachmentKey: 'MISSMETA' });
        }
        if (path.endsWith('full.md')) return '# Abstract\n\nA cached answer.';
        throw new Error('metadata unavailable');
      },
    });

    await expect(cache.resolve('zotero/MISSMETA.pdf')).resolves.toMatchObject({
      status: 'ready',
      fidelity: 'mineru-md',
      content: expect.stringContaining('A cached answer.'),
    });
  });

  it('reuses unchanged cache files across repeated search intake', async () => {
    const reads = new Map<string, number>();
    const cache = new LlmForZoteroMineruCache({
      cacheRoot: 'C:/Users/test/Zotero/llm-for-zotero-mineru',
      listDirectories: async () => ['189'],
      statFile: async filePath => ({ mtimeMs: 1, size: filePath.length }),
      readText: async filePath => {
        reads.set(filePath, (reads.get(filePath) ?? 0) + 1);
        if (filePath.endsWith('_llm_source.json')) {
          return JSON.stringify({ attachmentKey: 'CACHED01' });
        }
        if (filePath.endsWith('full.md')) return '# Cached paper';
        if (filePath.endsWith('content_list.json')) return '[]';
        throw new Error(`Unexpected path: ${filePath}`);
      },
    });

    await cache.listDocuments();
    await cache.listDocuments();

    const fullTextPath = [...reads.keys()].find(filePath => filePath.endsWith('full.md'));
    expect(fullTextPath).toBeDefined();
    expect(reads.get(fullTextPath as string)).toBe(1);
  });

  it('keeps the real page number when a merged cache crosses page 100', async () => {
    const cache = new LlmForZoteroMineruCache({
      cacheRoot: 'C:/Users/test/Zotero/llm-for-zotero-mineru',
      listDirectories: async () => ['190'],
      readText: async filePath => {
        if (filePath.endsWith('_llm_source.json')) {
          return JSON.stringify({ attachmentKey: 'LONGPAPR' });
        }
        if (filePath.endsWith('content_list.json')) {
          return JSON.stringify([
            { page_idx: 0, text: 'First chunk' },
            { page_idx: 100, text: 'Second chunk' },
          ]);
        }
        if (filePath.endsWith('full.md')) return 'First chunk\n\nSecond chunk';
        if (filePath.endsWith('manifest.json')) return JSON.stringify({ totalPages: 101 });
        throw new Error(`Unexpected path: ${filePath}`);
      },
    });

    await expect(cache.resolve('zotero/LONGPAPR.pdf')).resolves.toMatchObject({
      status: 'ready',
      pageCount: 101,
      content: expect.stringContaining('<!-- p.101 -->'),
    });
  });
});
