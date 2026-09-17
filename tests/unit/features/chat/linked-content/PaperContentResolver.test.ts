import { PaperContentResolver } from '@/features/chat/linked-content/PaperContentResolver';
import { createVaultPaperContentResolver } from '@/features/chat/linked-content/VaultPaperContentResolver';

describe('PaperContentResolver', () => {
  it('does not consult Zotero sources when the optional integration is disabled', async () => {
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn().mockReturnValue(null),
        getFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        readBinary: jest.fn(),
      },
    };

    const resolver = createVaultPaperContentResolver(app as never, {
      enableZoteroSupport: false,
      llmForZoteroCacheRoot: 'D:/Zotero/llm-for-zotero-mineru',
      zoteroDataDirectory: 'D:/Zotero',
    });

    await expect(resolver.resolve('zotero/ABCD2345.pdf')).resolves.toMatchObject({
      status: 'missing',
    });
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith('zotero/ABCD2345.pdf');
    expect(app.vault.read).not.toHaveBeenCalled();
  });

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

  it('reports a missing parse instead of kicking one off', async () => {
    const pdf = { path: '论文/PDF/Current-paper.pdf', extension: 'pdf' };
    const resolver = new PaperContentResolver({
      getFile: path => path === pdf.path ? pdf : null,
      getFiles: () => [pdf],
      read: async () => '',
      readBinary: async () => new Uint8Array([1]).buffer,
      hashBinary: async () => 'ABC123',
    });

    await expect(resolver.resolve(pdf.path)).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('prefers an external tier and labels the fidelity it reports', async () => {
    const resolver = new PaperContentResolver({
      getFile: () => null,
      getFiles: () => [],
      read: async () => '',
      readBinary: async () => new Uint8Array([1]).buffer,
      resolveExternalCache: async sourcePath => ({
        status: 'ready',
        sourcePath,
        content: '<!-- p.1 -->\nFrom the external tier',
        fidelity: 'zotero-fulltext',
        pageCount: 12,
        warnings: ['pages may be truncated'],
      }),
    });

    await expect(resolver.resolve('zotero/ABCD2345.pdf')).resolves.toMatchObject({
      status: 'ready',
      fidelity: 'zotero-fulltext',
      pageCount: 12,
      warnings: ['pages may be truncated'],
      content: expect.stringContaining('From the external tier'),
    });
  });

  it('falls through to the vault cache when the external tier declines', async () => {
    const pdf = { path: '论文/PDF/Current-paper.pdf', extension: 'pdf' };
    const manifest = {
      source_pdf: pdf.path,
      source_sha256: 'ABC123',
      paged_md: '论文/MD/current/current.paged.md',
      status: 'success',
    };
    const files = [
      pdf,
      { path: '论文/MD/current/manifest.json', extension: 'json' },
      { path: '论文/MD/current/current.paged.md', extension: 'md' },
    ];
    const resolver = new PaperContentResolver({
      getFile: path => files.find(file => file.path === path) ?? null,
      getFiles: () => files,
      read: async file => file.path.endsWith('manifest.json')
        ? JSON.stringify(manifest)
        : '## Cached paper',
      readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
      hashBinary: async () => 'ABC123',
      resolveExternalCache: async () => null,
    });

    await expect(resolver.resolve(pdf.path)).resolves.toMatchObject({
      status: 'ready',
      cachePath: '论文/MD/current/current.paged.md',
      fidelity: 'mineru-md',
    });
  });
});
