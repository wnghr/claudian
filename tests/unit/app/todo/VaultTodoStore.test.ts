import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type App, TFile } from 'obsidian';

import { createVaultTodoService } from '@/app/todo/VaultTodoStore';

describe('vault TODO storage', () => {
  it('persists multiple changes and undo when Obsidian rename refuses existing destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudian-todo-'));
    const file = new TFile();
    file.path = '任务/TODO.md';
    let text = '## 任务清单\n- [ ] Read\n';
    const original = text;
    const app = { vault: {
      getAbstractFileByPath: () => file,
      read: async () => text,
      process: async (_file: TFile, update: (text: string) => string) => { text = update(text); },
      adapter: {
        getFullPath: (path: string) => join(root, path),
        exists: async (path: string) => existsSync(join(root, path)),
        read: (path: string) => readFile(join(root, path), 'utf8'),
        write: (path: string, value: string) => writeFile(join(root, path), value),
        mkdir: (path: string) => mkdir(join(root, path), { recursive: true }),
        rename: async (from: string, to: string) => {
          if (existsSync(join(root, to))) throw new Error('Destination file already exists!');
          await rename(join(root, from), join(root, to));
        },
      },
    } } as unknown as App;
    try {
      const first = createVaultTodoService(app);
      const before = await first.readTodos({});
      const changed = await first.changeTodos({ revision: before.revision, summary: 'Add', operations: [{ op: 'add', task: { content: 'Practice' } }] });
      const reopened = createVaultTodoService(app);
      await reopened.undoTodos({ revision: changed.revision });
      expect(text).toBe(original);
    } finally {
      if (root.startsWith(join(tmpdir(), 'claudian-todo-'))) await rm(root, { recursive: true, force: true });
    }
  });
});
