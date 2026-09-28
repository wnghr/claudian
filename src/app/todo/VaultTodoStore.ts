import { rename, writeFile } from 'node:fs/promises';

import { type App, TFile } from 'obsidian';

import { TodoService } from '../../core/note/TodoService';
import { TODO_NOTE_PATH } from '../../core/note/WriteTodoTool';

const HISTORY_PATH = '.claudian/todo-history.json';

export function createVaultTodoService(app: App): TodoService {
  const file = () => {
    const target = app.vault.getAbstractFileByPath(TODO_NOTE_PATH);
    if (!(target instanceof TFile)) throw new Error('找不到任务/TODO.md，请先建立统一任务清单。');
    return target;
  };
  return new TodoService({
    read: () => app.vault.read(file()),
    compareAndSwap: async (before, after) => {
      await app.vault.process(file(), current => {
        if (current !== before) throw new Error('TODO 已有变化，请重新读取后调整。');
        return after;
      });
    },
    readHistory: async () => await app.vault.adapter.exists(HISTORY_PATH) ? app.vault.adapter.read(HISTORY_PATH) : '',
    writeHistory: async value => {
      const adapter = app.vault.adapter as typeof app.vault.adapter & { getFullPath?: (path: string) => string };
      if (!adapter.getFullPath) throw new Error('TODO 撤销记录需要本地文件系统。');
      if (!await app.vault.adapter.exists('.claudian')) await app.vault.adapter.mkdir('.claudian');
      const target = adapter.getFullPath(HISTORY_PATH);
      // Obsidian's adapter.rename refuses replacement. Node rename is atomic on the local filesystem.
      await writeFile(`${target}.tmp`, value, 'utf8');
      await rename(`${target}.tmp`, target);
    },
  });
}
