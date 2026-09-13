import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type App,TFile } from 'obsidian';

import {
  editFrontmatterFields,
  type PaperFieldEditPort,
  type PaperFieldEditRequest,
  type PaperFieldEditResult,
  paperFieldUpdates,
} from '../../../core/note/PaperFieldEdit';
import {
  appendToNoteText,
  type PaperNoteWritePort,
  type PaperNoteWriteRequest,
  type PaperNoteWriteResult,
} from '../../../core/note/PaperNoteWrite';
import { DEFAULT_APPEND_SECTION } from '../../../core/note/PaperNoteWrite';
import { buildSkipDirectoryParts, SKIP_NAME_PREFIXES } from './VaultPaperSearch';

/**
 * Vault-backed write capabilities, the successor of `kb.py append/status/classify`.
 *
 * Target resolution follows the old resolver so existing habits keep working:
 * an exact vault path wins, then the note name (with or without `.md`), then a
 * case-insensitive name substring — but unlike the old resolver, an ambiguous
 * match is *reported* in the result instead of only warned to stderr.
 *
 * Two safety rails are non-negotiable:
 *
 * 1. The note is written through `Vault#process`, so the patch always applies
 *    to the latest on-disk text and a concurrent edit is never clobbered.
 * 2. The pre-write text is copied to the vault-external `note-edit-backups`
 *    directory before the first write of the day, so every append and every
 *    frontmatter field edit is revertible without trusting the editor's undo
 *    stack.
 */

const BACKUP_DIRECTORY_NAME = 'note-edit-backups';

/** Tags a backup directory after the target note, like `kb.py` did. */
function backupSlug(tag: string): string {
  return tag.replace(/[^0-9A-Za-z\u4e00-\u9fff_-]+/gu, '-').slice(0, 40) || 'kb';
}

function formatDateStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The vault's own filesystem root, or null when it cannot be determined. */
function vaultRootPath(app: App): string | null {
  const adapter = (app.vault as { adapter?: { getFullPath?: (path: string) => string } }).adapter;
  try {
    const path = adapter?.getFullPath?.('');
    return typeof path === 'string' && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export interface VaultPaperNoteWriterOptions {
  readonly app: App;
  /** Injectable for tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

function normalizeRef(ref: string): string {
  // Strip wiki-link brackets the way the old resolver did, then unify slashes.
  return ref.trim().replace(/^\[+|\]+$/gu, '').replace(/\\/gu, '/');
}

function isMarkdownFile(file: TFile): boolean {
  return file.extension.toLocaleLowerCase() === 'md';
}

function isWritableTarget(path: string, skipParts: ReadonlySet<string>): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).some(part => skipParts.has(part))) return false;
  return !SKIP_NAME_PREFIXES.some(prefix => name.startsWith(prefix));
}

/** The note name matched against: last path segment without extension. */
function stemOf(ref: string): string {
  const last = ref.split('/').pop() ?? ref;
  return last.replace(/\.md$/iu, '');
}

function resolveTargetFile(app: App, ref: string): { file: TFile; alternates: readonly TFile[] } | null {
  const normalized = normalizeRef(ref);
  const withExtension = normalized.endsWith('.md') ? normalized : `${normalized}.md`;

  const direct = app.vault.getAbstractFileByPath(withExtension)
    ?? app.vault.getAbstractFileByPath(normalized);
  if (direct instanceof TFile) {
    return { file: direct, alternates: [] };
  }

  const skipParts = buildSkipDirectoryParts(app);
  const candidates = app.vault
    .getFiles()
    .filter(file => isMarkdownFile(file) && isWritableTarget(file.path, skipParts))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const stem = stemOf(normalized);
  const lowerStem = stem.toLowerCase();
  const byStem = candidates.filter(file => {
    const fileStem = file.name.replace(/\.md$/iu, '').toLowerCase();
    return fileStem === lowerStem || file.path.toLowerCase() === normalized.toLowerCase();
  });
  if (byStem.length > 0) {
    return { file: byStem[0], alternates: byStem.slice(1) };
  }

  const bySubstring = candidates.filter(file => file.name.toLowerCase().includes(lowerStem));
  if (bySubstring.length > 0) {
    return { file: bySubstring[0], alternates: bySubstring.slice(1, 6) };
  }
  return null;
}

/**
 * Copies the pre-write text to `<vault-parent>/note-edit-backups/<day>-<slug>/`,
 * skipping the copy when this run already produced one. Returns the backup
 * file's absolute path, or null when the vault root could not be determined —
 * a skipped backup is never silent: the tool's answer says so.
 */
async function backupNote(
  app: App,
  file: TFile,
  originalText: string,
  now: Date,
): Promise<string | null> {
  const root = vaultRootPath(app);
  if (!root) return null;
  const directory = join(dirname(root), BACKUP_DIRECTORY_NAME, `${formatDateStamp(now)}-${backupSlug(file.basename)}`);
  const destination = join(directory, file.name);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(destination, originalText, { encoding: 'utf-8', flag: 'wx' });
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return destination;
    // A failed backup must not fail the write, but must not be hidden either.
    return null;
  }
}

export function createVaultPaperNoteWriter(
  options: VaultPaperNoteWriterOptions,
): PaperNoteWritePort & PaperFieldEditPort {
  const { app } = options;
  const now = options.now ?? (() => new Date());

  return {
    async appendToNote(request: PaperNoteWriteRequest): Promise<PaperNoteWriteResult> {
      const resolved = resolveTargetFile(app, request.target);
      if (!resolved) {
        throw new Error(`找不到目标笔记：${request.target}`);
      }
      const { file } = resolved;
      const path = file.path;
      const link = `[[${path.replace(/\.md$/iu, '')}]]`;

      const original = await app.vault.read(file);
      const stampDate = now();
      const preview = appendToNoteText(original, request.content, {
        section: request.section ?? DEFAULT_APPEND_SECTION,
        now: stampDate,
        allowDuplicate: request.allowDuplicate,
      });

      if (preview.action === 'duplicate_skipped') {
        return { action: 'duplicate_skipped', link, location: preview.location, path };
      }

      const backupPath = await backupNote(app, file, original, stampDate);
      await app.vault.process(file, latest => appendToNoteText(latest, request.content, {
        section: request.section ?? DEFAULT_APPEND_SECTION,
        now: stampDate,
        allowDuplicate: request.allowDuplicate,
      }).text);

      return {
        action: 'appended',
        alternates: resolved.alternates.map(alternate => alternate.path),
        backupPath: backupPath ?? undefined,
        link,
        location: preview.location,
        path,
      };
    },

    async setPaperFields(request: PaperFieldEditRequest): Promise<PaperFieldEditResult> {
      // Validates again so a port can never receive a value the retired
      // `kb.py status/classify` commands would have rejected.
      const updates = paperFieldUpdates(request);

      const resolved = resolveTargetFile(app, request.target);
      if (!resolved) {
        throw new Error(`找不到目标笔记：${request.target}`);
      }
      const { file } = resolved;
      const path = file.path;
      const link = `[[${path.replace(/\.md$/iu, '')}]]`;

      const original = await app.vault.read(file);
      const preview = editFrontmatterFields(original, updates);

      if (preview.changed.length === 0) {
        return { action: 'unchanged', changed: [], link, path, unchanged: preview.unchanged };
      }

      const backupPath = await backupNote(app, file, original, now());
      await app.vault.process(file, latest => editFrontmatterFields(latest, updates).text);

      return {
        action: 'updated',
        alternates: resolved.alternates.map(alternate => alternate.path),
        backupPath: backupPath ?? undefined,
        changed: preview.changed,
        link,
        path,
        unchanged: preview.unchanged,
      };
    },
  };
}
