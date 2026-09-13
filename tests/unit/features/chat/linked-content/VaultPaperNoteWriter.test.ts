import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from 'obsidian';
import { TFile } from 'obsidian';

import { createVaultPaperNoteWriter } from '@/features/chat/linked-content/VaultPaperNoteWriter';

const CARD_PATH = '论文/卡片/Light-driven dancing.md';
const TWIN_PATH = '科研笔记/两个同名.md';
const TWIN_PATH_2 = '科研笔记/更深/两个同名.md';

const CARD_TEXT = [
  '---',
  'title: Light-driven dancing of nematic colloids',
  'id: citeX',
  'status: unread',
  '---',
  '',
  '## 讨论与理解',
  '',
  '已有分析。',
  '',
].join('\n');

function makeFile(path: string): TFile {
  const file = new TFile();
  const mutable = file as unknown as {
    basename: string;
    extension: string;
    name: string;
    path: string;
    stat: { ctime: number; mtime: number; size: number };
  };
  const name = path.split('/').pop() ?? path;
  mutable.path = path;
  mutable.name = name;
  mutable.basename = name.replace(/\.md$/iu, '');
  mutable.extension = path.split('.').pop()?.toLocaleLowerCase() ?? '';
  mutable.stat = { ctime: 0, mtime: 0, size: 0 };
  return file;
}

describe('createVaultPaperNoteWriter', () => {
  let vaultRoot: string;
  let vaultPath: string;
  let content: Record<string, string>;
  let processCalls: number;

  const buildApp = (): App => {
    const files = Object.keys(content).map(makeFile);
    return {
      vault: {
        getAbstractFileByPath: (path: string) =>
          files.find(file => file.path === path) ?? null,
        getFiles: () => files,
        process: jest.fn(async (file: TFile, fn: (text: string) => string) => {
          processCalls += 1;
          const next = fn(content[file.path]);
          content[file.path] = next;
          return next;
        }),
        read: jest.fn(async (file: TFile) => content[file.path]),
        adapter: { getFullPath: jest.fn(() => vaultPath) },
      },
    } as unknown as App;
  };

  beforeEach(async () => {
    // The vault itself is nested inside the temp dir: backups land next to the
    // vault root (`<parent>/note-edit-backups`), so per-test isolation has to
    // come from the temp dir being the *parent*, not the vault.
    vaultRoot = await mkdtemp(join(tmpdir(), 'claudian-note-writer-'));
    vaultPath = join(vaultRoot, 'vault');
    content = { [CARD_PATH]: CARD_TEXT };
    processCalls = 0;
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('appends under the section, writes through Vault#process, and takes a backup', async () => {
    const app = buildApp();
    const writer = createVaultPaperNoteWriter({ app, now: () => new Date(2026, 8, 13, 18, 30, 0) });

    const result = await writer.appendToNote({
      content: '界面锚定也参与其中。',
      target: CARD_PATH,
    });

    expect(result.action).toBe('appended');
    expect(result.path).toBe(CARD_PATH);
    expect(result.link).toBe('[[论文/卡片/Light-driven dancing]]');
    expect(result.location).toContain('讨论与理解');
    expect(result.backupPath).toContain('note-edit-backups');
    expect(result.backupPath).toContain('Light-driven dancing.md');
    expect(processCalls).toBe(1);

    const updated = content[CARD_PATH];
    expect(updated).toContain('---\ntitle: Light-driven dancing of nematic colloids');
    expect(updated).toContain('<!-- kb:20260913-183000 -->\n界面锚定也参与其中。');
    expect(updated.indexOf('界面锚定')).toBeGreaterThan(updated.indexOf('已有分析。'));

    // The backup holds the pre-write text.
    const backup = await readFile(result.backupPath ?? '', 'utf-8');
    expect(backup).toBe(CARD_TEXT);
  });

  it('resolves a note by bare name and reports ambiguous matches', async () => {
    content = {
      [TWIN_PATH]: '# one\n',
      [TWIN_PATH_2]: '# two\n',
    };
    const app = buildApp();
    const writer = createVaultPaperNoteWriter({ app });

    const result = await writer.appendToNote({
      content: '写进同名笔记之一。',
      target: '两个同名',
    });

    expect(result.path).toBe(TWIN_PATH);
    expect(result.alternates).toEqual([TWIN_PATH_2]);
  });

  it('skips a duplicate without touching the file and without a backup', async () => {
    const app = buildApp();
    const writer = createVaultPaperNoteWriter({ app });

    const result = await writer.appendToNote({
      content: '已有分析。',
      target: CARD_PATH,
    });

    expect(result.action).toBe('duplicate_skipped');
    expect(processCalls).toBe(0);
    expect(result.backupPath).toBeUndefined();

    const forced = await writer.appendToNote({
      allowDuplicate: true,
      content: '已有分析。',
      target: CARD_PATH,
    });
    expect(forced.action).toBe('appended');
    expect(processCalls).toBe(1);
  });

  it('rejects an unknown target instead of guessing', async () => {
    const app = buildApp();
    const writer = createVaultPaperNoteWriter({ app });

    await expect(writer.appendToNote({
      content: '无处可写。',
      target: '不存在的笔记',
    })).rejects.toThrow('找不到目标笔记');
  });

  it('updates card fields through Vault#process with a backup', async () => {
    const app = buildApp();
    const writer = createVaultPaperNoteWriter({ app });

    const result = await writer.setPaperFields({
      domain: '液晶与软物质',
      status: 'read',
      target: CARD_PATH,
    });

    expect(result.action).toBe('updated');
    expect(result.path).toBe(CARD_PATH);
    // Whitelist order is fixed: status, then domain, then subfield.
    expect(result.changed).toEqual([
      { from: 'unread', key: 'status', to: 'read' },
      { from: null, key: 'domain', to: '液晶与软物质' },
    ]);
    expect(processCalls).toBe(1);
    expect(result.backupPath).toContain('note-edit-backups');

    const updated = content[CARD_PATH];
    expect(updated).toContain('status: read');
    expect(updated).toContain('domain: 液晶与软物质');
    expect(updated).toContain('id: citeX');

    const backup = await readFile(result.backupPath ?? '', 'utf-8');
    expect(backup).toBe(CARD_TEXT);
  });

  it('reports an unchanged field set without touching the file', async () => {
    const app = buildApp();
    const writer = createVaultPaperNoteWriter({ app });

    const result = await writer.setPaperFields({ status: 'unread', target: CARD_PATH });

    expect(result.action).toBe('unchanged');
    expect(result.unchanged).toEqual(['status']);
    expect(processCalls).toBe(0);
    expect(result.backupPath).toBeUndefined();
  });

  it('rejects a status value the retired CLI would have rejected', async () => {
    const app = buildApp();
    const writer = createVaultPaperNoteWriter({ app });

    await expect(writer.setPaperFields({ status: 'skimmed', target: CARD_PATH }))
      .rejects.toThrow('status 只能是 unread, reading, read, cited');
    expect(processCalls).toBe(0);
  });

  it('reports ambiguous card matches without guessing silently', async () => {
    content = {
      [TWIN_PATH]: '---\nstatus: unread\n---\n',
      [TWIN_PATH_2]: '---\nstatus: unread\n---\n',
    };
    const app = buildApp();
    const writer = createVaultPaperNoteWriter({ app });

    const result = await writer.setPaperFields({ status: 'reading', target: '两个同名' });

    expect(result.path).toBe(TWIN_PATH);
    expect(result.alternates).toEqual([TWIN_PATH_2]);
  });
});
