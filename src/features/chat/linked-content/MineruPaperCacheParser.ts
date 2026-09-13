import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { spawn as nodeSpawn } from 'node:child_process';

import crossSpawn from 'cross-spawn';
import type { App } from 'obsidian';
import { TFile as ObsidianFile } from 'obsidian';

import { resolveWindowsCmdShimSpawnSpec } from '@/utils/windowsCmdShim';

import { sha256Hex } from './PaperContentResolver';

const spawn = crossSpawn as typeof nodeSpawn;
const CACHE_ROOT = '论文/MD';
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

function cacheDirFor(sourcePath: string): string {
  return `${CACHE_ROOT}/${fileStem(sourcePath)}`;
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
    return name === 'manifest.json'
      || (name.startsWith(stem) && /\.(?:md|json)$/i.test(name));
  });
  await Promise.all(generated.map(path => adapter.remove(path)));
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
    const cacheDir = cacheDirFor(sourcePath);
    const stem = fileStem(sourcePath);
    const outputPath = `${cacheDir}/${stem}.md`;
    const jsonPath = `${cacheDir}/${stem}.json`;
    const manifestPath = `${cacheDir}/manifest.json`;
    await ensureFolderTree(adapter, cacheDir);
    await clearGeneratedFiles(adapter, cacheDir, stem);

    const basePath = adapter.getFullPath('');
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

    const mdExists = await adapter.exists(outputPath);
    if (!mdExists) {
      const listing = await adapter.list(cacheDir);
      const candidate = listing.files.find(path => {
        const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
        return /\.md$/i.test(name) && !name.endsWith('.paged.md');
      });
      if (candidate) await adapter.rename(candidate, outputPath);
    }
    if (!(await adapter.exists(outputPath))) {
      throw new Error(`MinerU did not produce Markdown in ${cacheDir}.`);
    }

    const listing = await adapter.list(cacheDir);
    const jsonCandidate = listing.files.find(path => {
      const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
      return /\.json$/i.test(name) && name !== 'manifest.json';
    });
    if (jsonCandidate && !(await adapter.exists(jsonPath))) {
      await adapter.rename(jsonCandidate, jsonPath);
    }

    const sourceHash = await sha256Hex(await app.vault.readBinary(sourceFile));
    const manifest = {
      citekey: stem,
      source_pdf: sourcePath,
      source_sha256: sourceHash,
      source_bytes: sourceFile.stat.size,
      parser: PARSER,
      parser_version: 'cli',
      mode: 'precision',
      parameters: {
        file_sources: [sourcePath],
        output_dir: cacheDir,
        formats: ['md', 'json'],
        language: 'en',
        formula: true,
        table: true,
        ocr: false,
      },
      status: 'success',
      output: outputPath,
      json_output: (await adapter.exists(jsonPath)) ? jsonPath : undefined,
      images_dir: `${cacheDir}/images`,
      parsed_at: new Date().toISOString(),
    };
    await adapter.write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await waitForVaultFile(app, outputPath);
    await waitForVaultFile(app, manifestPath);
  };
}
