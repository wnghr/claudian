/**
 * Ranking for the hybrid paper search.
 *
 * Ported from the retired `kb.py` engine so scores and ordering stay comparable:
 * Okapi BM25 with the same k1/b, the same `(matched / unique query terms) ** 1.5`
 * coverage factor, and the same reciprocal-rank fusion (k = 60) that merges the
 * lexical and vector rankings without mixing their incomparable score scales.
 */

import { normalizeForMatch, tokenize } from './tokenize';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const BM25_COVERAGE_EXPONENT = 1.5;
export const RRF_K = 60;
export const CANDIDATE_LIMIT = 400;

/** Literal-phrase boosts applied after fusion, as in the retired engine. */
export const PHRASE_IN_TEXT_BOOST = 1.35;
export const PHRASE_IN_HEADING_BOOST = 1.15;

export interface RankableChunk {
  readonly heading: string;
  readonly body: string;
}

export interface LexicalIndex {
  /** Token frequency per chunk, keyed by token. */
  readonly postings: ReadonlyMap<string, ReadonlyMap<number, number>>;
  readonly documentFrequency: ReadonlyMap<string, number>;
  /** Token count per chunk, indexed by chunk position. */
  readonly lengths: readonly number[];
  readonly averageLength: number;
  readonly size: number;
}

export function buildLexicalIndex(chunks: readonly RankableChunk[]): LexicalIndex {
  const postings = new Map<string, Map<number, number>>();
  const lengths: number[] = [];
  let total = 0;

  for (const [position, chunk] of chunks.entries()) {
    const tokens = tokenize(`${chunk.heading}\n${chunk.body}`);
    lengths.push(tokens.length);
    total += tokens.length;
    const counted = new Map<string, number>();
    for (const token of tokens) counted.set(token, (counted.get(token) ?? 0) + 1);
    for (const [token, frequency] of counted) {
      const byChunk = postings.get(token) ?? new Map<number, number>();
      byChunk.set(position, frequency);
      postings.set(token, byChunk);
    }
  }

  const documentFrequency = new Map<string, number>();
  for (const [token, byChunk] of postings) documentFrequency.set(token, byChunk.size);

  return {
    postings,
    documentFrequency,
    lengths,
    averageLength: chunks.length > 0 ? total / chunks.length : 1,
    size: chunks.length,
  };
}

export interface ScoredChunk {
  readonly position: number;
  readonly score: number;
}

/** Okapi BM25 over the in-memory index; returns at most `candidates` chunks. */
export function rankByBm25(
  index: LexicalIndex,
  queryTokens: readonly string[],
  candidates: number = CANDIDATE_LIMIT,
): readonly ScoredChunk[] {
  if (queryTokens.length === 0 || index.size === 0) return [];

  const uniqueQueryTokens = new Set(queryTokens);
  const matched = new Map<number, Map<string, number>>();
  for (const token of uniqueQueryTokens) {
    const byChunk = index.postings.get(token);
    if (!byChunk) continue;
    for (const [position, frequency] of byChunk) {
      const entry = matched.get(position) ?? new Map<string, number>();
      entry.set(token, frequency);
      matched.set(position, entry);
    }
  }
  if (matched.size === 0) return [];

  const scores: ScoredChunk[] = [];
  for (const [position, frequencies] of matched) {
    const length = index.lengths[position] ?? index.averageLength;
    const denominator = length > 0 ? length : index.averageLength;
    let score = 0;
    for (const [token, frequency] of frequencies) {
      const df = index.documentFrequency.get(token) ?? 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (index.size - df + 0.5) / (df + 0.5));
      score += (idf * (frequency * (BM25_K1 + 1)))
        / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (denominator / index.averageLength)));
    }
    const coverage = frequencies.size / uniqueQueryTokens.size;
    scores.push({ position, score: score * (coverage ** BM25_COVERAGE_EXPONENT) });
  }

  scores.sort((left, right) => right.score - left.score
    || left.position - right.position);
  return scores.slice(0, candidates);
}

function toSimilarity(value: number): number {
  // NaN can only come from a zero-length vector; treat it as no similarity.
  return Number.isFinite(value) ? value : 0;
}

function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const component of vector) sum += component * component;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const result = new Float32Array(vector.length);
  for (const [index, component] of vector.entries()) result[index] = component / norm;
  return result;
}

/** Cosine similarity of one query vector against many stored vectors. */
export function rankByCosine(
  queryVector: Float32Array,
  vectors: readonly { readonly position: number; readonly vector: Float32Array }[],
  candidates: number = CANDIDATE_LIMIT,
): readonly ScoredChunk[] {
  if (queryVector.length === 0 || vectors.length === 0) return [];
  const normalizedQuery = normalizeVector(queryVector);
  const scores: ScoredChunk[] = [];

  for (const { position, vector } of vectors) {
    const stored = normalizeVector(vector);
    if (stored.length !== normalizedQuery.length) continue;
    let dot = 0;
    for (let index = 0; index < stored.length; index += 1) {
      dot += stored[index] * normalizedQuery[index];
    }
    scores.push({ position, score: toSimilarity(dot) });
  }

  scores.sort((left, right) => right.score - left.score
    || left.position - right.position);
  return scores.slice(0, candidates);
}

/**
 * Reciprocal-rank fusion. Only ranks are combined, never raw scores, so a
 * lexical ranking and a cosine ranking can be merged without calibration.
 */
export function fuseByReciprocalRank(
  rankings: readonly (readonly ScoredChunk[])[],
): ReadonlyMap<number, number> {
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    const ordered = [...ranking].sort((left, right) => right.score - left.score
      || left.position - right.position);
    for (const [index, entry] of ordered.entries()) {
      const contribution = 1 / (RRF_K + index + 1);
      fused.set(entry.position, (fused.get(entry.position) ?? 0) + contribution);
    }
  }
  return fused;
}

/**
 * Exact-phrase boosts, applied to a fused score. A query that appears verbatim
 * in a chunk is a stronger signal than scattered term matches.
 */
export function applyPhraseBoost(
  fusedScore: number,
  query: string,
  heading: string,
  body: string,
): number {
  const normalizedQuery = normalizeForMatch(query);
  let score = fusedScore;
  if (normalizedQuery.length >= 2) {
    if (normalizeForMatch(body).includes(normalizedQuery)) {
      score *= PHRASE_IN_TEXT_BOOST;
    }
    if (normalizeForMatch(heading).includes(normalizedQuery)) {
      score *= PHRASE_IN_HEADING_BOOST;
    }
  }
  return score;
}

/** Human-readable score, in the same `x 1000` unit as the retired engine. */
export function toDisplayScore(fusedScore: number): number {
  return Math.round(fusedScore * 1000 * 10000) / 10000;
}

const SNIPPET_WIDTH = 240;

/** A query-centred excerpt; falls back to the head of the chunk when unmatched. */
export function buildSnippet(
  text: string,
  queryTokens: readonly string[],
  width: number = SNIPPET_WIDTH,
): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (!flat) return '';
  const lowered = flat.toLowerCase();

  let position = -1;
  for (const token of queryTokens) {
    const found = lowered.indexOf(token);
    if (found >= 0 && (position < 0 || found < position)) position = found;
  }
  if (position < 0) {
    return flat.length > width ? `${flat.slice(0, width)}…` : flat;
  }
  const start = Math.max(0, position - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
