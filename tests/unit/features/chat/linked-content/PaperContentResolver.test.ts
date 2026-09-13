import { PaperContentResolver } from '@/features/chat/linked-content/PaperContentResolver';

describe('PaperContentResolver', () => {
  it('returns the current MinerU cache only when the PDF hash and output are valid', async () => {
    const pdf = { path: '论文/PDF/Current-paper.pdf', extension: 'pdf' };
    const manifest = {
      source_pdf: '论文/PDF/Current-paper.pdf',
      source_sha256: 'ABC123',
      paged_md: '论文/MD/current/current.paged.md',
      status: 'success',
    };
    const files = [
      { path: '论文/MD/current/manifest.json', extension: 'json' },
      { path: '论文/MD/current/current.paged.md', extension: 'md' },
    ];
    const resolver = new PaperContentResolver({
      getFile: (path) => path === pdf.path
        ? pdf
        : files.find(file => file.path === path) ?? null,
      getFiles: () => [pdf, ...files],
      read: async (file) => file.path.endsWith('manifest.json')
        ? JSON.stringify(manifest)
        : '## Cached paper\n\n<!-- p.1 -->\nBody',
      readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
      hashBinary: async () => 'ABC123',
    });

    await expect(resolver.resolve('论文/PDF/Current-paper.pdf')).resolves.toMatchObject({
      status: 'ready',
      cachePath: '论文/MD/current/current.paged.md',
      content: expect.stringContaining('Cached paper'),
      complete: true,
    });
  });

  it('reports a stale cache instead of returning content for a changed PDF', async () => {
    const pdf = { path: '论文/PDF/Current-paper.pdf', extension: 'pdf' };
    const resolver = new PaperContentResolver({
      getFile: path => path === pdf.path ? pdf : null,
      getFiles: () => [pdf, { path: '论文/MD/current/manifest.json', extension: 'json' }],
      read: async () => JSON.stringify({
        source_pdf: pdf.path,
        source_sha256: 'OLD',
        output: '论文/MD/current/current.md',
        status: 'success',
      }),
      readBinary: async () => new Uint8Array([1]).buffer,
      hashBinary: async () => 'NEW',
    });

    await expect(resolver.resolve(pdf.path)).resolves.toMatchObject({
      status: 'stale',
    });
  });

  it('parses a missing cache once and retries the read', async () => {
    const pdf = { path: '论文/PDF/Current-paper.pdf', extension: 'pdf' };
    let hasCache = false;
    const parse = jest.fn().mockImplementation(async () => {
      hasCache = true;
    });
    const files = [pdf];
    const resolver = new PaperContentResolver({
      getFile: path => {
        if (path === pdf.path) return pdf;
        if (hasCache && path === '论文/MD/current/manifest.json') {
          return { path, extension: 'json' };
        }
        if (hasCache && path === '论文/MD/current/current.paged.md') {
          return { path, extension: 'md' };
        }
        return null;
      },
      getFiles: () => hasCache
        ? [...files,
          { path: '论文/MD/current/manifest.json', extension: 'json' },
          { path: '论文/MD/current/current.paged.md', extension: 'md' }]
        : files,
      read: async file => file.path.endsWith('manifest.json')
        ? JSON.stringify({
            source_pdf: pdf.path,
            source_sha256: 'ABC123',
            paged_md: '论文/MD/current/current.paged.md',
            status: 'success',
          })
        : 'Parsed body',
      readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
      hashBinary: async () => 'ABC123',
      ensureCache: parse,
    });

    await expect(Promise.all([
      resolver.resolve(pdf.path),
      resolver.resolve(pdf.path),
    ])).resolves.toEqual([
      expect.objectContaining({ status: 'ready', content: 'Parsed body' }),
      expect.objectContaining({ status: 'ready', content: 'Parsed body' }),
    ]);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
