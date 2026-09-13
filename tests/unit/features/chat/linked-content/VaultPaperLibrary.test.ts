import type { App } from 'obsidian';
import { TFile } from 'obsidian';

import { createVaultPaperLibrary } from '@/features/chat/linked-content/VaultPaperLibrary';

const CARD_PATH = '论文/卡片/Light-driven dancing of nematic colloids.md';
const PDF_PATH = '论文/PDF/asilehanlightdriven2025.pdf';
const MANIFEST_PATH = '论文/MD/asilehanlightdriven2025/manifest.json';
const BIBLIOGRAPHY_PATH = '论文/索引/bibliography.json';

const CARD_FRONTMATTER = {
  attachment: [`[[${PDF_PATH}|PDF]]`],
  domain: '液晶与软物质',
  id: 'asilehanlightdriven2025',
  status: 'unread',
  subfield: '液晶斯格明子',
  title: 'Light-driven dancing of nematic colloids in fractional skyrmions and bimerons',
  year: '2025',
};

const MANIFEST = {
  citekey: 'asilehanlightdriven2025',
  page_map: { pages: 13 },
  parsed_at: '2026-09-12T22:30:52.778582+08:00',
  source_pdf: PDF_PATH,
  source_sha256: 'A'.repeat(64),
  status: 'success',
};

const BIBLIOGRAPHY = [{
  DOI: '10.1038/s41467-025-56263-5',
  URL: 'https://www.nature.com/articles/s41467-025-56263-5',
  author: [
    { family: 'Asilehan', given: 'Zhawure' },
    { family: 'Tang', given: 'Wentao' },
    { family: 'Zhang', given: 'Jing' },
  ],
  'container-title': 'Nature Communications',
  id: 'asilehanlightdriven2025',
  issued: { 'date-parts': [[2025, 1, 29]] },
  number: 1,
  page: '1148',
  title: 'Light-driven dancing of nematic colloids in fractional skyrmions and bimerons',
  volume: 16,
}];

function makeFile(path: string, mtime: number): TFile {
  // `TFile` has no public constructor arguments in the shipped typings, so the
  // fields are filled in explicitly; under jest this is the mocked TFile class.
  const file = new TFile();
  const mutable = file as unknown as { path: string; stat: { ctime: number; mtime: number; size: number } };
  mutable.path = path;
  mutable.stat = { ctime: 0, mtime, size: 0 };
  return file;
}

function createApp(options: {
  content?: Record<string, string>;
  frontmatter?: Record<string, Record<string, unknown>>;
  mtimes?: Record<string, number>;
  paths?: readonly string[];
} = {}): App {
  const content = options.content ?? {};
  const mtimes = options.mtimes ?? {};
  const frontmatter = options.frontmatter ?? {};
  // `paths` declares files that exist but have no card frontmatter and no JSON
  // body, such as PDFs, which the cache freshness check needs to see.
  const paths = [
    ...Object.keys(content),
    ...Object.keys(frontmatter),
    ...options.paths ?? [],
  ];
  const files = paths.map(path => makeFile(path, mtimes[path] ?? 0));

  return {
    metadataCache: {
      getFileCache: (file: TFile) => (
        frontmatter[file.path] ? { frontmatter: frontmatter[file.path] } : undefined
      ),
    },
    vault: {
      getAbstractFileByPath: (path: string) => files.find(file => file.path === path) ?? null,
      getFiles: () => files,
      read: async (file: TFile) => content[file.path] ?? '',
    },
  } as unknown as App;
}

function createLibrary(options: Parameters<typeof createApp>[0] = {}) {
  return createVaultPaperLibrary(createApp(options));
}

