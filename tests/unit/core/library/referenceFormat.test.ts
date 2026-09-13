import type { PaperCitation } from '@/core/library/PaperLibrary';
import { formatPaperReference } from '@/core/library/referenceFormat';

function citation(overrides: Partial<PaperCitation> = {}): PaperCitation {
  return {
    authors: [],
    citekey: 'key',
    doi: null,
    issue: null,
    pages: null,
    title: 'A title',
    url: null,
    venue: null,
    volume: null,
    year: null,
    ...overrides,
  };
}

describe('formatPaperReference', () => {
  it('abbreviates given names to initials', () => {
    expect(formatPaperReference(citation({
      authors: [{ family: 'Asilehan', given: 'Zhawure' }],
      year: 2025,
    }))).toBe('Asilehan, Z. (2025). A title.');
  });

  it('joins exactly two authors with an ampersand', () => {
    expect(formatPaperReference(citation({
      authors: [
        { family: 'Guo', given: 'Zhenyu' },
        { family: 'Peters', given: 'Cade' },
      ],
      year: 2026,
    }))).toBe('Guo, Z. & Peters, C. (2026). A title.');
  });

  it('uses et al. beyond two authors', () => {
    expect(formatPaperReference(citation({
      authors: [
        { family: 'Guo', given: 'Zhenyu' },
        { family: 'Peters', given: 'Cade' },
        { family: 'Mata-Cervera', given: 'Nilo' },
      ],
      year: 2026,
    }))).toBe('Guo, Z. et al. (2026). A title.');
  });

  it('keeps a multi-part given name as multiple initials', () => {
    expect(formatPaperReference(citation({
      authors: [{ family: 'Vetlugin', given: 'Anton N.' }],
    }))).toBe('Vetlugin, A. N. A title.');
  });

  it('renders venue, volume, issue, and pages', () => {
    expect(formatPaperReference(citation({
      issue: '1',
      pages: '2085',
      venue: 'Nature Communications',
      volume: '17',
    }))).toBe('A title. Nature Communications, 17(1), 2085.');
  });

  it('prefers the DOI over the URL and falls back to the URL', () => {
    expect(formatPaperReference(citation({
      doi: '10.1/x',
      url: 'https://example.com/x',
    }))).toBe('A title. https://doi.org/10.1/x');
    expect(formatPaperReference(citation({ url: 'https://example.com/x' })))
      .toBe('A title. https://example.com/x');
  });

  it('omits absent segments without leaving stray punctuation', () => {
    expect(formatPaperReference(citation({ authors: [{ family: 'Solo', given: '' }] })))
      .toBe('Solo A title.');
    expect(formatPaperReference(citation({ title: '' }))).toBe('');
  });
});
