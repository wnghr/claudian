import { chunkMarkdown, splitFrontmatter } from '@/core/search/chunking';

const PAGED_PATH = '论文/MD/guotopological2026/guotopological2026.paged.md';

function bodyChunks(text: string) {
  return chunkMarkdown(text, PAGED_PATH).filter(chunk => chunk.kind === 'md');
}

describe('chunkMarkdown', () => {
  it('keeps every page-anchored chunk on exactly one page', () => {
    const text = [
      '<!-- p.1 -->',
      '## Alpha',
      'First page content that is definitely long enough.',
      '<!-- p.2 -->',
      '## Beta',
      'Second page content that is also long enough.',
      '',
    ].join('\n');

    const chunks = bodyChunks(text);

    expect(chunks.map(chunk => chunk.locator)).toEqual(['p.1', 'p.2']);
    expect(chunks.map(chunk => chunk.heading)).toEqual(['Alpha', 'Beta']);
    expect(chunks[0].body).toBe('First page content that is definitely long enough.');
  });

  it('recognizes headings in a CRLF document', () => {
    // Regression: `/^(#+)\s+(.*)$/` matches nothing when lines end with CR, and
    // the whole document then collapses into one unanchored chunk.
    const text = [
      '<!-- p.1 -->',
      '## Alpha',
      'Content line that is long enough for indexing.',
      '',
    ].join('\r\n');

    const chunks = bodyChunks(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Alpha');
    expect(chunks[0].locator).toBe('p.1');
  });

  it('numbers the parts of a page that is too large for one chunk', () => {
    const text = [
      '<!-- p.1 -->',
      '## Alpha',
      'A'.repeat(900),
      '',
      'B'.repeat(900),
      '',
    ].join('\n');

    expect(bodyChunks(text).map(chunk => chunk.locator)).toEqual(['p.1#1', 'p.1#2']);
  });

  it('never puts the page marker inside a chunk body', () => {
    const text = [
      '<!-- p.1 -->',
      '## Alpha',
      'First page content that is definitely long enough.',
      '',
      '<!-- p.2 -->',
      'Second page content that is also long enough.',
      '',
    ].join('\n');

    for (const chunk of bodyChunks(text)) {
      expect(chunk.body).not.toContain('<!--');
    }
  });

  it('drops boilerplate shorter than the minimum chunk size', () => {
    const text = [
      '<!-- p.1 -->',
      'Article',
      '<!-- p.2 -->',
      'A real content line that is long enough.',
      '',
    ].join('\n');

    expect(bodyChunks(text).map(chunk => chunk.locator)).toEqual(['p.2']);
  });

  it('falls back to a line range when the document has no page anchors', () => {
    const text = ['# Title', '', 'line one content here', '', 'line two content here']
      .join('\n');

    const chunks = bodyChunks(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].locator).toBe('L3-5');
    expect(chunks[0].body).toBe('line one content here\n\nline two content here');
  });

  it('gives each split part its own line range instead of a shared one', () => {
    const text = ['# Title', '', 'A'.repeat(900), '', 'B'.repeat(900), ''].join('\n');

    expect(bodyChunks(text).map(chunk => chunk.locator))
      .toEqual(['L3-3#1', 'L5-5#2']);
  });

  it('nests headings so a subsection keeps its parent context', () => {
    const text = [
      '# Outer',
      '',
      'outer content that is long enough',
      '',
      '## Inner',
      '',
      'inner content that is long enough',
      '',
    ].join('\n');

    expect(bodyChunks(text).map(chunk => chunk.heading))
      .toEqual(['Outer', 'Outer > Inner']);
  });

  it('names the file when the document has no headings', () => {
    const text = ['plain content that is long enough to index', ''].join('\n');

    expect(bodyChunks(text).map(chunk => chunk.heading))
      .toEqual(['guotopological2026.paged']);
  });
});

describe('chunkMarkdown frontmatter', () => {
  it('emits one metadata chunk ahead of the body', () => {
    const text = [
      '---',
      'title: Light-driven dancing of nematic colloids',
      'id: asilehanlightdriven2025',
      'year: 2025',
      'tags:',
      '  - literature_note',
      '---',
      '',
      '# Body',
      '',
      'Body content that is long enough to index.',
      '',
    ].join('\n');

    const chunks = chunkMarkdown(text, '论文/卡片/Light-driven dancing.md');

    expect(chunks[0]).toMatchObject({ heading: '元数据', kind: 'meta', locator: 'frontmatter' });
    expect(chunks[0].body.split('\n')).toEqual([
      'title: Light-driven dancing of nematic colloids',
      'id: asilehanlightdriven2025',
      'year: 2025',
      'tags: literature_note',
    ]);
    expect(chunks.filter(chunk => chunk.kind === 'md')).toHaveLength(1);
  });

  it('omits the metadata chunk when there is no frontmatter', () => {
    const chunks = chunkMarkdown('plain content that is long enough\n', 'note.md');

    expect(chunks.every(chunk => chunk.kind === 'md')).toBe(true);
  });
});

describe('splitFrontmatter', () => {
  it('reads scalars, inline lists, and block lists', () => {
    const split = splitFrontmatter([
      '---',
      'title: "Quoted title"',
      'domain: 液晶与软物质',
      'tags: [literature_note, physics]',
      'author:',
      '  - family: Guo',
      '---',
      'rest of the note',
    ].join('\r\n'));

    expect(split.frontmatter).toEqual({
      author: ['family: Guo'],
      domain: '液晶与软物质',
      tags: ['literature_note', 'physics'],
      title: 'Quoted title',
    });
    expect(split.body).toBe('rest of the note');
    expect(split.rawFrontmatter).toContain('title');
  });

  it('leaves a document without frontmatter untouched', () => {
    expect(splitFrontmatter('# Title\nbody')).toEqual({
      body: '# Title\nbody',
      frontmatter: {},
      rawFrontmatter: null,
    });
  });

  it('round-trips the raw frontmatter block byte-for-byte', () => {
    const text = ['---', 'title: T', '---', '', 'body'].join('\n');
    const split = splitFrontmatter(text);
    expect(split.rawFrontmatter).toBe('---\ntitle: T\n---\n');
    expect(split.rawFrontmatter + split.body).toBe(text);
  });
});
