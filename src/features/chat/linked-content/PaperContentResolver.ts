import type { PaperReadFidelity } from '../../../core/paper/PaperRead';
import {
  manifestFullMarkdownPath,
  manifestSourceHash,
  manifestSourcePath,
  PAPER_CACHE_ROOT,
  type PaperCacheManifest,
} from './PaperCachePackage';

export type PaperContentStatus = 'ready' | 'missing' | 'stale' | 'invalid';

export interface PaperContentResult {
  readonly status: PaperContentStatus;
  readonly sourcePath: string;
  readonly cachePath?: string;
  readonly content?: string;
  readonly complete?: boolean;
  readonly sha256?: string;
  readonly manifestPath?: string;
  readonly manifest?: PaperCacheManifest;
  readonly reason?: string;
  /** Which source the text came from; `mineru-md` unless a tier says otherwise. */
  readonly fidelity?: PaperReadFidelity;
  /** Pages the returned text covers. */
  readonly pageCount?: number;
  /** Caveats the producing tier wants the caller to pass on. */
  readonly warnings?: readonly string[];
}

export interface PaperContentResolverOptions {
  readonly getFile: (path: string) => PaperContentFile | null;
  readonly getFiles: () => readonly PaperContentFile[];
  readonly read: (file: PaperContentFile) => Promise<string>;
  readonly readBinary: (file: PaperContentFile) => Promise<ArrayBuffer>;
  readonly hashBinary?: (binary: ArrayBuffer) => Promise<string>;
  /**
   * Tiers to try before the vault's own MinerU cache. The first non-null answer
   * wins, which is what keeps an unparseable Zotero attachment readable from
   * Zotero's own full-text cache.
   */
  readonly resolveExternalCache?: (sourcePath: string) => Promise<PaperContentResult | null>;
}

export interface PaperContentFile {
  readonly path: string;
  readonly extension: string;
}

export interface PaperContentResolveOptions {
  readonly maxChars?: number;
}

export async function sha256Hex(binary: ArrayBuffer): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', binary);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function isManifest(file: PaperContentFile): boolean {
  const path = normalizePath(file.path);
  return path.startsWith(`${PAPER_CACHE_ROOT}/`) && path.endsWith('/manifest.json');
}

function normalizeOptionalPath(path: string | null): string | undefined {
  return path ? normalizePath(path) : undefined;
}

export class PaperContentResolver {
  constructor(private readonly options: PaperContentResolverOptions) {}

  async resolve(
    sourcePath: string,
    resolveOptions: PaperContentResolveOptions = {},
  ): Promise<PaperContentResult> {
    const external = await this.options.resolveExternalCache?.(sourcePath);
    if (external) return external;
    return this.resolveCurrent(sourcePath, resolveOptions);
  }

  private async resolveCurrent(
    sourcePath: string,
    resolveOptions: PaperContentResolveOptions,
  ): Promise<PaperContentResult> {
    const normalizedSourcePath = normalizePath(sourcePath);
    const sourceFile = this.options.getFile(normalizedSourcePath);
    if (!sourceFile || sourceFile.extension.toLocaleLowerCase() !== 'pdf') {
      return {
        status: 'missing',
        sourcePath: normalizedSourcePath,
        reason: 'The linked PDF is not available in the vault.',
      };
    }

    const manifest = await this.findManifest(normalizedSourcePath);
    if (!manifest) {
      return {
        status: 'missing',
        sourcePath: normalizedSourcePath,
        reason: 'No MinerU cache manifest matches this PDF.',
      };
    }

    const currentHash = await (this.options.hashBinary ?? sha256Hex)(
      await this.options.readBinary(sourceFile),
    );
    const recordedHash = manifestSourceHash(manifest.data)?.toUpperCase() ?? '';
    if (!recordedHash || currentHash.toUpperCase() !== recordedHash) {
      return {
        status: 'stale',
        sourcePath: normalizedSourcePath,
        cachePath: normalizeOptionalPath(manifestFullMarkdownPath(manifest.data)),
        manifestPath: normalizePath(manifest.file.path),
        manifest: manifest.data,
        sha256: currentHash,
        reason: 'The PDF changed after this cache was created.',
      };
    }

    if (String(manifest.data.status ?? '').toLocaleLowerCase() !== 'success') {
      return {
        status: 'invalid',
        sourcePath: normalizedSourcePath,
        cachePath: normalizeOptionalPath(manifestFullMarkdownPath(manifest.data)),
        manifestPath: normalizePath(manifest.file.path),
        manifest: manifest.data,
        sha256: currentHash,
        reason: 'The cache manifest is not marked as successful.',
      };
    }

    const cachePath = normalizeOptionalPath(manifestFullMarkdownPath(manifest.data));
    const cacheFile = cachePath ? this.options.getFile(cachePath) : null;
    if (!cachePath || !cacheFile) {
      return {
        status: 'invalid',
        sourcePath: normalizedSourcePath,
        manifestPath: normalizePath(manifest.file.path),
        manifest: manifest.data,
        sha256: currentHash,
        reason: 'The cache manifest points to a missing Markdown file.',
      };
    }

    const fullContent = await this.options.read(cacheFile);
    if (!fullContent.trim()) {
      return {
        status: 'invalid',
        sourcePath: normalizedSourcePath,
        cachePath,
        manifestPath: normalizePath(manifest.file.path),
        manifest: manifest.data,
        sha256: currentHash,
        reason: 'The cached Markdown file is empty.',
      };
    }

    const maxChars = resolveOptions.maxChars ?? 200_000;
    const complete = fullContent.length <= maxChars;
    return {
      status: 'ready',
      sourcePath: normalizedSourcePath,
      cachePath,
      manifestPath: normalizePath(manifest.file.path),
      manifest: manifest.data,
      content: complete ? fullContent : fullContent.slice(0, maxChars),
      complete,
      fidelity: 'mineru-md',
      sha256: currentHash,
      ...(complete ? {} : { reason: `The cached Markdown exceeds the ${maxChars}-character read limit.` }),
    };
  }

  private async findManifest(
    sourcePath: string,
  ): Promise<{ file: PaperContentFile; data: Record<string, unknown> } | null> {
    const matches: { file: PaperContentFile; data: Record<string, unknown> }[] = [];
    for (const file of this.options.getFiles().filter(isManifest)) {
      let data: unknown;
      try {
        data = JSON.parse(await this.options.read(file));
      } catch {
        continue;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const sourcePdf = manifestSourcePath(data as PaperCacheManifest);
      if (sourcePdf !== null && normalizePath(sourcePdf) === sourcePath) {
        matches.push({ file, data: data as Record<string, unknown> });
      }
    }
    return matches.sort((left, right) => manifestPriority(right.data) - manifestPriority(left.data))[0] ?? null;
  }
}

function manifestPriority(manifest: Readonly<Record<string, unknown>>): number {
  const schema = typeof manifest.schema_version === 'number' ? manifest.schema_version : 0;
  const parsedAt = typeof manifest.parsed_at === 'string' ? Date.parse(manifest.parsed_at) : 0;
  return schema * 1_000_000_000_000 + (Number.isFinite(parsedAt) ? parsedAt : 0);
}
