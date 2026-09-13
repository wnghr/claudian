import type { App, TFile } from 'obsidian';

import { chunkMarkdown } from '../../../core/search/chunking';
import type { EmbeddingClient } from '../../../core/search/embedding';
import { decodeVectorBase64, encodeVectorBase64 } from '../../../core/search/embedding';
import {
  PAPER_SEARCH_DEFAULT_LIMIT,
  type PaperSearchHit,
  type PaperSearchMode,
  type PaperSearchPort,
  type PaperSearchRequest,
  type PaperSearchResult,
} from '../../../core/search/PaperSearch';
import {
  applyPhraseBoost,
  buildLexicalIndex,
  buildSnippet,
  fuseByReciprocalRank,
  rankByBm25,
  rankByCosine,
  type ScoredChunk,
  toDisplayScore,
} from '../../../core/search/ranking';
import { tokenize } from '../../../core/search/tokenize';
import { embeddingVectorKey, type EmbeddingVectorStore } from './EmbeddingVectorCache';

/**
 * Hybrid search over the vault's readable text.
 *
 * Two deliberate differences from the retired `kb.py` index, both fixing a
 * defect that made search results untrustworthy:
 *
 * 1. There is no PDF channel. The old index pushed each PDF through
 *    `pdftotext` *and* indexed its MinerU Markdown, so one paper produced two
 *    competing sets of chunks and the keyword ranking often surfaced the
 *    degraded copy. Only readable Markdown is indexed now.
 * 2. When a page-anchored twin (`<name>.paged.md`) exists, the unanchored
 *    `<name>.md` is skipped. Otherwise the same paper is indexed twice with
 *    different locator formats and a hit cannot be cited reliably.
 *
 * The index is rebuilt per search: the corpus is Markdown files read through
 * Obsidian's cache, which is fast, and an always-fresh index removes any need
 * to detect staleness. Only embedding vectors are persisted.
 */

/**
 * Path-segment filter that ignores the user-configurable configuration folder
 * plus the rest of the build-output directories. The config folder name is
 * resolved at runtime through Obsidian's `Vault#configDir` so the filter
 * follows the user if they renamed it.
 */
export function buildSkipDirectoryParts(app: App): ReadonlySet<string> {
  const parts = new Set<string>([
    '.git', '.trash', '.claudian', '.agents', '.claude',
    '.workbuddy', '.kb', 'node_modules', '__pycache__', 'Templates', 'Images',
  ]);
  const configDirectory = (app.vault as { configDir?: unknown }).configDir;
  if (typeof configDirectory === 'string' && configDirectory.length > 0) {
    // The config directory is reported as a path; the filter only needs its
    // final segment so a nested layout does not over-match.
    const name = configDirectory.split('/').filter(Boolean).pop();
    if (name) parts.add(name);
  }
  return parts;
}

export const SKIP_NAME_PREFIXES: readonly string[] = ['~$', '.'];

/** Dashboard-style entry notes; searchable with an explicit scope instead. */
const ENTRY_DIRECTORY_PARTS: readonly string[] = ['00-入口'];

interface CorpusChunk {
  readonly path: string;
  readonly kind: string;
  readonly heading: string;
  readonly locator: string;
  readonly body: string;
}

export interface VaultPaperSearchOptions {
  readonly app: App;
  readonly embedding: EmbeddingClient;
  /** Omitted when the vault has no filesystem backing; search still works. */
  readonly vectorStore?: EmbeddingVectorStore | null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function isSkipped(path: string, skipParts: ReadonlySet<string>): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).some(part => skipParts.has(part))) return true;
  return SKIP_NAME_PREFIXES.some(prefix => name.startsWith(prefix));
}

function isIndexableFile(file: TFile): boolean {
  return typeof file.path === 'string'
    && typeof file.extension === 'string'
    && file.extension.toLocaleLowerCase() === 'md';
}

function selectIndexableFiles(app: App): readonly TFile[] {
  const markdown = app.vault.getFiles().filter(file => isIndexableFile(file));
  const present = new Set(markdown.map(file => normalizePath(file.path)));
  const skipParts = buildSkipDirectoryParts(app);

  const selected: TFile[] = [];
  for (const file of markdown) {
    const path = normalizePath(file.path);
    if (isSkipped(path, skipParts)) continue;
    if (!path.endsWith('.paged.md')) {
      const anchoredTwin = `${path.slice(0, -'.md'.length)}.paged.md`;
      if (present.has(anchoredTwin)) continue;
    }
    selected.push(file);
  }
  return selected.sort(
    (left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path)),
  );
}

async function buildCorpus(app: App, files: readonly TFile[]): Promise<readonly CorpusChunk[]> {
  const corpus: CorpusChunk[] = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    let text: string;
    try {
      text = await app.vault.cachedRead(file);
    } catch {
      // An unreadable file must not abort the whole search.
      continue;
    }
    for (const chunk of chunkMarkdown(text, path)) {
      corpus.push({
        path,
        kind: chunk.kind,
        heading: chunk.heading,
        locator: chunk.locator,
        body: chunk.body,
      });
    }
  }
  return corpus;
}

function isInScope(path: string, scope: string | undefined): boolean {
  if (!scope) return true;
  const wanted = normalizePath(scope.trim());
  if (!wanted) return true;
  return path === wanted
    || path.startsWith(`${wanted}/`)
    || path.split('/').includes(wanted);
}

