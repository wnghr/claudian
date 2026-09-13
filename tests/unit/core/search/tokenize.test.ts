import { normalizeForMatch, tokenize } from '@/core/search/tokenize';

describe('tokenize', () => {
  it('lowercases, and drops one-character ASCII tokens and stop words', () => {
    expect(tokenize('A Skyrmion in a Nematic Colloid'))
      .toEqual(['skyrmion', 'nematic', 'colloid']);
  });

  it('drops English stop words but keeps domain terms', () => {
    const tokens = tokenize('the effect of the elastic constant on the bimeron');
    expect(tokens).toEqual(['effect', 'elastic', 'constant', 'bimeron']);
  });

  it('keeps hyphens, dots, and digits inside a token', () => {
    expect(tokenize('Optical-torque 10.1038/s41467'))
      .toEqual(['optical-torque', '10.1038', 's41467']);
  });

  it('drops CJK stop characters but keeps them inside bigrams', () => {
    // 的 is a stop character, so it is not a token on its own; the bigram layer
    // still carries it, which is what keeps CJK phrase matching usable.
    expect(tokenize('液晶的斯格明子')).toEqual([
      '液', '晶', '斯', '格', '明', '子',
      '液晶', '晶的', '的斯', '斯格', '格明', '明子',
    ]);
  });

  it('normalizes full-width characters and compatibility ligatures', () => {
    expect(tokenize('Ｎｅｍａｔｉｃ')).toEqual(['nematic']);
    expect(tokenize('eﬀiciency')).toEqual(['efficiency']);
  });

  it('returns nothing for text without letters or digits', () => {
    expect(tokenize('   ---  *** ')).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });
});

describe('normalizeForMatch', () => {
  it('collapses whitespace, folds case, and applies NFKC', () => {
    expect(normalizeForMatch('  Topological\n\tRobustness  ')).toBe('topological robustness');
    expect(normalizeForMatch('Ｎｅｍａｔｉｃ   Ｃｏｌｌｏｉｄ')).toBe('nematic colloid');
  });
});
