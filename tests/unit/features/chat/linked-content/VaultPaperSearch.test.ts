import type { App } from 'obsidian';
import { TFile } from 'obsidian';

import type { EmbeddingClient } from '@/core/search/embedding';
import { createVaultPaperSearch } from '@/features/chat/linked-content/VaultPaperSearch';

const CARD_PATH = '论文/卡片/Light-driven dancing.md';
const PAGGED_PATH = '论文/MD/citeX/citeX.paged.md';
const UNANCHORED_PATH = '论文/MD/citeX/citeX.md';
const PDF_PATH = '论文/PDF/citeX.pdf';
const ENTRY_PATH = '科研笔记/00-入口/dashboard.md';
const SKIP_PATH = '.agents/notes/secret.md';
const REGULAR_NOTE_PATH = '科研笔记/2026-09-13.md';

const CARD_TEXT = [
  '---',
  'title: Light-driven dancing of nematic colloids',
  'id: citeX',
  'domain: 液晶与软物质',
  'year: 2025',
  'tags: [literature_note]',
  '---',
  '',
  '# Light-driven dancing of nematic colloids',
  '',
  'A note worth keeping alongside the paper.',
  '',
].join('\n');

const PAGGED_TEXT = [
  '<!-- p.3 -->',
  '## Findings',
  'We observe robust nematic skyrmion propagation through atmospheric turbulence.',
  'The result supports the topological robustness claim.',
  '',
].join('\n');

const UNANCHORED_TEXT = [
  '# citeX unanchored summary',
  '',
  'This duplicate note discusses colloid under torque but has no page anchors.',
  'It must not contribute to the search index.',
  '',
].join('\n');

const ENTRY_TEXT = [
  '---',
  'title: Dashboard',
  '---',
  '',
  'This entry page summarises recent reads; it should not pollute paper results.',
  'Entry pages belong to the 00-入口 directory and are excluded on purpose.',
  '',
].join('\n');

const SKIP_TEXT = [
  '# Confidential scratchpad',
  '',
  'Top-secret intelligence about the project that should never surface in search.',
  '',
].join('\n');

const NOTE_TEXT = [
  '---',
  'title: Open question on skyrmion stability',
  '---',
  '',
  'A research note comparing this weeks measurements with the historical baseline.',
  '',
].join('\n');

function makeFile(path: string): TFile {
  const file = new TFile();
  const mutable = file as unknown as { extension: string; path: string; stat: { ctime: number; mtime: number; size: number } };
  mutable.path = path;
  mutable.extension = path.split('.').pop()?.toLocaleLowerCase() ?? '';
  mutable.stat = { ctime: 0, mtime: 0, size: 0 };
  return file;
}

function buildApp(options: {
  content?: Record<string, string>;
  paths?: readonly string[];
} = {}): App {
  const content = options.content ?? {};
  const paths = [...new Set([...Object.keys(content), ...(options.paths ?? [])])];
  const files = paths.map(makeFile);
  return {
    vault: {
      cachedRead: jest.fn().mockImplementation(async (file: TFile) => content[file.path] ?? ''),
      getFiles: () => files,
    },
  } as unknown as App;
}

function recordingEmbedding(overrides: Partial<EmbeddingClient> = {}): EmbeddingClient & { embedCalls: number; lastQuery: string | null } {
  const state = { embedCalls: 0, lastQuery: null as string | null };
  const client = {
    isEnabled: true,
    lastQuery: null as string | null,
    model: 'stub',
    async embedPassages(texts: readonly string[]) {
      state.embedCalls += texts.length;
      return texts.map(text => Float32Array.from([text.length, text.length + 1, text.length + 2]));
    },
    async embedQuery(text: string) {
      state.lastQuery = text;
      return Float32Array.from([1, 2, 3]);
    },
    ...overrides,
  } as EmbeddingClient & { embedCalls: number; lastQuery: string | null };
  // Expose the live counter as a getter so tests can read it after each call.
  Object.defineProperty(client, 'embedCalls', { get: () => state.embedCalls });
  Object.defineProperty(client, 'lastQuery', { get: () => state.lastQuery });
  return client;
}

