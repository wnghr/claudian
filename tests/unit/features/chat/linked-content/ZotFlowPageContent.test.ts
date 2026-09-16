import { renderZotFlowPage } from '@/features/chat/linked-content/ZotFlowPageContent';

describe('renderZotFlowPage', () => {
  it('reconstructs PDFWorker glyphs when the enhancement pack is unavailable', () => {
    const page = {
      pageIndex: 1,
      pageCount: 659,
      blocks: [],
      pageData: {
        partial: true,
        chars: [
          { c: 'H', u: 'H', rect: [10, 100, 16, 110], baseline: 105, fontSize: 10 },
          { c: 'i', u: 'i', rect: [16, 100, 20, 110], baseline: 105, fontSize: 10 },
          { c: 't', u: 't', rect: [30, 100, 35, 110], baseline: 105, fontSize: 10 },
          { c: 'l', u: 'l', rect: [35, 100, 39, 110], baseline: 105, fontSize: 10 },
          { c: 'e', u: 'e', rect: [39, 100, 45, 110], baseline: 105, fontSize: 10 },
          { c: '2', u: '2', rect: [10, 80, 16, 90], baseline: 85, fontSize: 10 },
        ],
      },
    };

    expect(renderZotFlowPage(page)).toBe('<!-- p.2 -->\nHi tle\n2');
  });
});
