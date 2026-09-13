import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { spawn as nodeSpawn } from 'node:child_process';

import crossSpawn from 'cross-spawn';
import type { App } from 'obsidian';
import { TFile as ObsidianFile } from 'obsidian';

import { resolveWindowsCmdShimSpawnSpec } from '@/utils/windowsCmdShim';

import {
  buildCacheNavigationIndex,
  buildPageAnchoredMarkdown,
  PAPER_CACHE_FILES,
  PAPER_CACHE_ROOT,
  PAPER_CACHE_SCHEMA_VERSION,
} from './PaperCachePackage';
import { sha256Hex } from './PaperContentResolver';

const spawn = crossSpawn as typeof nodeSpawn;
const PARSER = 'mineru-open-api';

type FileSystemVaultAdapter = {
  getFullPath(path: string): string;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
};

function getAdapter(app: App): FileSystemVaultAdapter {
  const adapter = app.vault.adapter as Partial<FileSystemVaultAdapter>;
  if (!adapter.getFullPath || !adapter.exists || !adapter.list || !adapter.mkdir
    || !adapter.remove || !adapter.rename || !adapter.read || !adapter.write) {
    throw new Error('The active Obsidian vault does not expose a desktop file adapter.');
  }
  return adapter as FileSystemVaultAdapter;
}

function fileStem(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return name.replace(/\.pdf$/i, '') || 'paper';
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

async function cacheIdFor(sourcePath: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizePath(sourcePath));
  const digest = await sha256Hex(bytes.buffer);
  return digest.slice(0, 16).toLocaleLowerCase();
}

function cacheDirFor(sourcePath: string, cacheId: string): string {
  return `${PAPER_CACHE_ROOT}/${fileStem(sourcePath)}--${cacheId}`;
}