function withVault<T>(
  options: Parameters<typeof buildApp>[0] & { embedding?: EmbeddingClient; vectorStore?: Parameters<typeof createVaultPaperSearch>[0]['vectorStore'] },
  callback: (impl: ReturnType<typeof createVaultPaperSearch>, embedding: ReturnType<typeof recordingEmbedding>) => Promise<T>,
): Promise<T> {
  const embedding = options.embedding ?? recordingEmbedding();
  const impl = createVaultPaperSearch({
    app: buildApp(options),
    embedding,
    ...(options.vectorStore === undefined ? {} : { vectorStore: options.vectorStore }),
  });
  return callback(impl, embedding as ReturnType<typeof recordingEmbedding>);
}

describe('createVaultPaperSearch', () => {
  it('prefers the paged Markdown over the unanchored duplicate (defect 4)', async () => {
    // A term that only the unanchored copy contains must not surface, because
    // indexing both would give the paper two competing representations.
    await withVault(
      { content: { [CARD_PATH]: CARD_TEXT, [PAGGED_PATH]: PAGGED_TEXT, [UNANCHORED_PATH]: UNANCHORED_TEXT }, paths: [PDF_PATH] },
      async impl => {
        const result = await impl.searchPapers({ query: 'colloid under torque' });
        // The structural guarantee: the unanchored path never appears.
        expect(result.hits.find(hit => hit.path === UNANCHORED_PATH)).toBeUndefined();
        // The unanchored copy was filtered out of the index, so only the card
        // and the paged Markdown count toward `index.files`.
        expect(result.index.files).toBe(2);
      },
    );
  });

  it('does not index the raw PDF even when the user has parsed the paper (defect 4)', async () => {
    // The old kb.py index pushed every PDF through pdftotext *and* indexed the
    // MinerU Markdown, so one paper produced two competing chunk sets. Only
    // the Markdown channel exists now.
    await withVault(
      { content: { [CARD_PATH]: CARD_TEXT, [PAGGED_PATH]: PAGGED_TEXT }, paths: [PDF_PATH] },
      async impl => {
        const result = await impl.searchPapers({ query: 'nematic skyrmion' });
        expect(result.hits.length).toBeGreaterThan(0);
        for (const hit of result.hits) {
          expect(hit.path.endsWith('.pdf')).toBe(false);
        }
        // The PDF's name is not in the corpus and not in any hit.
        expect(result.hits.find(hit => hit.path === PDF_PATH)).toBeUndefined();
        expect(result.index.files).toBe(2);
      },
    );
  });

  it('cites a page locator for content from a paged Markdown', async () => {
    await withVault(
      { content: { [CARD_PATH]: CARD_TEXT, [PAGGED_PATH]: PAGGED_TEXT } },
      async impl => {
        const result = await impl.searchPapers({ query: 'nematic skyrmion propagation' });
        const top = result.hits[0];
        expect(top.path).toBe(PAGGED_PATH);
        expect(top.heading).toBe('Findings');
        // An exact page locator is what makes the citation actionable.
        expect(top.locator).toMatch(/^p\.\d+/u);
      },
    );
  });

  it('skips files under the recorded ignore directories', async () => {
    await withVault(
      { content: {
        [CARD_PATH]: CARD_TEXT,
        [PAGGED_PATH]: PAGGED_TEXT,
        [SKIP_PATH]: SKIP_TEXT,
      } },
      async impl => {
        const result = await impl.searchPapers({ query: 'intelligence' });
        expect(result.hits.find(hit => hit.path === SKIP_PATH)).toBeUndefined();
      },
    );
  });

  it('excludes entry-page bodies but keeps their metadata in the index', async () => {
    await withVault(
      { content: {
        [CARD_PATH]: CARD_TEXT,
        [PAGGED_PATH]: PAGGED_TEXT,
        [ENTRY_PATH]: ENTRY_TEXT,
      } },
      async impl => {
        // The structural guarantee: no body chunk from the entry page is ever
        // returned, even when the term match is real.
        const all = await impl.searchPapers({ query: 'summarises recent reads' });
        expect(all.hits.find(hit => hit.path === ENTRY_PATH && hit.kind === 'md'))
          .toBeUndefined();

        // The card frontmatter is still searchable by its id.
        const byId = await impl.searchPapers({ query: 'citeX', kind: 'meta' });
        expect(byId.hits.length).toBeGreaterThan(0);
        expect(byId.hits[0].kind).toBe('meta');
        expect(byId.hits[0].path).toBe(CARD_PATH);
      },
    );
  });

  it('restricts results to a path or path segment via scope', async () => {
    await withVault(
      { content: {
        [CARD_PATH]: CARD_TEXT,
        [PAGGED_PATH]: PAGGED_TEXT,
        [REGULAR_NOTE_PATH]: NOTE_TEXT,
      } },
      async impl => {
        // A general search finds both the paged paper and the research note.
        const general = await impl.searchPapers({ query: 'skyrmion' });
        const generalPaths = general.hits.map(hit => hit.path);
        expect(generalPaths).toContain(PAGGED_PATH);
        expect(generalPaths.some(path => path.startsWith('科研笔记/'))).toBe(true);

        // A scope filter narrows the result to the MD directory.
        const scoped = await impl.searchPapers({ query: 'skyrmion', scope: '论文/MD' });
        for (const hit of scoped.hits) {
          expect(hit.path.startsWith('论文/MD/')).toBe(true);
        }
      },
    );
  });

  it('reuses cached vectors on a second search and does not re-embed', async () => {
    const memoryStore = new Map<string, string>();
    const store = {
      load: jest.fn().mockResolvedValue(new Map(memoryStore)),
      save: jest.fn().mockImplementation(async (vectors: Map<string, string>, _model: string) => {
        for (const [k, v] of vectors) memoryStore.set(k, v);
      }),
    };
    const embedding = recordingEmbedding();
    const impl = createVaultPaperSearch({
      app: buildApp({ content: { [CARD_PATH]: CARD_TEXT, [PAGGED_PATH]: PAGGED_TEXT } }),
      embedding,
      vectorStore: store,
    });

    await impl.searchPapers({ query: 'nematic skyrmion' });
    const firstCalls = embedding.embedCalls;
    expect(firstCalls).toBeGreaterThan(0);
    expect(store.save).toHaveBeenCalled();

    // A second search on the same corpus reads from the in-memory map and
    // must not call the embedding endpoint again.
    await impl.searchPapers({ query: 'nematic skyrmion turbulence' });
    expect(embedding.embedCalls).toBe(firstCalls);
  });

  it('falls back to keyword search when the embedding endpoint is disabled', async () => {
    const embedding = recordingEmbedding({
      isEnabled: false,
      disabledReason: 'no endpoint configured',
    });

    await withVault(
      { content: { [CARD_PATH]: CARD_TEXT, [PAGGED_PATH]: PAGGED_TEXT }, embedding },
      async (impl, current) => {
        // Hybrid mode still returns hits, but reports the loss honestly.
        const result = await impl.searchPapers({ query: 'nematic skyrmion' });
        expect(result.hits.length).toBeGreaterThan(0);
        expect(result.degraded).toBe('no endpoint configured');
        expect(current.embedCalls).toBe(0);
      },
    );
  });

  it('throws a real error in semantic mode when no vectors can be produced', async () => {
    const embedding = recordingEmbedding({
      isEnabled: false,
      disabledReason: 'no endpoint configured',
    });

    await withVault(
      { content: { [CARD_PATH]: CARD_TEXT, [PAGGED_PATH]: PAGGED_TEXT }, embedding },
      async impl => {
        await expect(impl.searchPapers({ mode: 'semantic', query: 'nematic skyrmion' }))
          .rejects.toThrow(/no endpoint configured/);
      },
    );
  });

  it('reports an empty index without erroring', async () => {
    const embedding = recordingEmbedding();
    const impl = createVaultPaperSearch({ app: buildApp(), embedding });

    const result = await impl.searchPapers({ query: 'anything' });
    expect(result.hits).toEqual([]);
    expect(result.degraded).toBeNull();
    expect(result.index).toEqual({ chunks: 0, embedded: 0, files: 0 });
  });
});