interface SemanticRanking {
  readonly ranking: readonly ScoredChunk[];
  readonly embedded: number;
  readonly failure: string | null;
}

async function computeSemanticRanking(
  corpus: readonly CorpusChunk[],
  query: string,
  client: EmbeddingClient,
  store: EmbeddingVectorStore | null,
  cache: Map<string, string>,
): Promise<SemanticRanking> {
  const queryVector = await client.embedQuery(query);
  if (!queryVector || queryVector.length === 0) {
    return { embedded: 0, failure: 'The embedding endpoint returned no vector for this query.', ranking: [] };
  }

  const keys = corpus.map(chunk => embeddingVectorKey(client.model, chunk.body));
  const missing = new Map<string, string>();
  for (const [position, key] of keys.entries()) {
    if (!cache.has(key) && !missing.has(key)) missing.set(key, corpus[position].body);
  }

  let failure: string | null = null;
  if (missing.size > 0) {
    const texts = [...missing.values()];
    let produced: readonly Float32Array[] = [];
    try {
      produced = await client.embedPassages(texts);
    } catch (error) {
      failure = `Embedding request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const [offset, vector] of produced.entries()) {
      const key = [...missing.keys()][offset];
      if (key !== undefined) cache.set(key, encodeVectorBase64(vector));
    }
    if (produced.length < texts.length) {
      const detail = `${produced.length} of ${texts.length} new passages`;
      failure = failure === null
        ? `Embedding was incomplete (${detail}); semantic ranking covers only part of the corpus.`
        : `${failure} (${detail})`;
    }
    if (produced.length > 0 && store) {
      try {
        await store.save(cache, client.model);
      } catch (error) {
        failure ??= `Could not persist the embedding cache: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  const vectors: { position: number; vector: Float32Array }[] = [];
  for (const [position, key] of keys.entries()) {
    const encoded = cache.get(key);
    if (encoded === undefined) continue;
    const vector = decodeVectorBase64(encoded);
    if (vector) vectors.push({ position, vector });
  }

  return {
    embedded: vectors.length,
    failure,
    ranking: rankByCosine(queryVector, vectors),
  };
}

export function createVaultPaperSearch(options: VaultPaperSearchOptions): PaperSearchPort {
  const { app, embedding, vectorStore } = options;
  let cachePromise: Promise<Map<string, string>> | null = null;

  const loadCache = async (): Promise<Map<string, string>> => {
    if (!vectorStore) return new Map();
    // Loaded once per session: the map is then mutated in place and re-saved.
    cachePromise ??= vectorStore.load();
    return cachePromise;
  };

  return {
    async searchPapers(request: PaperSearchRequest): Promise<PaperSearchResult> {
      const mode: PaperSearchMode = request.mode ?? 'hybrid';
      const limit = request.limit ?? PAPER_SEARCH_DEFAULT_LIMIT;

      const files = selectIndexableFiles(app);
      const corpus = await buildCorpus(app, files);
      const queryTokens = tokenize(request.query);

      if (corpus.length === 0) {
        return {
          degraded: null,
          hits: [],
          index: { chunks: 0, embedded: 0, files: files.length },
          mode,
          query: request.query,
        };
      }

      const lexical: readonly ScoredChunk[] = mode === 'semantic'
        ? []
        : rankByBm25(buildLexicalIndex(corpus), queryTokens);

      let semantic: readonly ScoredChunk[] = [];
      let degraded: string | null = null;
      let embedded = 0;

      if (mode !== 'keyword') {
        if (!embedding.isEnabled) {
          degraded = embedding.disabledReason
            ?? 'Semantic search is unavailable: no embedding endpoint is configured.';
        } else {
          const result = await computeSemanticRanking(
            corpus, request.query, embedding, vectorStore ?? null, await loadCache(),
          );
          semantic = result.ranking;
          embedded = result.embedded;
          degraded = result.failure;
        }
        if (mode === 'semantic' && semantic.length === 0) {
          throw new Error(degraded ?? 'Semantic search produced no usable vectors.');
        }
      }

      const fused = fuseByReciprocalRank(
        mode === 'keyword' ? [lexical] : mode === 'semantic' ? [semantic] : [lexical, semantic],
      );

      const ordered = [...fused.entries()]
        .map(entry => ({
          position: entry[0],
          score: applyPhraseBoost(
            entry[1], request.query,
            corpus[entry[0]].heading, corpus[entry[0]].body,
          ),
        }))
        .sort((left, right) => right.score - left.score || left.position - right.position);

      const hits: PaperSearchHit[] = [];
      for (const candidate of ordered) {
        const chunk = corpus[candidate.position];
        if (request.kind && chunk.kind !== request.kind) continue;
        if (!isInScope(chunk.path, request.scope)) continue;
        if (chunk.kind === 'md'
          && ENTRY_DIRECTORY_PARTS.some(part => chunk.path.includes(part))) continue;

        hits.push({
          body: chunk.body,
          heading: chunk.heading,
          kind: chunk.kind,
          locator: chunk.locator,
          path: chunk.path,
          score: toDisplayScore(candidate.score),
          snippet: buildSnippet(chunk.body, queryTokens),
        });
        if (hits.length >= limit) break;
      }

      return {
        degraded,
        hits,
        index: { chunks: corpus.length, embedded, files: files.length },
        mode,
        query: request.query,
      };
    },
  };
}
