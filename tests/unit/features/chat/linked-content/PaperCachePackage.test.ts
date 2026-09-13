import {
  buildCacheNavigationIndex,
  buildPageAnchoredMarkdown,
  manifestFullMarkdownPath,
  manifestSourceHash,
  manifestSourcePath,
} from '@/features/chat/linked-content/PaperCachePackage';

describe('PaperCachePackage', () => {
  it('builds page anchors from a MinerU content list without losing equations or figures', () => {
    const markdown = buildPageAnchoredMarkdown('ignored parser text', [
      { page_idx: 0, text: 'Introduction', text_level: 1, type: 'text' },
      { page_idx: 0, text: 'The first paragraph.', type: 'text' },
      { page_idx: 1, text: '$$E=mc^2$$', type: 'equation' },
      {
        page_idx: 1,
        type: 'image',
        img_path: 'images/figure-1.jpg',
        image_caption: ['Figure 1 | A test figure.'],
      },
    ]);

    expect(markdown).toContain('<!-- p.1 -->');
    expect(markdown).toContain('<!-- p.2 -->');
    expect(markdown).toContain('# Introduction');
    expect(markdown).toContain('$$E=mc^2$$');
    expect(markdown).toContain('![](images/figure-1.jpg)');
  });

  it('indexes sections by character range and page, and records assets', () => {
    const markdown = [
      '<!-- p.1 -->',
      '# Introduction',
      '',
      'Background.',
      '<!-- p.2 -->',
      'More background.',
      '',
      '![Figure 1](images/figure-1.jpg)',
      '',
      '## Methods',
      '',
      '$$x=y$$',
    ].join('\n');
    const index = buildCacheNavigationIndex(markdown, [{
      page_idx: 1,
      type: 'image',
      img_path: 'images/figure-1.jpg',
      image_caption: ['Figure 1'],
    }]);

    expect(index.totalPages).toBe(2);
    expect(index.totalChars).toBe(markdown.length);
    expect(index.allFigures).toEqual(['images/figure-1.jpg']);
    expect(index.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ heading: 'Introduction', page: 1, equationCount: 1 }),
      expect.objectContaining({ heading: 'Methods', page: 2, equationCount: 1 }),
    ]));
    const methods = index.sections?.find(section => section.heading === 'Methods');
    expect(methods).toBeDefined();
    expect(methods?.charEnd).toBe(markdown.length);
    expect(methods!.charStart).toBeLessThan(methods!.charEnd);
  });

  it('accepts both the canonical and legacy manifest field names', () => {
    expect(manifestSourcePath({ source: { path: '论文/PDF/a.pdf' } })).toBe('论文/PDF/a.pdf');
    expect(manifestSourceHash({ source_sha256: 'ABC' })).toBe('ABC');
    expect(manifestFullMarkdownPath({ files: { full_md: '论文/MD/a--id/full.md' } }))
      .toBe('论文/MD/a--id/full.md');
    expect(manifestFullMarkdownPath({ paged_md: '论文/MD/a/a.paged.md' }))
      .toBe('论文/MD/a/a.paged.md');
  });
});
