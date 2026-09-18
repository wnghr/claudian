import type { PaperContentResolver } from '@/features/chat/linked-content/PaperContentResolver';
import { PaperReader } from '@/features/chat/linked-content/PaperReader';

interface ReaderFixture {
  readonly cachePath?: string;
  readonly fidelity?: 'mineru-md' | 'zotero-fulltext';
  readonly manifest?: Record<string, unknown>;
  readonly pageCount?: number;
  readonly warnings?: readonly string[];
}

function createReader(
  content: string,
  options: ReaderFixture | string = {},
  currentPage?: { page: number; source: 'zotflow-view-state' | 'zotero-reader-state' },
) {
  const fixture: ReaderFixture = typeof options === 'string' ? { cachePath: options } : options;
  const resolver = {
    resolve: jest.fn().mockResolvedValue({
      status: 'ready',
      sourcePath: '论文/PDF/current.pdf',
      content,
      complete: true,
      ...(fixture.cachePath ? { cachePath: fixture.cachePath } : {}),
      ...(fixture.fidelity ? { fidelity: fixture.fidelity } : {}),
      ...(fixture.manifest ? { manifest: fixture.manifest } : {}),
      ...(fixture.pageCount !== undefined ? { pageCount: fixture.pageCount } : {}),
      ...(fixture.warnings ? { warnings: fixture.warnings } : {}),
    }),
  } as unknown as PaperContentResolver;
  return {
    reader: new PaperReader(resolver, {
      resolveCurrentPage: async () => currentPage ?? null,
    }),
    resolver,
  };
}

describe('PaperReader', () => {
  it('uses ZotFlow Reader page blocks before cache extraction', async () => {
    const { reader, resolver } = createReader('cache should not win');
    const pageReader = jest.fn().mockResolvedValue({
      pageIndex: 99,
      pageCount: 407,
      blocks: [{ type: 'heading', level: 2, content: [{ text: 'Tail page' }] }],
      pageData: null,
    });
    const pageImageReader = jest.fn().mockResolvedValue({
      pageIndex: 99,
      width: 100,
      height: 140,
      dataUrl: 'data:image/png;base64,abc',
    });

    await expect(reader.read({ sourcePath: 'zotero/TAILKEY.pdf', pages: '100', includeImages: true }, pageReader, pageImageReader))
      .resolves.toMatchObject({
        content: '<!-- p.100 -->\n## Tail page',
        fidelity: 'zotflow-reader',
        pageCount: 407,
        selection: 'p.100',
        images: [{ page: 100, width: 100, height: 140 }],
      });
    expect(pageReader).toHaveBeenCalledWith(99);
    expect(pageImageReader).toHaveBeenCalledWith(99, 1.25);
    expect(resolver.resolve).toHaveBeenCalled();
  });

  it('uses a paged MinerU cache before ZotFlow Reader when it covers the request', async () => {
    const { reader, resolver } = createReader([
      '<!-- p.2 -->',
      'MinerU page with LaTeX $\\alpha$',
    ].join('\n'));
    const pageReader = jest.fn().mockResolvedValue({
      pageIndex: 1,
      pageCount: 407,
      blocks: [{ type: 'heading', level: 2, content: [{ text: 'Reader page' }] }],
      pageData: null,
    });

    await expect(reader.read({ sourcePath: 'zotero/CACHEKEY.pdf', pages: '2' }, pageReader))
      .resolves.toMatchObject({
        content: '<!-- p.2 -->\nMinerU page with LaTeX $\\alpha$',
        fidelity: 'mineru-md',
        selection: 'p.2',
      });
    expect(resolver.resolve).toHaveBeenCalled();
    expect(pageReader).not.toHaveBeenCalled();
  });

  it('falls back to ZotFlow Reader when the cache does not cover the full range', async () => {
    const { reader } = createReader('<!-- p.2 -->\nOnly one cached page');
    const pageReader = jest.fn().mockImplementation(async (pageIndex: number) => ({
      pageIndex,
      pageCount: 407,
      blocks: [{ type: 'paragraph', content: [{ text: `Reader page ${pageIndex + 1}` }] }],
      pageData: null,
    }));

    await expect(reader.read({ sourcePath: 'zotero/PARTIALKEY.pdf', pages: '1-2' }, pageReader))
      .resolves.toMatchObject({
        fidelity: 'zotflow-reader',
        selection: 'p.1-p.2',
      });
    expect(pageReader).toHaveBeenCalledTimes(2);
  });

  it('returns only the requested page range from a paged cache', async () => {
    const { reader } = createReader([
      '<!-- p.1 -->',
      'First page',
      '<!-- p.2 -->',
      'Second page',
      '<!-- p.3 -->',
      'Third page',
    ].join('\n'));

    await expect(reader.read({
      sourcePath: '论文/PDF/current.pdf',
      pages: '2-3',
    })).resolves.toMatchObject({
      content: '<!-- p.2 -->\nSecond page\n\n<!-- p.3 -->\nThird page',
      selection: 'p.2-p.3',
      truncated: false,
    });
  });

  it('returns query-matching passages instead of the whole paper', async () => {
    const { reader } = createReader([
      '# Introduction',
      '',
      'Generic background.',
      '',
      'The skyrmion Hall angle changes under confinement.',
      '',
      'Unrelated appendix.',
    ].join('\n'));

    const result = await reader.read({
      sourcePath: '论文/PDF/current.pdf',
      query: 'skyrmion confinement',
    });

    expect(result.content).toContain('skyrmion Hall angle');
    expect(result.content).not.toContain('Unrelated appendix');
    expect(result.selection).toBe('query: skyrmion confinement');
  });

  it('uses manifest character ranges for section reads when available', async () => {
    const content = '# Introduction\n\nIntro\n\n## Methods\n\nMethod body';
    const methodStart = content.indexOf('## Methods');
    const { reader } = createReader(content, {
      cachePath: '论文/MD/paper/full.md',
      manifest: {
        sections: [{
          heading: 'Methods',
          page: 2,
          charStart: methodStart,
          charEnd: content.length,
          figures: [],
          tables: [],
          equationCount: 0,
        }],
      },
    });

    await expect(reader.read({
      sourcePath: '论文/PDF/current.pdf',
      section: 'methods',
    })).resolves.toMatchObject({
      content: '## Methods\n\nMethod body',
      selection: 'section: Methods',
    });
  });
});