function runParser(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const spec = resolveWindowsCmdShimSpawnSpec({ command, args });
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env: process.env,
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      stderr = `${stderr}${text}`.slice(-8_000);
    });
    child.once('error', error => reject(error));
    child.once('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(new Error(
        `${PARSER} exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
      ));
    });
  });
}

async function ensureFolder(adapter: FileSystemVaultAdapter, path: string): Promise<void> {
  if (!(await adapter.exists(path))) await adapter.mkdir(path);
}

async function ensureFolderTree(adapter: FileSystemVaultAdapter, path: string): Promise<void> {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    await ensureFolder(adapter, current);
  }
}

async function clearGeneratedFiles(
  adapter: FileSystemVaultAdapter,
  cacheDir: string,
  stem: string,
): Promise<void> {
  if (!(await adapter.exists(cacheDir))) return;
  const listing = await adapter.list(cacheDir);
  const generated = listing.files.filter(path => {
    const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
    return name === PAPER_CACHE_FILES.manifest
      || name === PAPER_CACHE_FILES.fullMarkdown
      || name === PAPER_CACHE_FILES.contentList
      || name === PAPER_CACHE_FILES.source
      || (name.startsWith(stem) && /\.(?:md|json)$/i.test(name));
  });
  if (await adapter.exists(`${cacheDir}/images`)) {
    const imageListing = await adapter.list(`${cacheDir}/images`);
    generated.push(...imageListing.files);
  }
  await Promise.all(generated.map(path => adapter.remove(path)));
}

async function removeEmptyPackage(adapter: FileSystemVaultAdapter, cacheDir: string): Promise<void> {
  const imageDir = `${cacheDir}/images`;
  if (await adapter.exists(imageDir)) {
    const images = await adapter.list(imageDir);
    if (images.files.length === 0 && images.folders.length === 0) {
      try {
        await adapter.remove(imageDir);
      } catch {
        // Some desktop adapters cannot remove directories through this API.
      }
    }
  }
  if (await adapter.exists(cacheDir)) {
    const packageListing = await adapter.list(cacheDir);
    if (packageListing.files.length === 0 && packageListing.folders.length === 0) {
      try {
        await adapter.remove(cacheDir);
      } catch {
        // A leftover empty directory is harmless and not a readable cache.
      }
    }
  }
}

async function waitForVaultFile(app: App, path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof ObsidianFile) return;
    await new Promise<void>(resolve => window.setTimeout(resolve, 100));
  }
  throw new Error(`Obsidian did not refresh the parsed file: ${path}`);
}

export function createVaultMineruCacheEnsurer(app: App): (sourcePath: string) => Promise<void> {
  return async (sourcePath: string): Promise<void> => {
    const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof ObsidianFile) || sourceFile.extension.toLocaleLowerCase() !== 'pdf') {
      throw new Error(`Linked PDF is unavailable: ${sourcePath}`);
    }

    const adapter = getAdapter(app);
    const stem = fileStem(sourcePath);
    const normalizedSourcePath = normalizePath(sourcePath);
    const sourceHash = await sha256Hex(await app.vault.readBinary(sourceFile));
    const cacheId = await cacheIdFor(normalizedSourcePath);
    const cacheDir = cacheDirFor(normalizedSourcePath, cacheId);
    const fullMarkdownPath = `${cacheDir}/${PAPER_CACHE_FILES.fullMarkdown}`;
    const contentListPath = `${cacheDir}/${PAPER_CACHE_FILES.contentList}`;
    const sourcePathFile = `${cacheDir}/${PAPER_CACHE_FILES.source}`;
    const manifestPath = `${cacheDir}/${PAPER_CACHE_FILES.manifest}`;
    await ensureFolderTree(adapter, cacheDir);
    await clearGeneratedFiles(adapter, cacheDir, stem);

    const basePath = adapter.getFullPath('');
    try {
      await runParser(
        process.platform === 'win32' ? `${PARSER}.cmd` : PARSER,
        [
          'extract',
          adapter.getFullPath(sourcePath),
          '-f', 'md,json',
          '--language', 'en',
          '-o', basePath + '/' + cacheDir,
        ],
        basePath,
      );
    } catch (error) {
      await clearGeneratedFiles(adapter, cacheDir, stem);
      await removeEmptyPackage(adapter, cacheDir);
      throw error;
    }

    const listing = await adapter.list(cacheDir);
    const markdownCandidate = listing.files.find(path => path.endsWith('.paged.md'))
      ?? listing.files.find(path => /\.md$/i.test(path));
    if (!markdownCandidate) {
      throw new Error(`MinerU did not produce Markdown in ${cacheDir}.`);
    }
    const rawMarkdown = await adapter.read(markdownCandidate);

    const jsonCandidate = listing.files.find(path => {
      const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
      return /\.json$/i.test(name) && name !== PAPER_CACHE_FILES.manifest;
    });
    const rawContentList = jsonCandidate ? await adapter.read(jsonCandidate) : '[]\n';
    let contentList: unknown;
    try {
      contentList = JSON.parse(rawContentList);
    } catch {
      // Keep the raw parser output for diagnosis, but don't let a malformed
      // optional sidecar prevent the usable Markdown package from being read.
      contentList = [];
    }
    const fullMarkdown = buildPageAnchoredMarkdown(rawMarkdown, contentList);
    await adapter.write(fullMarkdownPath, fullMarkdown);
    await adapter.write(contentListPath, rawContentList.endsWith('\n') ? rawContentList : `${rawContentList}\n`);
    if (markdownCandidate !== fullMarkdownPath) await adapter.remove(markdownCandidate);
    if (jsonCandidate && jsonCandidate !== contentListPath) await adapter.remove(jsonCandidate);

    const parsedAt = new Date().toISOString();
    const sourceMtime = sourceFile.stat.mtime > 0
      ? new Date(sourceFile.stat.mtime).toISOString()
      : undefined;
    const navigation = buildCacheNavigationIndex(fullMarkdown, contentList);
    const relativeImagesPath = `${cacheDir}/images`;
    await adapter.write(sourcePathFile, JSON.stringify({
      attachmentId: cacheId,
      cacheId,
      sourcePath: normalizedSourcePath,
      sourceFilename: sourceFile.name,
      sourceSha256: sourceHash,
      sourceBytes: sourceFile.stat.size,
      origin: 'parsed',
      parsedAt,
    }, null, 2) + '\n');
    const manifest = {
      schema_version: PAPER_CACHE_SCHEMA_VERSION,
      cache_id: cacheId,
      citekey: stem,
      source_pdf: normalizedSourcePath,
      source_sha256: sourceHash,
      source_bytes: sourceFile.stat.size,
      ...(sourceMtime ? { source_mtime: sourceMtime } : {}),
      source: {
        path: normalizedSourcePath,
        filename: sourceFile.name,
        sha256: sourceHash,
        bytes: sourceFile.stat.size,
        ...(sourceMtime ? { mtime: sourceMtime } : {}),
      },
      parser: PARSER,
      parser_version: 'cli',
      mode: 'precision',
      parameters: {
        file_sources: [normalizedSourcePath],
        output_dir: cacheDir,
        formats: ['md', 'json'],
        language: 'en',
        formula: true,
        table: true,
        ocr: false,
      },
      status: 'success',
      full_md: fullMarkdownPath,
      output: fullMarkdownPath,
      json_output: contentListPath,
      images_dir: relativeImagesPath,
      files: {
        full_md: fullMarkdownPath,
        content_list: contentListPath,
        source: sourcePathFile,
        images: relativeImagesPath,
      },
      parsed_at: parsedAt,
      ...navigation,
    };
    await adapter.write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await waitForVaultFile(app, fullMarkdownPath);
    await waitForVaultFile(app, contentListPath);
    await waitForVaultFile(app, sourcePathFile);
    await waitForVaultFile(app, manifestPath);
  };
}
