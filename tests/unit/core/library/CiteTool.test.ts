import { executeCiteTool, parseCiteToolInput } from '@/core/library/CiteTool';
import type { PaperCitation } from '@/core/library/PaperLibrary';

const FULL: PaperCitation = {
  authors: [{ family: 'Asilehan', given: 'Zhawure' }],
  citekey: 'asilehanlightdriven2025',
  doi: '10.1038/s41467-025-56263-5',
  issue: '1',
  pages: '1148',
  title: 'Light-driven dancing of nematic colloids in fractional skyrmions and bimerons',
  url: 'https://www.nature.com/articles/s41467-025-56263-5',
  venue: 'Nature Communications',
  volume: '16',
  year: 2025,
};

describe('cite tool', () => {
  it('requires a non-blank citekey', () => {
    expect(() => parseCiteToolInput({})).toThrow(/citekey is required/u);
    expect(() => parseCiteToolInput({ citekey: '   ' })).toThrow(/citekey is required/u);
    expect(parseCiteToolInput({ citekey: '  asilehanlightdriven2025  ' }))
      .toEqual({ citekey: 'asilehanlightdriven2025' });
  });

  it('passes the citekey straight to the port', async () => {
    const citePaper = jest.fn().mockResolvedValue(FULL);

    await executeCiteTool({ citePaper }, { citekey: 'asilehanlightdriven2025' });

    expect(citePaper).toHaveBeenCalledWith('asilehanlightdriven2025');
  });

  it('returns a paste-ready reference alongside the fields', async () => {
    const output = await executeCiteTool(
      { citePaper: async () => FULL },
      { citekey: 'asilehanlightdriven2025' },
    );

    expect(output).toBe([
      'Citekey: asilehanlightdriven2025',
      'Reference: Asilehan, Z. (2025). Light-driven dancing of nematic colloids in fractional'
      + ' skyrmions and bimerons. Nature Communications, 16(1), 1148.'
      + ' https://doi.org/10.1038/s41467-025-56263-5',
      'Authors: Asilehan, Zhawure',
      'Source: Nature Communications, 16(1), 1148',
      'DOI: 10.1038/s41467-025-56263-5',
      'URL: https://www.nature.com/articles/s41467-025-56263-5',
    ].join('\n'));
  });

  it('states missing optional fields instead of leaving gaps', async () => {
    const output = await executeCiteTool(
      {
        citePaper: async () => ({
          authors: [],
          citekey: 'sparse',
          doi: null,
          issue: null,
          pages: null,
          title: '',
          url: null,
          venue: null,
          volume: null,
          year: null,
        }),
      },
      { citekey: 'sparse' },
    );

    expect(output).toContain('Authors: unknown');
    expect(output).toContain('Source: unknown');
    expect(output).toContain('DOI: none');
    expect(output).toContain('URL: none');
  });
});