describe('PaperReader current page', () => {
  const PAGES = [
    '<!-- p.1 -->',
    'First page',
    '<!-- p.2 -->',
    'Second page',
    '<!-- p.3 -->',
    'Third page',
  ].join('\n');

  it('reads the page the reader is on when asked for `current`', async () => {
    const { reader } = createReader(PAGES, {}, { page: 2, source: 'zotflow-view-state' });

    await expect(reader.read({
      sourcePath: 'zotero/8ZJQUTW2.pdf',
      pages: 'current',
    })).resolves.toMatchObject({
      content: '<!-- p.2 -->\nSecond page',
      currentPage: { page: 2, source: 'zotflow-view-state' },
      selection: 'p.2',
      truncated: false,
    });
  });

  it('refuses `current` rather than guessing when no position is recorded', async () => {
    const { reader } = createReader(PAGES);

    await expect(reader.read({ sourcePath: 'zotero/8ZJQUTW2.pdf', pages: 'current' }))
      .rejects.toThrow(/No current page is available/);
  });

  it('refuses a page beyond the text instead of returning an empty read', async () => {
    // Zotero's extraction stops near 100 pages, so a book can be open far past
    // the last page that has readable text.
    const { reader } = createReader(PAGES, { pageCount: 3 }, {
      page: 238,
      source: 'zotero-reader-state',
    });

    await expect(reader.read({ sourcePath: 'zotero/LAJSYNM3.pdf', pages: 'current' }))
      .rejects.toThrow(/covers 3 pages/);
  });

  it('warns when the reader sits past the end of the extracted text', async () => {
    const { reader } = createReader(PAGES, { pageCount: 3 }, {
      page: 238,
      source: 'zotero-reader-state',
    });

    const result = await reader.read({ sourcePath: 'zotero/LAJSYNM3.pdf', pages: '1' });
    expect(result.warnings).toContainEqual(expect.stringContaining('readable text stops at page 3'));
  });

  it('passes the producing tier\'s warnings and fidelity through', async () => {
    const { reader } = createReader(PAGES, {
      fidelity: 'zotero-fulltext',
      pageCount: 99,
      warnings: ['Zotero\'s full-text extraction stops near 100 pages'],
    });

    await expect(reader.read({ sourcePath: 'zotero/LAJSYNM3.pdf', pages: '1' }))
      .resolves.toMatchObject({
        fidelity: 'zotero-fulltext',
        pageCount: 99,
        warnings: [expect.stringContaining('stops near 100 pages')],
      });
  });

  it('explains that heading reads are impossible without a Markdown parse', async () => {
    const { reader } = createReader(PAGES, { fidelity: 'zotero-fulltext', pageCount: 3 });

    await expect(reader.read({ sourcePath: 'zotero/8ZJQUTW2.pdf', section: 'methods' }))
      .rejects.toThrow(/no headings/);
  });
});
