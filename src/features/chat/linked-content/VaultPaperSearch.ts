import type { App, TFile } from 'obsidian';

import { chunkMarkdown } from '../../../core/search/chunking';
import type { EmbeddingClient } from '../../../core/search/embedding';
import { decodeVectorBase64, encodeVectorBase64 } from '../../../core/search/embedding';
import {
  PAPER_SEARCH_DEFAULT_LIMIT,
  PAPER_SEARCH_MODES,
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
import { decideSearchDocument } from '../../../core/search/searchPolicy';
import { tokenize } from '../../../core/search/tokenize';
import { embeddingVectorKey, type EmbeddingVectorStore } from './EmbeddingVectorCache';
import {
  buildSkipDirectoryParts,
  SKIP_NAME_PREFIXES,
} from './VaultPathPolicy';

export { buildSkipDirectoryParts, SKIP_NAME_PREFIXES } from './VaultPathPolicy';

export interface ExternalPaperSearchDocument {
  readonly path: string;
  readonly content: string;
}

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
 * The corpus stays fresh per search, while unchanged files reuse their parsed
 * chunks in memory. Only embedding vectors are persisted; text remains owned
 * by the vault or the external Zotero cache.
 */

interface CorpusChunk {
  readonly path: string;
  readonly kind: string;
  readonly heading: string;
  readonly locator: string;
  readonly body: string;
}

interface CachedChunks {
  readonly fingerprint: string;
  readonly chunks: readonly CorpusChunk[];
}

interface IndexableVaultFile {
  readonly file: TFile;
  readonly path: string;
  readonly text: string;
}

export interface VaultPaperSearchOptions {
  readonly app: App;
  readonly embedding: EmbeddingClient;
  /** Omitted when the vault has no filesystem backing; search still works. */
  readonly vectorStore?: EmbeddingVectorStore | null;
  readonly externalDocuments?: () => Promise<readonly ExternalPaperSearchDocument[]>;
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

async function selectIndexableFiles(
  app: App,
  scope: string | undefined,
  textCache: Map<string, { fingerprint: string; text: string }>,
): Promise<readonly IndexableVaultFile[]> {
  const markdown = app.vault.getFiles().filter(file => isIndexableFile(file));
  const present = new Set(markdown.map(file => normalizePath(file.path)));
  const skipParts = buildSkipDirectoryParts(app);

  const selected: IndexableVaultFile[] = [];
  for (const file of markdown) {
    const path = normalizePath(file.path);
    if (isSkipped(path, skipParts)) continue;
    if (scope && !isInScope(path, scope)) continue;
    if (!path.endsWith('.paged.md')) {
      const anchoredTwin = `${path.slice(0, -'.md'.length)}.paged.md`;
      if (present.has(anchoredTwin)) continue;
    }
    const fingerprint = fileFingerprint(file);
    const cachedText = fingerprint === null ? undefined : textCache.get(path);
    let text: string;
    if (cachedText?.fingerprint === fingerprint) {
      text = cachedText.text;
    } else {
      try {
        text = await app.vault.cachedRead(file);
      } catch {
        continue;
      }
      if (fingerprint !== null) textCache.set(path, { fingerprint, text });
    }
    if (!decideSearchDocument(path, text).searchable) continue;
    selected.push({ file, path, text });
  }
  return selected.sort(
    (left, right) => left.path.localeCompare(right.path),
  );
}

function chunkText(text: string, path: string): readonly CorpusChunk[] {
  return chunkMarkdown(text, path).map(chunk => ({
    path,
    kind: chunk.kind,
    heading: chunk.heading,
    locator: chunk.locator,
    body: chunk.body,
  }));
}

function fileFingerprint(file: TFile): string | null {
  const stat = (file as TFile & { stat?: { mtime?: unknown; size?: unknown } }).stat;
  if (!stat || typeof stat.mtime !== 'number' || typeof stat.size !== 'number') return null;
  return `${stat.mtime}:${stat.size}`;
}

async function buildCorpus(
  files: readonly IndexableVaultFile[],
  externalDocuments: readonly ExternalPaperSearchDocument[] = [],
  fileCache: Map<string, CachedChunks> = new Map(),
  externalCache: Map<string, CachedChunks> = new Map(),
): Promise<readonly CorpusChunk[]> {
  const corpus: CorpusChunk[] = [];
  for (const entry of files) {
    const { file, path, text } = entry;
    const fingerprint = fileFingerprint(file);
    const cached = fingerprint === null ? undefined : fileCache.get(path);
    if (cached?.fingerprint === fingerprint) {
      corpus.push(...cached.chunks);
      continue;
    }
    const chunks = chunkText(text, path);
    if (fingerprint !== null) {
      fileCache.set(path, { fingerprint, chunks });
    }
    corpus.push(...chunks);
  }
  for (const document of externalDocuments) {
    const path = normalizePath(document.path);
    const fingerprint = document.content;
    const cached = externalCache.get(path);
    if (cached?.fingerprint === fingerprint) {
      corpus.push(...cached.chunks);
      continue;
    }
    const chunks = chunkText(document.content, path);
    externalCache.set(path, { fingerprint, chunks });
    corpus.push(...chunks);
  }
  return corpus;
}

function isInScope(path: string, scope: string | undefined): boolean {
  if (!scope) return true;
  const wanted = normalizePath(scope.trim());
  if (!wanted) return true;
  const baseName = path.split('/').pop() ?? '';
  const key = baseName.replace(/\.[^.]+$/u, '');
  return path === wanted
    || path.startsWith(`${wanted}/`)
    || path.split('/').some(part => part === wanted)
    || (!wanted.includes('/') && key === wanted);
}

function isExactDocumentScope(
  scope: string | undefined,
  files: readonly IndexableVaultFile[],
  externalDocuments: readonly ExternalPaperSearchDocument[],
): boolean {
  if (!scope) return false;
  const wanted = normalizePath(scope.trim()).toLocaleLowerCase();
  if (!wanted) return false;
  if (files.some(entry => entry.path.toLocaleLowerCase() === wanted)) return true;
  return externalDocuments.some(document => {
    const path = normalizePath(document.path).toLocaleLowerCase();
    const baseName = path.split('/').pop() ?? '';
    const key = baseName.replace(/\.[^.]+$/u, '');
    return path === wanted || (!wanted.includes('/') && key === wanted);
  });
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
  const { app, embedding, vectorStore, externalDocuments } = options;
  let cachePromise: Promise<Map<string, string>> | null = null;
  const fileChunkCache = new Map<string, CachedChunks>();
  const externalChunkCache = new Map<string, CachedChunks>();
  const fileTextCache = new Map<string, { fingerprint: string; text: string }>();
  const lexicalIndexCache = new Map<string, ReturnType<typeof buildLexicalIndex>>();
  const chunkIds = new WeakMap<object, number>();
  let nextChunkId = 1;

  const lexicalIndexFor = (corpus: readonly CorpusChunk[]): ReturnType<typeof buildLexicalIndex> => {
    const key = corpus.map(chunk => {
      let id = chunkIds.get(chunk);
      if (id === undefined) {
        id = nextChunkId++;
        chunkIds.set(chunk, id);
      }
      return id;
    }).join(',');
    const cached = lexicalIndexCache.get(key);
    if (cached !== undefined) return cached;
    const index = buildLexicalIndex(corpus);
    lexicalIndexCache.set(key, index);
    return index;
  };

  const loadCache = async (): Promise<Map<string, string>> => {
    if (!vectorStore) return new Map();
    // Loaded once per session: the map is then mutated in place and re-saved.
    cachePromise ??= vectorStore.load();
    return cachePromise;
  };

  return {
    async searchPapers(request: PaperSearchRequest): Promise<PaperSearchResult> {
      if (request.mode && !(PAPER_SEARCH_MODES as readonly string[]).includes(request.mode)) {
        throw new Error(`mode must be one of ${PAPER_SEARCH_MODES.join(', ')}.`);
      }
      const mode: PaperSearchMode = request.mode ?? 'hybrid';
      const limit = request.limit ?? PAPER_SEARCH_DEFAULT_LIMIT;

      const files = await selectIndexableFiles(app, request.scope, fileTextCache);
      let external: readonly ExternalPaperSearchDocument[] = [];
      let externalFailure: string | null = null;
      if (externalDocuments) {
        try {
          external = await externalDocuments();
        } catch (error) {
          externalFailure = `External paper cache unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const scopedExternal = external.filter(document => (
        !request.scope || isInScope(normalizePath(document.path), request.scope)
      ));
      const corpus = (await buildCorpus(
        files, scopedExternal, fileChunkCache, externalChunkCache,
      )).filter(chunk => !request.kind || chunk.kind === request.kind);
      const queryTokens = tokenize(request.query);

      if (corpus.length === 0) {
        return {
          degraded: externalFailure,
          hits: [],
          index: { chunks: 0, embedded: 0, files: files.length + scopedExternal.length },
          mode,
          query: request.query,
        };
      }

      const lexical: readonly ScoredChunk[] = mode === 'local-vector'
        ? []
        : rankByBm25(lexicalIndexFor(corpus), queryTokens);

      let semantic: readonly ScoredChunk[] = [];
      let degraded: string | null = externalFailure;
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
          degraded = [degraded, result.failure].filter(Boolean).join(' ') || null;
        }
        if (mode === 'local-vector' && semantic.length === 0) {
          throw new Error(degraded ?? 'Semantic search produced no usable vectors.');
        }
      }

      const fused = fuseByReciprocalRank(
        mode === 'keyword' ? [lexical] : mode === 'local-vector' ? [semantic] : [lexical, semantic],
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
      const perPath = new Map<string, number>();
      const seenBodies = new Set<string>();
      const singleFileScope = isExactDocumentScope(request.scope, files, scopedExternal);
      for (const candidate of ordered) {
        const chunk = corpus[candidate.position];
        const bodyKey = `${chunk.path}\u0000${chunk.body.replace(/\s+/gu, ' ').trim()}`;
        if (seenBodies.has(bodyKey)) continue;
        const count = perPath.get(chunk.path) ?? 0;
        if (!singleFileScope && count >= 3) continue;
        seenBodies.add(bodyKey);
        hits.push({
          body: chunk.body,
          heading: chunk.heading,
          kind: chunk.kind,
          locator: chunk.locator,
          path: chunk.path,
          score: toDisplayScore(candidate.score),
          snippet: buildSnippet(chunk.body, queryTokens),
        });
        perPath.set(chunk.path, count + 1);
        if (hits.length >= limit) break;
      }

      return {
        degraded,
        hits,
        index: { chunks: corpus.length, embedded, files: files.length + scopedExternal.length },
        mode,
        query: request.query,
      };
    },
  };
}
