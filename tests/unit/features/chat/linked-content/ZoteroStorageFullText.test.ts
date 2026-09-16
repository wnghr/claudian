import path from 'node:path';

import {
  anchorFullTextPages,
  countFullTextPages,
  resolveFullTextAlignment,
  resolveZoteroStorageRoot,
  splitFullTextPages,
  ZoteroStorageFullTextCache,
} from '@/features/chat/linked-content/ZoteroStorageFullText';

const PAGE_MARKER = /^\s*<!--\s*p\.(\d+)\s*-->\s*$/gm;

describe('resolveZoteroStorageRoot', () => {
  it('defaults to a `Zotero/storage` folder under the user profile', () => {
    expect(resolveZoteroStorageRoot(undefined, 'C:\\Users\\me'))
      .toBe(path.join('C:\\Users\\me', 'Zotero', 'storage'));
  });

  it('accepts a relocated data directory and appends `storage` once', () => {
    expect(resolveZoteroStorageRoot('D:\\Zotero', 'C:\\Users\\me'))
      .toBe(path.join('D:\\Zotero', 'storage'));
    expect(resolveZoteroStorageRoot(path.join('D:\\Zotero', 'storage'), 'C:\\Users\\me'))
      .toBe(path.join('D:\\Zotero', 'storage'));
  });

  it('reports no location when there is no profile to fall back on', () => {
    // Only an explicitly empty profile disables the default: `undefined` means
    // "use the process profile".
    expect(resolveZoteroStorageRoot(undefined, '')).toBeNull();
  });
});

describe('full-text page handling', () => {
  it('treats a form feed as a page break and keeps blank pages numbered', () => {
    expect(splitFullTextPages('first\f\fthird')).toEqual(['first', '', 'third']);
    expect(countFullTextPages('first\f\fthird')).toBe(3);
  });

  it('does not count a trailing separator as an extra page', () => {
    // Zotero leaves the separator between pages; a trailing one would otherwise
    // shift every page number after it.
    expect(splitFullTextPages('a\fb\f')).toEqual(['a', 'b']);
    expect(countFullTextPages('a\fb\f')).toBe(2);
  });

  it('anchors every page so page N of the excerpt is page N of the PDF', () => {
    const anchored = anchorFullTextPages('first\f\fthird');
    expect([...anchored.matchAll(PAGE_MARKER)].map(match => match[1])).toEqual(['1', '2', '3']);
    expect(anchored).toContain('third');
  });

  it('is suspicious about documents at the length where extraction stops', () => {
    expect(resolveFullTextAlignment(13)).toBe('exact');
    expect(resolveFullTextAlignment(89)).toBe('exact');
    expect(resolveFullTextAlignment(99)).toBe('suspect');
  });
});

describe('ZoteroStorageFullTextCache', () => {
  const storageRoot = path.join('C:', 'Users', 'me', 'Zotero', 'storage');

  function cacheWith(text: string | null, mtimeMs = 1_000) {
    return new ZoteroStorageFullTextCache({
      storageRoot,
      readText: async () => {
        if (text === null) throw new Error('ENOENT');
        return text;
      },
      statFile: async () => ({ mtimeMs, size: text?.length ?? 0 }),
      listDirectory: async () => ['paper.pdf', '.zotero-ft-cache'],
    });
  }

  it('reads page-anchored content and reports the page count', async () => {
    const fullText = await cacheWith('page one\fpage two').read('ABCD2345');

    expect(fullText).toMatchObject({
      attachmentKey: 'ABCD2345',
      alignment: 'exact',
      mtimeMs: 1_000,
      pageCount: 2,
    });
    expect(fullText?.content).toContain('<!-- p.2 -->');
    expect(fullText?.filePath).toBe(path.join(storageRoot, 'ABCD2345', '.zotero-ft-cache'));
  });

  it('returns null when Zotero never extracted text', async () => {
    await expect(cacheWith(null).read('ABCD2345')).resolves.toBeNull();
    await expect(cacheWith('   ').read('ABCD2345')).resolves.toBeNull();
  });

  it('flags a document long enough to have been truncated', async () => {
    const text = Array.from({ length: 120 }, (_, index) => `page ${index + 1}`).join('\f');
    await expect(cacheWith(text).read('ABCD2345')).resolves.toMatchObject({
      alignment: 'suspect',
      pageCount: 120,
    });
  });

  it('distinguishes a real PDF from a snapshot of a web page', async () => {
    await expect(cacheWith('text').hasAttachmentFile('ABCD2345')).resolves.toBe(true);
    const snapshot = new ZoteroStorageFullTextCache({
      storageRoot,
      listDirectory: async () => ['index.html', '.zotero-ft-cache'],
    });
    await expect(snapshot.hasAttachmentFile('ABCD2345')).resolves.toBe(false);
  });

  it('enumerates cached PDF text for the search index', async () => {
    const cache = new ZoteroStorageFullTextCache({
      storageRoot,
      listDirectories: async () => ['EFGH5678', 'not-an-attachment', 'ABCD2345'],
      listDirectory: async directory => (
        directory.endsWith('ABCD2345') || directory.endsWith('EFGH5678')
          ? ['paper.pdf']
          : []
      ),
      statFile: async filePath => ({ mtimeMs: filePath.includes('ABCD2345') ? 1 : 2, size: 4 }),
      readText: async filePath => filePath.includes('ABCD2345') ? 'first' : 'second',
    });

    await expect(cache.listDocuments()).resolves.toMatchObject([
      { attachmentKey: 'ABCD2345', pageCount: 1 },
      { attachmentKey: 'EFGH5678', pageCount: 1 },
    ]);
  });
});
