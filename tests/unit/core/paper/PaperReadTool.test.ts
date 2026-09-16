import { executePaperReadTool } from '@/core/paper/PaperReadTool';

describe('executePaperReadTool', () => {
  it('uses the active ZotFlow Reader for an explicit Zotero attachment reference', async () => {
    const readPaper = jest.fn().mockResolvedValue({
      sourcePath: 'zotero/RGQ4LR63.pdf',
      fidelity: 'zotflow-reader',
      content: 'reader content',
      selection: 'p.2',
      truncated: false,
      warnings: [],
    });

    await executePaperReadTool(
      { readPaper },
      () => null,
      { path: 'zotero/RGQ4LR63.pdf', pages: '2' },
    );

    expect(readPaper).toHaveBeenCalledWith({
      sourcePath: 'zotero/RGQ4LR63.pdf',
      preferActiveReader: true,
      pages: '2',
    });
  });
});
