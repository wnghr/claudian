import {
  createDisabledEmbeddingClient,
  createEmbeddingClient,
  decodeVectorBase64,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_ENV_KEYS,
  type EmbeddingConfig,
  encodeVectorBase64,
  MAX_EMBEDDING_INPUT_CHARS,
  resolveEmbeddingConfig,
} from '@/core/search/embedding';

function jsonResponse(embeddings: readonly (readonly number[])[]): Response {
  return new Response(JSON.stringify({
    data: embeddings.map((embedding, index) => ({ embedding, index })),
    usage: { total_tokens: 0 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('resolveEmbeddingConfig', () => {
  it('returns null when any required part is missing', () => {
    expect(resolveEmbeddingConfig({})).toBeNull();
    expect(resolveEmbeddingConfig({ KB_EMBED_URL: 'https://api.example.com' })).toBeNull();
  });

  it('prefers KB_EMBED_* over PHYSICS_KB_EMBEDDING_* over a file', () => {
    const config = resolveEmbeddingConfig(
      { KB_EMBED_KEY: 'primary', KB_EMBED_MODEL: 'env-model', KB_EMBED_URL: 'env-url' },
      { KB_EMBED_KEY: 'from-file' },
    );
    expect(config).toEqual({
      apiKey: 'primary',
      model: 'env-model',
      url: 'env-url',
    });
  });

  it('falls back to the PHYSICS_KB_* names when KB_EMBED_* is unset', () => {
    const config = resolveEmbeddingConfig(
      { PHYSICS_KB_EMBEDDING_MODEL: 'BAAI/bge-m3' },
      { KB_EMBED_KEY: 'file-key', KB_EMBED_URL: 'file-url' },
    );
    expect(config).toEqual({
      apiKey: 'file-key',
      model: 'BAAI/bge-m3',
      url: 'file-url',
    });
  });

  it('reads from a config file when no environment variable is set', () => {
    const config = resolveEmbeddingConfig({}, {
      KB_EMBED_KEY: 'k',
      KB_EMBED_MODEL: 'm',
      KB_EMBED_URL: 'u',
    });
    expect(config).toEqual({ apiKey: 'k', model: 'm', url: 'u' });
  });

  it('ignores blank environment values', () => {
    expect(resolveEmbeddingConfig({ KB_EMBED_KEY: '   ' })).toBeNull();
  });

  it('exposes the same env keys the engine has used historically', () => {
    expect(EMBEDDING_ENV_KEYS.apiKey).toEqual(['KB_EMBED_KEY', 'PHYSICS_KB_EMBEDDING_API_KEY']);
    expect(EMBEDDING_ENV_KEYS.url).toEqual(['KB_EMBED_URL', 'PHYSICS_KB_EMBEDDING_URL']);
    expect(EMBEDDING_ENV_KEYS.model).toEqual(['KB_EMBED_MODEL', 'PHYSICS_KB_EMBEDDING_MODEL']);
  });
});

describe('base64 round trip', () => {
  it('survives a 1024-dimensional float vector', () => {
    const vector = new Float32Array(1024);
    for (let index = 0; index < vector.length; index += 1) vector[index] = index * 0.0001 - 0.5;

    expect(decodeVectorBase64(encodeVectorBase64(vector))).toEqual(vector);
  });

  it('rejects input that is not a multiple of 4 bytes', () => {
    expect(decodeVectorBase64('AAA')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(decodeVectorBase64('')).toBeNull();
  });
});

describe('createEmbeddingClient', () => {
  const config: EmbeddingConfig = {
    apiKey: 'test-key',
    model: 'BAAI/bge-m3',
    url: 'https://api.example.com/v1/embeddings',
  };

  it('embeds passages and returns them in the original order', async () => {
    // A `Response` body is single-use, so the mock must hand out a fresh one
    // per call; otherwise the second batch fails on a consumed stream and the
    // client hits its retry/sleep path inside a test timeout.
    const fetchImpl = jest.fn().mockImplementation(async () => jsonResponse([[1, 0, 0], [0, 1, 0], [0, 0, 1]]));

    const client = createEmbeddingClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch });

    const vectors = await client.embedPassages(['alpha', 'beta', 'gamma']);
    expect(vectors.map(toArray)).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  });

  it('batches large inputs so no single request exceeds the batch size', async () => {
    const fetchImpl = jest.fn().mockImplementation(async (_url, init) => {
      const sent = (JSON.parse((init as { body: string }).body).input as readonly unknown[]).length;
      return jsonResponse(new Array(sent).fill([1, 0]));
    });

    const client = createEmbeddingClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch });
    const inputs = Array.from({ length: EMBEDDING_BATCH_SIZE + 4 }, (_, index) => `t${index}`);
    await client.embedPassages(inputs);

    const sentSizes = fetchImpl.mock.calls.map(call => {
      const body = (call[1] as { body: string }).body;
      return (JSON.parse(body).input as readonly unknown[]).length;
    });
    expect(sentSizes).toEqual([EMBEDDING_BATCH_SIZE, 4]);
  });

  it('truncates each input to the maximum character count', async () => {
    let captured = '';
    const fetchImpl = jest.fn().mockImplementation(async (_url, init) => {
      captured = (init as { body: string }).body;
      return jsonResponse([[1]]);
    });

    const client = createEmbeddingClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.embedPassages(['x'.repeat(MAX_EMBEDDING_INPUT_CHARS + 1000)]);

    const sent = JSON.parse(captured).input[0] as string;
    expect(sent.length).toBe(MAX_EMBEDDING_INPUT_CHARS);
  });

  it('skips blank inputs rather than asking the endpoint about them', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse([[1]]));
    const client = createEmbeddingClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch });

    const vectors = await client.embedPassages(['', '  ', 'real']);
    expect(vectors).toHaveLength(1);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce(jsonResponse([[1, 0]]));

    const client = createEmbeddingClient({
      config, fetchImpl: fetchImpl as unknown as typeof fetch, sleep,
    });
    const vectors = await client.embedPassages(['term']);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(vectors).toEqual([new Float32Array([1, 0])]);
  });

  it('does not retry a permanent failure (HTTP 400)', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fetchImpl = jest.fn().mockResolvedValue(new Response('bad request', { status: 400 }));

    const client = createEmbeddingClient({
      config, fetchImpl: fetchImpl as unknown as typeof fetch, sleep,
    });
    const vectors = await client.embedPassages(['term']);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(vectors).toEqual([]);
  });

  it('exhausts retries on a persistent server error and returns whatever did succeed', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(new Response('boom', { status: 504 }));

    const client = createEmbeddingClient({
      config, fetchImpl: fetchImpl as unknown as typeof fetch, sleep,
    });
    const vectors = await client.embedPassages(['first', 'second']);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(vectors).toEqual([]);
  });
});

describe('createDisabledEmbeddingClient', () => {
  it('reports the reason and returns no vectors', async () => {
    const client = createDisabledEmbeddingClient('no endpoint configured');

    expect(client.isEnabled).toBe(false);
    expect(client.disabledReason).toBe('no endpoint configured');
    await expect(client.embedPassages(['term'])).resolves.toEqual([]);
    await expect(client.embedQuery('term')).resolves.toBeNull();
  });
});

function toArray(vector: Float32Array): number[] {
  return Array.from(vector);
}
