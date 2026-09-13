import {
  applyPhraseBoost,
  buildLexicalIndex,
  buildSnippet,
  fuseByReciprocalRank,
  type RankableChunk,
  rankByBm25,
  rankByCosine,
  type ScoredChunk,
  toDisplayScore,
} from '@/core/search/ranking';
import { normalizeForMatch, tokenize } from '@/core/search/tokenize';

function chunks(...bodies: string[]): RankableChunk[] {
  return bodies.map(body => ({ body, heading: '' }));
}

function positions(ranked: readonly ScoredChunk[]): number[] {
  return ranked.map(entry => entry.position);
}

describe('rankByBm25', () => {
  it('ranks a chunk matching more query terms first', () => {
    const index = buildLexicalIndex(chunks(
      'nematic skyrmion dynamics under strong turbulence',
      'nematic colloid response to optical torque',
      'skyrmion lattice in magnetic films',
    ));

    const ranked = rankByBm25(index, tokenize('nematic skyrmion'));

    expect(positions(ranked)[0]).toBe(0);
    expect(ranked).toHaveLength(3);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it('prefers a rare term over a term that appears everywhere', () => {
    const index = buildLexicalIndex(chunks(
      'nematic turbulence',
      'nematic colloid',
      'nematic film',
      'turbulence only here',
    ));

    const ranked = rankByBm25(index, tokenize('nematic turbulence'));
    const order = positions(ranked);

    // Matching both terms wins, then the rare-term-only chunk beats the
    // common-term-only chunks, which is what IDF is for.
    expect(order[0]).toBe(0);
    expect(order[1]).toBe(3);
    expect(order.slice(2).sort()).toEqual([1, 2]);
  });

  it('prefers covering the query over repeating one term', () => {
    const index = buildLexicalIndex(chunks(
      'alpha alpha alpha',
      'alpha beta gamma',
    ));

    expect(positions(rankByBm25(index, tokenize('alpha beta gamma')))[0]).toBe(1);
  });

  it('returns nothing for a query with no indexable terms', () => {
    const index = buildLexicalIndex(chunks('nematic skyrmion'));

    expect(rankByBm25(index, tokenize('the of and'))).toEqual([]);
    expect(rankByBm25(index, [])).toEqual([]);
    expect(rankByBm25(buildLexicalIndex([]), tokenize('anything'))).toEqual([]);
  });

  it('matches CJK queries through the character and bigram channel', () => {
    const index = buildLexicalIndex(chunks(
      '液晶斯格明子的拓扑鲁棒性研究',
      '大气湍流中光场的相位恢复方法',
    ));

    expect(positions(rankByBm25(index, tokenize('斯格明子')))[0]).toBe(0);
  });
});

describe('rankByCosine', () => {
  const vector = (...values: number[]): Float32Array => Float32Array.from(values);

  it('orders by cosine similarity', () => {
    const ranked = rankByCosine(vector(1, 0), [
      { position: 0, vector: vector(1, 0) },
      { position: 1, vector: vector(0, 1) },
      { position: 2, vector: vector(1, 1) },
    ]);

    expect(positions(ranked)).toEqual([0, 2, 1]);
    expect(ranked[0].score).toBeCloseTo(1, 6);
    expect(ranked[2].score).toBeCloseTo(0, 6);
  });

  it('ignores vectors of a different dimension', () => {
    const ranked = rankByCosine(vector(1, 0), [
      { position: 0, vector: vector(1, 0) },
      { position: 1, vector: vector(1, 0, 0) },
    ]);

    expect(positions(ranked)).toEqual([0]);
  });

  it('treats a zero-length stored vector as no similarity', () => {
    const ranked = rankByCosine(vector(1, 0), [
      { position: 0, vector: vector(0, 0) },
      { position: 1, vector: vector(1, 0) },
    ]);

    expect(positions(ranked)).toEqual([1, 0]);
    expect(ranked[1].score).toBe(0);
  });

  it('returns nothing when there is nothing to compare', () => {
    expect(rankByCosine(vector(1, 0), [])).toEqual([]);
    expect(rankByCosine(vector(), [{ position: 0, vector: vector(1, 0) }])).toEqual([]);
  });
});

describe('fuseByReciprocalRank', () => {
  it('rewards a chunk that ranks highly in both lists', () => {
    const lexical: ScoredChunk[] = [
      { position: 0, score: 9 },
      { position: 1, score: 5 },
    ];
    const semantic: ScoredChunk[] = [
      { position: 1, score: 0.9 },
      { position: 0, score: 0.1 },
    ];

    const fused = fuseByReciprocalRank([lexical, semantic]);

    expect(fused.get(0)).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused.get(1)).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(fused.size).toBe(2);
  });

  it('keeps a chunk that only one ranking found', () => {
    const fused = fuseByReciprocalRank([
      [{ position: 7, score: 1 }],
      [],
    ]);

    expect(fused.get(7)).toBeCloseTo(1 / 61, 10);
  });

  it('ignores the raw score scale of each ranking', () => {
    // 1e6 vs 0.001 must not matter: only rank order is fused.
    const fused = fuseByReciprocalRank([
      [{ position: 0, score: 1e6 }, { position: 1, score: 0.001 }],
      [{ position: 0, score: 1e6 }, { position: 1, score: 0.001 }],
    ]);

    expect(fused.get(0)).toBeGreaterThan(fused.get(1) ?? 0);
  });
});

describe('applyPhraseBoost', () => {
  const base = 10;

  it('boosts an exact phrase in the body', () => {
    expect(applyPhraseBoost(base, 'nematic colloid', 'Results', 'we study nematic colloid dynamics'))
      .toBeCloseTo(base * 1.35, 10);
  });

  it('boosts an exact phrase in the heading', () => {
    expect(applyPhraseBoost(base, 'nematic colloid', 'nematic colloid dynamics', 'unrelated text'))
      .toBeCloseTo(base * 1.15, 10);
  });

  it('applies both boosts when the phrase is in the heading and the body', () => {
    expect(applyPhraseBoost(base, 'nematic colloid', 'nematic colloid', 'nematic colloid here'))
      .toBeCloseTo(base * 1.35 * 1.15, 10);
  });

  it('leaves the score alone when the phrase is absent', () => {
    expect(applyPhraseBoost(base, 'nematic colloid', 'Results', 'nothing relevant here')).toBe(base);
  });

  it('ignores a query too short to be a phrase', () => {
    expect(applyPhraseBoost(base, 'a', 'a', 'a')).toBe(base);
  });

  it('matches a multi-character CJK phrase', () => {
    expect(applyPhraseBoost(base, '斯格明子', '结果', '液晶斯格明子的拓扑鲁棒性'))
      .toBeCloseTo(base * 1.35, 10);
  });
});

describe('toDisplayScore', () => {
  it('scales a fused score into a readable number', () => {
    expect(toDisplayScore(0.031)).toBe(31);
    expect(toDisplayScore(0.9134)).toBe(913.4);
  });
});

describe('buildSnippet', () => {
  const tokens = tokenize('skyrmion');

  it('centres the excerpt on the first matching token', () => {
    const text = `${'leading filler '.repeat(20)}skyrmion${' trailing filler'.repeat(20)}`;
    const snippet = buildSnippet(text, tokens, 60);

    expect(snippet).toContain('skyrmion');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(62);
  });

  it('falls back to the head of the chunk when nothing matches', () => {
    const snippet = buildSnippet('a'.repeat(500), tokens, 40);

    expect(snippet).toBe(`${'a'.repeat(40)}…`);
  });

  it('collapses whitespace and normalizes the match', () => {
    const snippet = buildSnippet('line one\n\n  SKYRMION   text', tokenize('skyrmion'));

    expect(snippet).toBe('line one SKYRMION text');
    expect(normalizeForMatch(snippet)).toContain('skyrmion');
  });

  it('returns nothing for empty text', () => {
    expect(buildSnippet('   \n  ', tokens)).toBe('');
  });
});
