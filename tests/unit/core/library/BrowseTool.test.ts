import {
  BROWSE_TOOL_MAX_LIMIT,
  executeBrowseTool,
  parseBrowseToolInput,
} from '@/core/library/BrowseTool';
import type { PaperLibraryEntry } from '@/core/library/PaperLibrary';

function entry(overrides: Partial<PaperLibraryEntry> = {}): PaperLibraryEntry {
  return {
    cache: 'ready',
    cardPath: '论文/卡片/Current.md',
    citekey: 'current',
    domain: '液晶与软物质',
    pages: 13,
    parsedAt: '2026-09-12T22:30:52+08:00',
    pdfPath: '论文/PDF/current.pdf',
    status: 'unread',
    subfield: '液晶斯格明子',
    title: 'Current paper',
    year: 2025,
    ...overrides,
  };
}

function libraryOf(entries: readonly PaperLibraryEntry[]) {
  const listPapers = jest.fn().mockResolvedValue(entries);
  return { library: { listPapers }, listPapers };
}

describe('browse tool', () => {
  it('renders classification, status, cache, and title for each entry', async () => {
    const { library } = libraryOf([entry()]);

    const output = await executeBrowseTool(library, {});

    expect(output).toBe([
      'Papers: 1',
      'current | 2025 | 液晶与软物质 / 液晶斯格明子 | unread | cache ready, 13 pages | Current paper',
    ].join('\n'));
  });

  it('degrades gracefully when metadata is missing', async () => {
    const { library } = libraryOf([entry({
      cache: 'missing',
      domain: null,
      pages: null,
      status: null,
      subfield: null,
      year: null,
    })]);

    const output = await executeBrowseTool(library, {});

    expect(output).toContain('current | n.d. | unclassified | status unknown | cache missing');
  });

  it('reports how many matches the limit hides', async () => {
    const { library } = libraryOf([
      entry({ citekey: 'a' }),
      entry({ citekey: 'b' }),
      entry({ citekey: 'c' }),
    ]);

    const output = await executeBrowseTool(library, { limit: 2 });

    expect(output.split('\n')[0]).toBe('Papers: 3 matched, showing 2');
    expect(output).not.toContain('c | ');
  });

  it('distinguishes an empty match from an empty library', async () => {
    const { library } = libraryOf([]);

    await expect(executeBrowseTool(library, { query: 'skyrmion', status: 'read' }))
      .resolves.toBe('No papers match query "skyrmion" and status "read".');
    await expect(executeBrowseTool(library, {}))
      .resolves.toBe('The paper library is empty. Import a paper into 论文/卡片 first.');
  });

  it('forwards only the filters that were provided', async () => {
    const { library, listPapers } = libraryOf([]);

    await executeBrowseTool(library, { status: 'read' });
    expect(listPapers).toHaveBeenCalledWith({ status: 'read' });

    await executeBrowseTool(library, {});
    expect(listPapers).toHaveBeenLastCalledWith({});
  });

  it('rejects malformed arguments', () => {
    expect(() => parseBrowseToolInput({ query: 5 })).toThrow('query must be a string.');
    expect(() => parseBrowseToolInput({ status: [] })).toThrow('status must be a string.');
    expect(() => parseBrowseToolInput({ limit: 'many' })).toThrow('limit must be a number.');
    expect(() => parseBrowseToolInput({ limit: 0 })).toThrow(
      `limit must be between 1 and ${BROWSE_TOOL_MAX_LIMIT}.`,
    );
    expect(() => parseBrowseToolInput({ limit: BROWSE_TOOL_MAX_LIMIT + 1 })).toThrow(
      `limit must be between 1 and ${BROWSE_TOOL_MAX_LIMIT}.`,
    );
  });

  it('drops blank filters and floors fractional limits', () => {
    expect(parseBrowseToolInput({ query: '  ', status: ' ' })).toEqual({});
    expect(parseBrowseToolInput({ limit: 2.7 })).toEqual({ limit: 2 });
    expect(parseBrowseToolInput(null)).toEqual({});
    expect(parseBrowseToolInput('nonsense')).toEqual({});
  });
});
