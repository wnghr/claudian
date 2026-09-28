import { applyTodoOperations, readTodoDocument, type TodoOperation, type TodoSnapshot, type TodoStatus } from './TodoDocument';

export interface TodoQuery { query?: string; project?: string; status?: TodoStatus | 'all' }
export interface TodoChange { revision: string; summary: string; operations: TodoOperation[] }
export interface TodoUndo { revision: string }
export interface TodoResult extends TodoSnapshot { summary?: string; undoAvailable: boolean }
export interface TodoPort {
  readTodos(query: TodoQuery): Promise<TodoResult>;
  changeTodos(change: TodoChange): Promise<TodoResult>;
  undoTodos(request: TodoUndo): Promise<TodoResult>;
}
export interface TodoStorage {
  read(): Promise<string>;
  compareAndSwap(before: string, after: string): Promise<void>;
  readHistory(): Promise<string>;
  writeHistory(value: string): Promise<void>;
}
interface Entry { before: string; after: string; summary: string }
interface Journal { version: 1; stack: Entry[]; pending?: { before: string; after: string; nextStack: Entry[] } }

/** The Markdown file is authoritative; the journal contains only undo snapshots. */
export class TodoService implements TodoPort {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: TodoStorage) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async history(current: string): Promise<Journal> {
    const raw = await this.storage.readHistory();
    if (!raw) return { version: 1, stack: [] };
    const journal = JSON.parse(raw) as Journal;
    if (journal.version !== 1 || !Array.isArray(journal.stack)) throw new Error('TODO 撤销记录格式无效。');
    if (journal.pending) {
      // Recover a committed write even if recording its completion was interrupted.
      if (current === journal.pending.after) journal.stack = journal.pending.nextStack;
      else if (current !== journal.pending.before) journal.stack = [];
      delete journal.pending;
    }
    return journal;
  }

  private result(text: string, journal: Journal, summary?: string): TodoResult {
    return { ...readTodoDocument(text), summary, undoAvailable: journal.stack.at(-1)?.after === text };
  }

  readTodos(query: TodoQuery): Promise<TodoResult> {
    return this.serial(async () => {
      const text = await this.storage.read();
      const result = this.result(text, await this.history(text));
      const words = query.query?.toLocaleLowerCase().split(/\s+/u).filter(Boolean) ?? [];
      result.tasks = result.tasks.filter(task =>
        (query.project === undefined || (task.project ?? '') === query.project)
        && (!query.status || query.status === 'all' || task.status === query.status)
        && words.every(word => `${task.content}\n${task.details}`.toLocaleLowerCase().includes(word)));
      return result;
    });
  }

  private async commit(before: string, after: string, journal: Journal, nextStack: Entry[], summary: string): Promise<TodoResult> {
    // Persist the preimage before touching the file. Vault.process checks it again.
    await this.storage.writeHistory(JSON.stringify({ ...journal, pending: { before, after, nextStack } }));
    await this.storage.compareAndSwap(before, after);
    const committed: Journal = { version: 1, stack: nextStack };
    try { await this.storage.writeHistory(JSON.stringify(committed)); } catch {
      // The durable pending record is sufficient for recovery; the write succeeded.
    }
    return this.result(after, committed, summary);
  }

  changeTodos(change: TodoChange): Promise<TodoResult> {
    return this.serial(async () => {
      const before = await this.storage.read();
      if (readTodoDocument(before).revision !== change.revision) throw new Error('TODO 已有变化，请重新读取后调整。');
      const after = applyTodoOperations(before, change.operations);
      const journal = await this.history(before);
      if (after === before) return this.result(before, journal, '没有需要修改的内容。');
      const stack = journal.stack.at(-1)?.after === before ? journal.stack : [];
      return this.commit(before, after, journal, [...stack, { before, after, summary: change.summary }].slice(-30), change.summary);
    });
  }

  undoTodos(request: TodoUndo): Promise<TodoResult> {
    return this.serial(async () => {
      const current = await this.storage.read();
      if (readTodoDocument(current).revision !== request.revision) throw new Error('TODO 已有变化，请重新读取后撤销。');
      const journal = await this.history(current);
      const entry = journal.stack.at(-1);
      if (!entry) throw new Error('没有可以撤销的聊天调整。');
      if (entry.after !== current) throw new Error('TODO 随后已有变化，不能覆盖这些修改；请根据当前清单调整。');
      return this.commit(current, entry.before, journal, journal.stack.slice(0, -1), `已撤销：${entry.summary}`);
    });
  }
}
