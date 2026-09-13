import { createHash, randomUUID } from 'node:crypto';
import { promises as fs,readFileSync } from 'node:fs';
import path from 'node:path';

import type { App, DataAdapter } from 'obsidian';

/**
 * Persistent state for semantic search: the embedding vector cache, plus the
 * embedding credentials file that search reads on first use.
 *
 * Embedding is the only part of search that costs money and network time, so it
 * is the only part worth persisting. Vectors are keyed by a hash of the model
 * and the exact chunk text, which makes the cache self-invalidating: edited
 * text simply misses, and vectors from a different model can never collide.
 *
 * Everything here lives inside Claudian's own vault data directory, so the
 * Markdown layer stays free of build output and the old external cache path is
 * no longer part of the runtime.
 */

export const EMBEDDING_CACHE_VERSION = 1;
export const EMBEDDING_CACHE_FILENAME = 'claudian-search-embeddings.json';
export const EMBEDDING_CONFIG_FILENAME = 'embedding.json';
export const DERIVED_STATE_DIRECTORY = ['.claudian', 'paper-search'] as const;
/** The credentials file is scoped to Claudian's own vault data directory. */
export const SHARED_CONFIG_DIRECTORY = ['.claudian'] as const;
export const MAX_EMBEDDING_CACHE_VECTORS = 5000;

/** SHA-1 of `model\0text`, matching the retired engine's cache key. */
export function embeddingVectorKey(model: string, text: string): string {
  return createHash('sha1').update(`${model}\u0000${text}`, 'utf8').digest('hex');
}

interface DesktopDataAdapter extends DataAdapter {
  getBasePath(): string;
}

export interface EmbeddingVectorStore {
  load(): Promise<Map<string, string>>;
  save(vectors: ReadonlyMap<string, string>, model: string): Promise<void>;
}

function resolveVaultPath(app: App, segments: readonly string[]): string | null {
  const adapter = app.vault.adapter as Partial<DesktopDataAdapter>;
  if (typeof adapter.getBasePath !== 'function') return null;
  const basePath = adapter.getBasePath().trim();
  if (!basePath) return null;
  return path.resolve(basePath, ...segments);
}

/**
 * Absolute path of the cache file, or null when the vault has no filesystem
 * backing (in which case search still works, just without persistence).
 */
export function resolveEmbeddingCachePath(app: App): string | null {
  return resolveVaultPath(app, [...DERIVED_STATE_DIRECTORY, EMBEDDING_CACHE_FILENAME]);
}

/**
 * Reads the shared embedding credentials file. A missing or malformed file is
 * reported as "no file config" rather than as an error: the environment may
 * already carry everything needed.
 */
export function readEmbeddingConfigFile(app: App): Readonly<Record<string, unknown>> {
  const configPath = resolveVaultPath(app, [...SHARED_CONFIG_DIRECTORY, EMBEDDING_CONFIG_FILENAME]);
  if (!configPath) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface CacheFileShape {
  readonly version?: number;
  readonly model?: string;
  readonly vectors?: Readonly<Record<string, string>>;
}

export function createFileEmbeddingVectorStore(cachePath: string): EmbeddingVectorStore {
  let writeTail = Promise.resolve();
  const trimEntries = (entries: readonly [string, string][]): Map<string, string> => (
    new Map(entries.slice(-MAX_EMBEDDING_CACHE_VECTORS))
  );

  return {
    async load(): Promise<Map<string, string>> {
      try {
        const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as CacheFileShape;
        if (parsed.version !== EMBEDDING_CACHE_VERSION) return new Map();
        const vectors = parsed.vectors ?? {};
        const entries = Object.entries(vectors)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
        return trimEntries(entries);
      } catch {
        // A missing or unreadable cache is not an error: it just misses.
        return new Map();
      }
    },

    async save(vectors: ReadonlyMap<string, string>, model: string): Promise<void> {
      const operation = writeTail.then(async () => {
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        const bounded = trimEntries([...vectors.entries()]);
        const body = JSON.stringify({
          version: EMBEDDING_CACHE_VERSION,
          model,
          vectors: Object.fromEntries(bounded),
        });
        // Serialize saves and use a unique temporary path so concurrent tabs
        // cannot rename each other's file.
        const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, body, 'utf8');
        await fs.rename(temporary, cachePath);
      });
      writeTail = operation.catch(() => undefined);
      await operation;
    },
  };
}
