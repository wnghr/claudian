import type { App, TFile } from 'obsidian';
import { TFile as ObsidianFile } from 'obsidian';

const PAPER_CACHE_ROOT = '论文/MD/';

export type PaperContentStatus = 'ready' | 'missing' | 'stale' | 'invalid';

export interface PaperContentResult {
  readonly status: PaperContentStatus;
  readonly sourcePath: string;
  readonly cachePath?: string;
  readonly content?: string;
  readonly complete?: boolean;
  readonly sha256?: string;
  readonly reason?: string;
}

export interface PaperContentResolverOptions {
  readonly getFile: (path: string) => PaperContentFile | null;
  readonly getFiles: () => readonly PaperContentFile[];
  readonly read: (file: PaperContentFile) => Promise<string>;
  readonly readBinary: (file: PaperContentFile) => Promise<ArrayBuffer>;
  readonly hashBinary?: (binary: ArrayBuffer) => Promise<string>;
}

export interface PaperContentFile {
  readonly path: string;
  readonly extension: string;
}

export interface PaperContentResolveOptions {
  readonly maxChars?: number;
}

async function sha256Hex(binary: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', binary);
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
  return path.startsWith(PAPER_CACHE_ROOT) && path.endsWith('/manifest.json');
}

function getCachePath(manifest: Record<string, unknown>): string | null {
  for (const key of ['paged_md', 'output']) {
    const value = manifest[key];
    if (typeof value === 'string' && value.trim()) return normalizePath(value);
  }
  return null;
}

export class PaperContentResolver {
  constructor(private readonly options: PaperContentResolverOptions) {}

  async resolve(
    sourcePath: string,
    resolveOptions: PaperContentResolveOptions = {},
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
    const recordedHash = typeof manifest.data.source_sha256 === 'string'
      ? manifest.data.source_sha256.toUpperCase()
      : '';
    if (!recordedHash || currentHash.toUpperCase() !== recordedHash) {
      return {
        status: 'stale',
        sourcePath: normalizedSourcePath,
        cachePath: getCachePath(manifest.data) ?? undefined,
        sha256: currentHash,
        reason: 'The PDF changed after this cache was created.',
      };
    }

    if (String(manifest.data.status ?? '').toLocaleLowerCase() !== 'success') {
      return {
        status: 'invalid',
        sourcePath: normalizedSourcePath,
        cachePath: getCachePath(manifest.data) ?? undefined,
        sha256: currentHash,
        reason: 'The cache manifest is not marked as successful.',
      };
    }

    const cachePath = getCachePath(manifest.data);
    const cacheFile = cachePath ? this.options.getFile(cachePath) : null;
    if (!cachePath || !cacheFile) {
      return {
        status: 'invalid',
        sourcePath: normalizedSourcePath,
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
      content: complete ? fullContent : fullContent.slice(0, maxChars),
      complete,
      sha256: currentHash,
      ...(complete ? {} : { reason: `The cached Markdown exceeds the ${maxChars}-character read limit.` }),
    };
  }

  private async findManifest(
    sourcePath: string,
  ): Promise<{ file: PaperContentFile; data: Record<string, unknown> } | null> {
    for (const file of this.options.getFiles().filter(isManifest)) {
      let data: unknown;
      try {
        data = JSON.parse(await this.options.read(file));
      } catch {
        continue;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const sourcePdf = (data as Record<string, unknown>).source_pdf;
      if (typeof sourcePdf === 'string' && normalizePath(sourcePdf) === sourcePath) {
        return { file, data: data as Record<string, unknown> };
      }
    }
    return null;
  }
}

export function createVaultPaperContentResolver(app: App): PaperContentResolver {
  const getVaultFile = (path: string): TFile => {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof ObsidianFile)) {
      throw new Error(`Vault file is unavailable: ${path}`);
    }
    return file;
  };

  return new PaperContentResolver({
    getFile: path => {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof ObsidianFile ? file : null;
    },
    getFiles: () => app.vault.getFiles(),
    read: file => app.vault.read(getVaultFile(file.path)),
    readBinary: file => app.vault.readBinary(getVaultFile(file.path)),
  });
}
