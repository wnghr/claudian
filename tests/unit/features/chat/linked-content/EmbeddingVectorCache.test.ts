import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from 'obsidian';

import {
  createFileEmbeddingVectorStore,
  EMBEDDING_CACHE_VERSION,
  embeddingVectorKey,
  readEmbeddingConfigFile,
  resolveEmbeddingCachePath,
} from '@/features/chat/linked-content/EmbeddingVectorCache';

async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'claudian-embed-'));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeApp(basePath: string): App {
  return { vault: { adapter: { getBasePath: () => basePath } } } as unknown as App;
}

describe('embeddingVectorKey', () => {
  it('is stable for the same model and text', () => {
    expect(embeddingVectorKey('BAAI/bge-m3', 'nematic skyrmion'))
      .toBe(embeddingVectorKey('BAAI/bge-m3', 'nematic skyrmion'));
  });

  it('changes when the model changes', () => {
    expect(embeddingVectorKey('BAAI/bge-m3', 'nematic skyrmion'))
      .not.toBe(embeddingVectorKey('text-embedding-3-small', 'nematic skyrmion'));
  });

  it('changes when the text changes', () => {
    expect(embeddingVectorKey('BAAI/bge-m3', 'nematic skyrmion'))
      .not.toBe(embeddingVectorKey('BAAI/bge-m3', 'nematic colloid'));
  });
});

describe('resolveEmbeddingCachePath', () => {
  it('joins the workspace-derived state directory onto the vault base path', () => {
    const path = resolveEmbeddingCachePath(fakeApp('D:/research/research'));
    expect(path).toMatch(/[\\/]\.claudian[\\/]paper-search[\\/]claudian-search-embeddings\.json$/u);
    expect(path).toMatch(/^D:[\\/]research[\\/]research[\\/]\.claudian[\\/]paper-search/u);
  });

  it('returns null when the adapter has no filesystem backing', () => {
    expect(resolveEmbeddingCachePath({ vault: { adapter: {} } } as unknown as App))
      .toBeNull();
  });
});

describe('readEmbeddingConfigFile', () => {
  it('returns an empty object when the file is missing or unreadable', () => {
    expect(readEmbeddingConfigFile(fakeApp('D:/no/such/vault'))).toEqual({});
  });

  it('parses an object-shaped JSON config', async () => {
    await withTempDir(async dir => {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(dir, 'vault', '.claudian'), { recursive: true });
      await fs.writeFile(join(dir, 'vault', '.claudian/embedding.json'),
        JSON.stringify({ CLAUDIAN_EMBED_KEY: 'k', CLAUDIAN_EMBED_MODEL: 'm' }), 'utf8');

      expect(readEmbeddingConfigFile(fakeApp(join(dir, 'vault')))).toEqual({
        CLAUDIAN_EMBED_KEY: 'k',
        CLAUDIAN_EMBED_MODEL: 'm',
      });
    });
  });

  it('returns empty for malformed JSON or non-object content', async () => {
    await withTempDir(async dir => {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(dir, 'vault', '.claudian'), { recursive: true });
      const bad = join(dir, 'vault', '.claudian/embedding.json');
      await fs.writeFile(bad, 'not json', 'utf8');
      expect(readEmbeddingConfigFile(fakeApp(join(dir, 'vault')))).toEqual({});
      await fs.writeFile(bad, '[]', 'utf8');
      expect(readEmbeddingConfigFile(fakeApp(join(dir, 'vault')))).toEqual({});
    });
  });
});

describe('createFileEmbeddingVectorStore', () => {
  it('returns an empty map when no file exists', async () => {
    await withTempDir(async dir => {
      const store = createFileEmbeddingVectorStore(join(dir, 'cache.json'));
      await expect(store.load()).resolves.toEqual(new Map());
    });
  });

  it('round-trips vectors through save and load', async () => {
    await withTempDir(async dir => {
      const store = createFileEmbeddingVectorStore(join(dir, 'cache.json'));
      const input = new Map([
        ['k1', 'AAAA'],
        ['k2', 'BBBB'],
      ]);

      await store.save(input, 'BAAI/bge-m3');
      await expect(store.load()).resolves.toEqual(input);
    });
  });

  it('refuses to load a cache from a different version', async () => {
    await withTempDir(async dir => {
      const fs = await import('node:fs/promises');
      const path = join(dir, 'cache.json');
      await fs.writeFile(path, JSON.stringify({
        version: 99, model: 'x', vectors: { k: 'AAAA' },
      }), 'utf8');

      const store = createFileEmbeddingVectorStore(path);
      await expect(store.load()).resolves.toEqual(new Map());
    });
  });

  it('writes atomically and leaves no temp file behind', async () => {
    await withTempDir(async dir => {
      const fs = await import('node:fs/promises');
      const path = join(dir, 'cache.json');
      const store = createFileEmbeddingVectorStore(path);

      await store.save(new Map([['k', 'AAAA']]), 'BAAI/bge-m3');
      const entries = await fs.readdir(dir);
      expect(entries.sort()).toEqual(['cache.json']);
      // The saved file declares its version so a future migration can detect it.
      const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as { version: number };
      expect(parsed.version).toBe(EMBEDDING_CACHE_VERSION);
    });
  });

  it('bounds the persisted cache instead of growing forever', async () => {
    await withTempDir(async dir => {
      const fs = await import('node:fs/promises');
      const path = join(dir, 'cache.json');
      const vectors = new Map<string, string>();
      for (let index = 0; index < 5005; index += 1) {
        vectors.set(`key-${index}`, 'AAAA');
      }
      const store = createFileEmbeddingVectorStore(path);
      await store.save(vectors, 'model');
      const loaded = await store.load();
      expect(loaded.size).toBe(5000);
      expect(loaded.has('key-0')).toBe(false);
      expect(loaded.has('key-5004')).toBe(true);
      expect((JSON.parse(await fs.readFile(path, 'utf8')) as { vectors: Record<string, string> }).vectors)
        .toHaveProperty('key-5004');
    });
  });

  it('serializes concurrent saves and leaves no shared temp file', async () => {
    await withTempDir(async dir => {
      const fs = await import('node:fs/promises');
      const path = join(dir, 'cache.json');
      const store = createFileEmbeddingVectorStore(path);
      await Promise.all([
        store.save(new Map([['first', 'AAAA']]), 'model'),
        store.save(new Map([['second', 'BBBB']]), 'model'),
      ]);
      const entries = await fs.readdir(dir);
      expect(entries).toEqual(['cache.json']);
      expect((await store.load()).size).toBe(1);
    });
  });
});
