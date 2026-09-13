/**
 * OpenAI-compatible embeddings client for the semantic half of paper search.
 *
 * Ported from the retired `kb.py` engine: same batch size, same 6000-character
 * input truncation, same retry policy on 429/5xx. Vectors are the only thing
 * this layer produces, so when the endpoint is unavailable the caller degrades
 * to keyword-only search and reports that honestly instead of failing.
 *
 * Credentials come from the environment first, then from a config file, so the
 * plugin keeps working with the same configuration the vault already had.
 */

export const EMBEDDING_BATCH_SIZE = 16;
export const EMBEDDING_TIMEOUT_MS = 90_000;
export const MAX_EMBEDDING_INPUT_CHARS = 6000;
export const EMBEDDING_MAX_ATTEMPTS = 4;
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Environment variable names, in the same precedence order as the engine. */
export const EMBEDDING_ENV_KEYS = {
  url: ['KB_EMBED_URL', 'PHYSICS_KB_EMBEDDING_URL'],
  apiKey: ['KB_EMBED_KEY', 'PHYSICS_KB_EMBEDDING_API_KEY'],
  model: ['KB_EMBED_MODEL', 'PHYSICS_KB_EMBEDDING_MODEL'],
} as const;

export interface EmbeddingConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface EmbeddingClient {
  readonly model: string;
  readonly isEnabled: boolean;
  /** Why semantic search is off, for honest reporting; null when enabled. */
  readonly disabledReason: string | null;
  embedPassages(texts: readonly string[]): Promise<readonly Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array | null>;
}

type Environment = Readonly<Record<string, string | undefined>>;

function firstNonEmpty(
  environment: Environment,
  fileConfig: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  fileKey: string,
): string {
  for (const key of keys) {
    const value = environment[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const fromFile = fileConfig[fileKey];
  if (typeof fromFile === 'string' && fromFile.trim()) return fromFile.trim();
  return '';
}

/**
 * Resolves embedding credentials. Returns null when any part is missing, so the
 * caller can say exactly which capability was lost rather than guessing.
 */
export function resolveEmbeddingConfig(
  environment: Environment,
  fileConfig: Readonly<Record<string, unknown>> = {},
): EmbeddingConfig | null {
  const url = firstNonEmpty(environment, fileConfig, EMBEDDING_ENV_KEYS.url, 'KB_EMBED_URL');
  const apiKey = firstNonEmpty(environment, fileConfig, EMBEDDING_ENV_KEYS.apiKey, 'KB_EMBED_KEY');
  const model = firstNonEmpty(environment, fileConfig, EMBEDDING_ENV_KEYS.model, 'KB_EMBED_MODEL');
  if (!url || !apiKey || !model) return null;
  return { url, apiKey, model };
}

export function encodeVectorBase64(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  return Buffer.from(bytes).toString('base64');
}

export function decodeVectorBase64(encoded: string): Float32Array | null {
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.byteLength === 0 || decoded.byteLength % 4 !== 0) return null;
    // Copy into a freshly allocated, byte-aligned buffer: Buffer.from may hand
    // back a view into a shared pool, which would misalign the Float32 view.
    const aligned = decoded.buffer.slice(
      decoded.byteOffset,
      decoded.byteOffset + decoded.byteLength,
    );
    return new Float32Array(aligned);
  } catch {
    return null;
  }
}

export interface EmbeddingClientOptions {
  readonly config: EmbeddingConfig;
  /** Injected for tests; defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
}

interface EmbeddingResponseBody {
  readonly data?: readonly { readonly embedding?: readonly number[]; readonly index?: number }[];
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => { window.setTimeout(resolve, milliseconds); });
}

export function createEmbeddingClient(options: EmbeddingClientOptions): EmbeddingClient {
  const { config } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? EMBEDDING_TIMEOUT_MS;

  async function post(texts: readonly string[]): Promise<readonly Float32Array[]> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const response = await doFetch(config.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          input: [...texts],
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
        (error as Error & { status?: number }).status = response.status;
        throw error;
      }
      const body = await response.json() as EmbeddingResponseBody;
      const items = [...(body.data ?? [])];
      items.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      return items.map(item => Float32Array.from(item.embedding ?? []));
    } finally {
      window.clearTimeout(timer);
    }
  }

  return {
    model: config.model,
    isEnabled: true,
    disabledReason: null,

    async embedPassages(texts: readonly string[]): Promise<readonly Float32Array[]> {
      const pending = texts
        .map((text, position) => ({ position, text }))
        .filter(entry => entry.text.trim().length > 0);
      if (pending.length === 0) return [];

      const results = new Map<number, Float32Array>();
      for (let start = 0; start < pending.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = pending.slice(start, start + EMBEDDING_BATCH_SIZE);
        const payload = batch.map(entry => entry.text.slice(0, MAX_EMBEDDING_INPUT_CHARS));

        for (let attempt = 1; attempt <= EMBEDDING_MAX_ATTEMPTS; attempt += 1) {
          try {
            const vectors = await post(payload);
            for (const [offset, entry] of batch.entries()) {
              const vector = vectors[offset];
              if (vector) results.set(entry.position, vector);
            }
            break;
          } catch (error) {
            const status = (error as Error & { status?: number }).status;
            const retryable = status === undefined || RETRYABLE_STATUS.has(status);
            if (!retryable || attempt === EMBEDDING_MAX_ATTEMPTS) {
              // Partial vectors are still useful; the caller reports the loss.
              return [...results.entries()]
                .sort((left, right) => left[0] - right[0])
                .map(entry => entry[1]);
            }
            await sleep(1500 * attempt);
          }
        }
      }
      return [...results.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(entry => entry[1]);
    },

    async embedQuery(text: string): Promise<Float32Array | null> {
      const vectors = await this.embedPassages([text]);
      return vectors[0] ?? null;
    },
  };
}

/** A client that is present but disabled, carrying the reason for reporting. */
export function createDisabledEmbeddingClient(reason: string): EmbeddingClient {
  return {
    model: '',
    isEnabled: false,
    disabledReason: reason,
    embedPassages: async () => [],
    embedQuery: async () => null,
  };
}