describe('createVaultPaperLibrary', () => {
  describe('listPapers', () => {
    it('merges a card with its parse manifest', async () => {
      const library = createLibrary({
        content: { [MANIFEST_PATH]: JSON.stringify(MANIFEST) },
        frontmatter: { [CARD_PATH]: CARD_FRONTMATTER },
        paths: [PDF_PATH],
      });

      await expect(library.listPapers()).resolves.toEqual([{
        cache: 'ready',
        cardPath: CARD_PATH,
        citekey: 'asilehanlightdriven2025',
        domain: '液晶与软物质',
        pages: 13,
        parsedAt: '2026-09-12T22:30:52.778582+08:00',
        pdfPath: PDF_PATH,
        status: 'unread',
        subfield: '液晶斯格明子',
        title: 'Light-driven dancing of nematic colloids in fractional skyrmions and bimerons',
        year: 2025,
      }]);
    });

    it('reports a missing cache for a card that was never parsed', async () => {
      const library = createLibrary({ frontmatter: { [CARD_PATH]: CARD_FRONTMATTER } });

      const [entry] = await library.listPapers();
      expect(entry.cache).toBe('missing');
      expect(entry.pages).toBeNull();
      expect(entry.parsedAt).toBeNull();
      // The PDF is resolved from the card attachment even without a manifest.
      expect(entry.pdfPath).toBe(PDF_PATH);
    });

    it('reports a stale cache when the PDF changed after parsing', async () => {
      const parsedAt = Date.parse(MANIFEST.parsed_at);
      const library = createLibrary({
        content: { [MANIFEST_PATH]: JSON.stringify(MANIFEST) },
        frontmatter: { [CARD_PATH]: CARD_FRONTMATTER },
        mtimes: { [PDF_PATH]: parsedAt + 60_000 },
        paths: [PDF_PATH],
      });

      const [entry] = await library.listPapers();
      expect(entry.cache).toBe('stale');
    });

    it('still lists a parsed paper whose card is missing', async () => {
      const library = createLibrary({
        content: { [MANIFEST_PATH]: JSON.stringify(MANIFEST) },
      });

      const [entry] = await library.listPapers();
      expect(entry.citekey).toBe('asilehanlightdriven2025');
      expect(entry.cardPath).toBeNull();
      expect(entry.title).toBe('asilehanlightdriven2025');
      // Without the card there is no PDF file, so the cache cannot be verified.
      expect(entry.cache).toBe('missing');
    });

    it('filters by reading status and by a free-text query', async () => {
      const otherCard = '论文/卡片/Topological robustness.md';
      const options = {
        frontmatter: {
          [CARD_PATH]: CARD_FRONTMATTER,
          [otherCard]: { id: 'guotopological2026', status: 'read', title: 'Topological robustness' },
        },
      };

      await expect(createLibrary(options).listPapers({ status: 'read' }))
        .resolves.toEqual([expect.objectContaining({ citekey: 'guotopological2026' })]);
      await expect(createLibrary(options).listPapers({ query: 'skyrmion' }))
        .resolves.toEqual([expect.objectContaining({ citekey: 'asilehanlightdriven2025' })]);
      await expect(createLibrary(options).listPapers({ query: '液晶斯格明子' }))
        .resolves.toEqual([expect.objectContaining({ citekey: 'asilehanlightdriven2025' })]);
      await expect(createLibrary(options).listPapers({ query: 'nothing matches' }))
        .resolves.toEqual([]);
    });

    it('returns entries sorted by citekey', async () => {
      const library = createLibrary({
        frontmatter: {
          [CARD_PATH]: CARD_FRONTMATTER,
          '论文/卡片/zzz.md': { id: 'zzz2024', title: 'Later' },
          '论文/卡片/aaa.md': { id: 'aaa2020', title: 'Earlier' },
        },
      });

      const citekeys = (await library.listPapers()).map(entry => entry.citekey);
      expect(citekeys).toEqual(['aaa2020', 'asilehanlightdriven2025', 'zzz2024']);
    });

    it('ignores non-card markdown and a broken manifest', async () => {
      const library = createLibrary({
        content: { [MANIFEST_PATH]: '{ not json' },
        frontmatter: {
          [CARD_PATH]: CARD_FRONTMATTER,
          '科研笔记/00-待分类/random.md': { id: 'not-a-paper' },
        },
      });

      const entries = await library.listPapers();
      expect(entries.map(entry => entry.citekey)).toEqual(['asilehanlightdriven2025']);
      expect(entries[0].pages).toBeNull();
    });
  });

  describe('citePaper', () => {
    it('resolves a CSL entry by citekey', async () => {
      const library = createLibrary({
        content: { [BIBLIOGRAPHY_PATH]: JSON.stringify(BIBLIOGRAPHY) },
      });

      await expect(library.citePaper('asilehanlightdriven2025')).resolves.toEqual({
        authors: [
          { family: 'Asilehan', given: 'Zhawure' },
          { family: 'Tang', given: 'Wentao' },
          { family: 'Zhang', given: 'Jing' },
        ],
        citekey: 'asilehanlightdriven2025',
        doi: '10.1038/s41467-025-56263-5',
        issue: '1',
        pages: '1148',
        title: 'Light-driven dancing of nematic colloids in fractional skyrmions and bimerons',
        url: 'https://www.nature.com/articles/s41467-025-56263-5',
        venue: 'Nature Communications',
        volume: '16',
        year: 2025,
      });
    });

    it('also resolves a DOI', async () => {
      const library = createLibrary({
        content: { [BIBLIOGRAPHY_PATH]: JSON.stringify(BIBLIOGRAPHY) },
      });

      await expect(library.citePaper('10.1038/s41467-025-56263-5'))
        .resolves.toEqual(expect.objectContaining({ citekey: 'asilehanlightdriven2025' }));
    });

    it('names the known citekeys when nothing matches', async () => {
      const library = createLibrary({
        content: { [BIBLIOGRAPHY_PATH]: JSON.stringify(BIBLIOGRAPHY) },
      });

      await expect(library.citePaper('nope')).rejects.toThrow(
        /No bibliography entry matches "nope"\. Known citekeys: asilehanlightdriven2025\./u,
      );
    });

    it('explains an absent or unreadable index', async () => {
      await expect(createLibrary().citePaper('x')).rejects.toThrow(/has no entries/u);
      await expect(createLibrary({ content: { [BIBLIOGRAPHY_PATH]: 'oops' } }).citePaper('x'))
        .rejects.toThrow(/is not valid JSON/u);
      await expect(createLibrary({ content: { [BIBLIOGRAPHY_PATH]: '{}' } }).citePaper('x'))
        .rejects.toThrow(/must contain a JSON array/u);
    });
  });
});
