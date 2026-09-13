import type { PaperContentResolver } from '@/features/chat/linked-content/PaperContentResolver';
import { PaperReader } from '@/features/chat/linked-content/PaperReader';

function createReader(content: string, cachePath = '论文/MD/current/current.paged.md') {
  const resolver = {
    resolve: jest.fn().mockResolvedValue({
      status: 'ready',
      sourcePath: '论文/PDF/current.pdf',
      cachePath,
      content,
      complete: true,
    }),
  } as unknown as PaperContentResolver;
  return { reader: new PaperReader(resolver), resolver };
}

describe('PaperReader', () => {
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
});
