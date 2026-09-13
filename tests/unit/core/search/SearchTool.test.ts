import type {
  PaperSearchHit,
  PaperSearchPort,
  PaperSearchRequest,
  PaperSearchResult,
} from '@/core/search/PaperSearch';
import {
  executeSearchTool,
  formatPaperSearchResult,
  parseSearchToolInput,
} from '@/core/search/SearchTool';

function buildHit(overrides: Partial<PaperSearchHit> = {}): PaperSearchHit {
  return {
    body: 'A passage about nematic skyrmion dynamics.',
    heading: 'Results > Topological robustness',
    kind: 'md',
    locator: 'p.5',
    path: '论文/MD/guo/guo.paged.md',
    score: 0.0312,
    snippet: '…nematic skyrmion dynamics…',
    ...overrides,
  };
}

function buildResult(overrides: Partial<PaperSearchResult> = {}): PaperSearchResult {
  return {
    degraded: null,
    hits: [buildHit()],
    index: { chunks: 12, embedded: 12, files: 2 },
    mode: 'hybrid',
    query: 'nematic skyrmion',
    ...overrides,
  };
}

describe('parseSearchToolInput', () => {
  it('requires a non-empty query', () => {
    expect(() => parseSearchToolInput({})).toThrow(/query/i);
    expect(() => parseSearchToolInput({ query: '  ' })).toThrow(/query/i);
  });

  it('trims the query', () => {
    expect(parseSearchToolInput({ query: '  nematic skyrmion  ' })).toEqual({
      query: 'nematic skyrmion',
    });
  });

  it('accepts the documented optional fields', () => {
    expect(parseSearchToolInput({
      kind: 'meta',
      limit: 12,
      mode: 'semantic',
      query: 'nematic',
      scope: '论文/MD',
    })).toEqual({
      kind: 'meta',
      limit: 12,
      mode: 'semantic',
      query: 'nematic',
      scope: '论文/MD',
    });
  });

  it('rejects an unknown mode', () => {
    expect(() => parseSearchToolInput({ mode: 'magic', query: 'x' })).toThrow(/mode/i);
  });

  it('rejects an unknown kind', () => {
    expect(() => parseSearchToolInput({ kind: 'note', query: 'x' })).toThrow(/kind/i);
  });

  it('rejects a limit outside the documented range', () => {
    expect(() => parseSearchToolInput({ limit: 0, query: 'x' })).toThrow(/limit/i);
    expect(() => parseSearchToolInput({ limit: 51, query: 'x' })).toThrow(/limit/i);
  });

  it('coerces a fractional limit downward to an integer', () => {
    expect(parseSearchToolInput({ limit: 12.9, query: 'x' })).toEqual({
      limit: 12,
      query: 'x',
    });
  });
});

describe('formatPaperSearchResult', () => {
  it('names the mode, the hit count, and the index summary', () => {
    const text = formatPaperSearchResult(buildResult());
    expect(text).toContain('Search: nematic skyrmion   (keywords + vectors, 1 hits)');
    expect(text).toContain('Index: 2 files, 12 chunks, 12 embedded');
    expect(text).toContain('1. [0.0312]');
    expect(text).toContain('论文/MD/guo/guo.paged.md  §  Results > Topological robustness  §  p.5');
    expect(text).toContain('…nematic skyrmion dynamics…');
  });

  it('omits the embedded count when only keywords ran', () => {
    const text = formatPaperSearchResult(buildResult({ mode: 'keyword' }));
    expect(text).toContain('Index: 2 files, 12 chunks');
    expect(text).not.toContain('embedded');
  });

  it('surfaces a degradation reason in the header', () => {
    const text = formatPaperSearchResult(buildResult({
      degraded: 'Semantic search is off: no embedding endpoint is configured.',
    }));
    expect(text).toContain('Degraded: Semantic search is off: no embedding endpoint is configured.');
  });

  it('explains a no-hits result honestly', () => {
    const text = formatPaperSearchResult(buildResult({ hits: [] }));
    expect(text).toContain('0 hits');
    expect(text).toContain('No passages matched.');
  });
});

describe('executeSearchTool', () => {
  it('delegates to the port with the parsed request', async () => {
    const searchPapers = jest.fn().mockResolvedValue(buildResult());
    const port: PaperSearchPort = { searchPapers };

    const text = await executeSearchTool(port, {
      limit: 5,
      mode: 'semantic',
      query: 'nematic skyrmion',
    });

    expect(searchPapers).toHaveBeenCalledWith({
      limit: 5,
      mode: 'semantic',
      query: 'nematic skyrmion',
    } satisfies PaperSearchRequest);
    expect(text).toContain('Search: nematic skyrmion');
  });
});
